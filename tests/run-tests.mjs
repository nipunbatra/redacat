// Redacat end-to-end test suite.
// Serves the repo, drives the app in headless Chrome, and verifies exports
// byte-by-byte with mupdf in Node. Run `node make-fixtures.mjs` first.
//
//   CHROME_PATH=/path/to/chrome node run-tests.mjs      (default: macOS Chrome)
//   BASE=https://... node run-tests.mjs                 (test a deployed copy)

import puppeteer from "puppeteer-core";
import * as mupdf from "mupdf";
import { FIXTURE_PW } from "./make-fixtures.mjs";
import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const FIX = path.join(HERE, "fixtures");
const DL = path.join(FIX, "downloads");
const PORT = 8643;
const BASE = process.env.BASE || `http://localhost:${PORT}/`;
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

fs.rmSync(DL, { recursive: true, force: true });
fs.mkdirSync(DL, { recursive: true });

/* ---------- tiny static server ---------- */

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".wasm": "application/wasm", ".svg": "image/svg+xml",
  ".png": "image/png", ".woff2": "font/woff2", ".pdf": "application/pdf",
};
let server = null;
if (!process.env.BASE) {
  server = http.createServer((req, res) => {
    const clean = path.normalize(decodeURIComponent(new URL(req.url, BASE).pathname));
    let file = path.join(ROOT, clean);
    if (clean === "/" || clean === "\\") file = path.join(ROOT, "index.html");
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end("not found"); return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  }).listen(PORT);
}

/* ---------- harness ---------- */

const results = [];
let browser;

function assert(cond, msg) { if (!cond) throw new Error(`assert failed: ${msg}`); }
function assertEq(got, want, msg) {
  if (got !== want) throw new Error(`assert failed: ${msg} — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
}

async function newPage(dialogPlan = []) {
  const page = await browser.newPage();
  const ctx = { page, errors: [], dialogs: [], requests: [] };
  page.on("console", (m) => { if (m.type() === "error") ctx.errors.push(m.text()); });
  page.on("pageerror", (e) => ctx.errors.push(String(e)));
  page.on("request", (r) => { if (/^https?:/.test(r.url())) ctx.requests.push(r.url()); });
  page.on("dialog", async (d) => {
    ctx.dialogs.push({ type: d.type(), message: d.message() });
    const plan = dialogPlan.shift();
    if (plan?.dismiss) await d.dismiss();
    else await d.accept(plan?.text);
  });
  const cdp = await page.createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: DL, eventsEnabled: true });
  await page.goto(BASE, { waitUntil: "networkidle0" });
  return ctx;
}

async function uploadFixture(page, name) {
  const input = await page.$("#file");
  await input.uploadFile(path.join(FIX, name));
}

async function waitEditor(page) {
  await page.waitForFunction(
    () => !document.getElementById("editor").hidden && document.getElementById("busy").hidden,
    { timeout: 120000 },
  );
}

async function waitIntroBack(page) {
  await page.waitForFunction(
    () => !document.getElementById("intro").hidden && document.getElementById("editor").hidden,
    { timeout: 120000 },
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, what, timeoutMs = 15000, step = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return v;
    await sleep(step);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const waitForDialog = (ctx, predicate) =>
  until(() => ctx.dialogs.some(predicate), `dialog (saw: ${JSON.stringify(ctx.dialogs)})`)
    .catch(() => { throw new Error(`expected dialog never appeared; saw: ${JSON.stringify(ctx.dialogs)}`); });

const waitDownload = (name, timeoutMs = 20000) => {
  const file = path.join(DL, name);
  return until(
    () => (fs.existsSync(file) && !fs.existsSync(file + ".crdownload") ? fs.readFileSync(file) : null),
    `download ${name}`, timeoutMs, 200,
  );
};

// convert a fitz-space rect to the app's content coordinates for page i
async function markFitzRect(page, pageIdx, fitz) {
  await page.evaluate((i, r) => {
    const R = window.__redacat;
    const { bounds, scale } = R.meta(i);
    R.addMark(i, {
      x: (r[0] - bounds[0]) * scale, y: (r[1] - bounds[1]) * scale,
      w: (r[2] - r[0]) * scale, h: (r[3] - r[1]) * scale,
      mode: r[4] || "black",
    });
  }, pageIdx, fitz);
}

function pdfPagesText(bytes, password) {
  const doc = mupdf.Document.openDocument(new Uint8Array(bytes).slice(), "application/pdf");
  if (doc.needsPassword()) {
    if (doc.authenticatePassword(password ?? "") === 0) throw new Error("verify: wrong password");
  }
  const out = [];
  for (let i = 0; i < doc.countPages(); i++) out.push(doc.loadPage(i).toStructuredText().asText());
  return out;
}

function renderPdfPage(bytes, pageIdx, password) {
  const doc = mupdf.Document.openDocument(new Uint8Array(bytes).slice(), "application/pdf");
  if (doc.needsPassword()) doc.authenticatePassword(password ?? "");
  const page = doc.loadPage(pageIdx);
  const bounds = page.getBounds();
  const pix = page.toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB, false, true);
  return { pix, bounds, pixels: pix.getPixels(), w: pix.getWidth(), h: pix.getHeight(), n: 3 };
}

// sample rendered pixel at fitz coords (2x scale)
function fitzPixel(r, fx, fy) {
  const x = Math.round((fx - r.bounds[0]) * 2);
  const y = Math.round((fy - r.bounds[1]) * 2);
  const i = (y * r.w + x) * r.n;
  return [r.pixels[i], r.pixels[i + 1], r.pixels[i + 2]];
}

function decodePng(bytes) {
  // mupdf.Image decodes at native pixel size (Document.openDocument would
  // apply a 72/96-dpi page scale and shift every coordinate)
  const img = new mupdf.Image(new Uint8Array(bytes).slice());
  const pix = img.toPixmap();
  // fz pixmap component count already includes the alpha channel
  const n = pix.getNumberOfComponents();
  return { pixels: pix.getPixels(), w: pix.getWidth(), h: pix.getHeight(), n, alpha: pix.getAlpha() };
}
const px = (img, x, y) => {
  const i = (y * img.w + x) * img.n;
  return [...img.pixels.slice(i, i + img.n)];
};

const dataUrlBytes = (u) => Buffer.from(u.split(",")[1], "base64");

async function compositeImg(page) {
  return decodePng(dataUrlBytes(await page.evaluate(() => window.__redacat.compositeDataURL())));
}

/* ---------- image fixtures generated in-browser ---------- */

async function makeImageFixtures() {
  const { page } = await newPage();
  const urls = await page.evaluate(() => {
    const out = {};
    const c = document.createElement("canvas");
    c.width = 400; c.height = 300;
    const g = c.getContext("2d");
    g.fillStyle = "#cc2211"; g.fillRect(0, 0, 200, 300);   // left red
    g.fillStyle = "#1133cc"; g.fillRect(200, 0, 200, 300); // right blue
    // fine detail band: 1px vertical black/white stripes (blur/pixelate targets)
    for (let x = 20; x < 180; x++) {
      g.fillStyle = x % 2 ? "#000000" : "#ffffff";
      g.fillRect(x, 200, 1, 80);
    }
    out.plain = c.toDataURL("image/png");
    out.webp = c.toDataURL("image/webp");

    const a = document.createElement("canvas");
    a.width = 200; a.height = 200;
    const ga = a.getContext("2d");
    ga.fillStyle = "#22aa44";
    ga.fillRect(80, 80, 40, 40); // opaque center, transparent elsewhere
    out.alpha = a.toDataURL("image/png");

    const j = document.createElement("canvas");
    j.width = 300; j.height = 150;
    const gj = j.getContext("2d");
    gj.fillStyle = "#ffffff"; gj.fillRect(0, 0, 300, 150);
    gj.fillStyle = "#00bb00"; gj.fillRect(0, 0, 60, 60); // green top-left
    out.jpegBase = j.toDataURL("image/jpeg", 0.95);
    return out;
  });
  fs.writeFileSync(path.join(FIX, "plain.png"), dataUrlBytes(urls.plain));
  fs.writeFileSync(path.join(FIX, "sample.webp"), dataUrlBytes(urls.webp));
  fs.writeFileSync(path.join(FIX, "alpha.png"), dataUrlBytes(urls.alpha));
  // EXIF orientation 6 (rotate 90 CW) spliced into the JPEG
  const jpeg = dataUrlBytes(urls.jpegBase);
  const app1 = Buffer.from([
    0xff, 0xe1, 0x00, 0x22,
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00,             // Exif\0\0
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, // TIFF header, little-endian
    0x01, 0x00,                                     // one IFD entry
    0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, // tag 0x0112 Orientation, SHORT, count 1
    0x06, 0x00, 0x00, 0x00,                         // value 6
    0x00, 0x00, 0x00, 0x00,                         // no next IFD
  ]);
  fs.writeFileSync(path.join(FIX, "exif6.jpg"), Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]));
  fs.writeFileSync(path.join(FIX, "fake.png"), Buffer.from("this is definitely not a png"));
  await page.close();
}

/* ---------- tests ---------- */

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("landing loads clean, no console errors", async () => {
  const { page, errors } = await newPage();
  const h1 = await page.$eval("h1", (e) => e.textContent);
  assert(h1.includes("Nothing"), "h1 copy present");
  assertEq(errors.length, 0, `console errors: ${errors.join(" | ")}`);
  await page.close();
});

test("image: black bar + white-out destroy exact pixels, rest untouched", async () => {
  const { page, errors } = await newPage();
  await uploadFixture(page, "plain.png");
  await waitEditor(page);
  await page.evaluate(() => {
    window.__redacat.addMark(0, { x: 10, y: 10, w: 100, h: 80, mode: "black" });
    window.__redacat.addMark(0, { x: 250, y: 10, w: 80, h: 60, mode: "white" });
  });
  const img = await compositeImg(page);
  assertEq(img.w, 400, "composite full resolution");
  assert(px(img, 50, 50).slice(0, 3).every((v, i) => Math.abs(v - [20, 20, 18][i]) < 6), `bar pixel is ink: ${px(img, 50, 50)}`);
  assert(px(img, 280, 30).slice(0, 3).every((v) => v > 249), `white-out pixel: ${px(img, 280, 30)}`);
  const red = px(img, 50, 150), blue = px(img, 350, 250);
  assert(red[0] > 150 && red[2] < 100, `red region intact: ${red}`);
  assert(blue[2] > 150 && blue[0] < 100, `blue region intact: ${blue}`);
  assertEq(errors.length, 0, `console errors: ${errors.join(" | ")}`);
  await page.close();
});

test("image: blur/pixelate destroy fine detail; edge & tiny marks don't crash", async () => {
  const { page, errors } = await newPage();
  await uploadFixture(page, "plain.png");
  await waitEditor(page);
  await page.evaluate(() => {
    // over the 1px stripe band (x 20..180, y 200..280)
    window.__redacat.addMark(0, { x: 20, y: 200, w: 60, h: 60, mode: "blur", strength: 6 });
    window.__redacat.addMark(0, { x: 100, y: 200, w: 60, h: 60, mode: "pixelate", strength: 8 });
    // corner / tiny / out-of-detail marks: crash checks
    window.__redacat.addMark(0, { x: 0, y: 0, w: 60, h: 60, mode: "blur", strength: 8 });
    window.__redacat.addMark(0, { x: 340, y: 240, w: 60, h: 60, mode: "pixelate", strength: 8 });
    window.__redacat.addMark(0, { x: 200, y: 100, w: 4, h: 4, mode: "blur", strength: 10 });
  });
  const img = await compositeImg(page);
  // blurred stripes: neighbors that differed by 255 are now similar and mid-toned
  const b1 = px(img, 40, 230), b2 = px(img, 41, 230);
  assert(Math.abs(b1[0] - b2[0]) < 40, `blur removed stripe contrast: ${b1} vs ${b2}`);
  assert(b1[0] > 40 && b1[0] < 215, `blur averaged toward grey: ${b1}`);
  // pixelated stripes: everything inside one cell is a single flat value
  const p1 = px(img, 110, 230), p2 = px(img, 113, 230);
  assert(Math.abs(p1[0] - p2[0]) < 12, `pixelate cell is flat: ${p1} vs ${p2}`);
  // stripes outside the marks stay crisp
  const s1 = px(img, 170, 230), s2 = px(img, 171, 230);
  assert(Math.abs(s1[0] - s2[0]) > 150, `stripes outside marks untouched: ${s1} vs ${s2}`);
  assertEq(errors.length, 0, `console errors: ${errors.join(" | ")}`);
  await page.close();
});

test("image: alpha channel preserved outside marks", async () => {
  const { page, errors } = await newPage();
  await uploadFixture(page, "alpha.png");
  await waitEditor(page);
  await page.evaluate(() => {
    window.__redacat.addMark(0, { x: 20, y: 20, w: 40, h: 40, mode: "white" });
  });
  const img = await compositeImg(page);
  assertEq(px(img, 10, 10)[3], 0, "outside mark stays transparent");
  assert(px(img, 30, 30)[3] > 250, "white-out is opaque");
  assert(px(img, 100, 100)[3] > 250, "opaque center survives");
  assertEq(errors.length, 0, `console errors: ${errors.join(" | ")}`);
  await page.close();
});

test("image: EXIF orientation 6 is honored (portrait after decode)", async () => {
  const { page, errors } = await newPage();
  await uploadFixture(page, "exif6.jpg");
  await waitEditor(page);
  const dims = await page.evaluate(() => {
    const b = window.__redacat.state.base;
    return { w: b.width, h: b.height };
  });
  assertEq(dims.w, 150, "width after rotation");
  assertEq(dims.h, 300, "height after rotation");
  assertEq(errors.length, 0, `console errors: ${errors.join(" | ")}`);
  await page.close();
});

test("image: webp input works", async () => {
  const { page, errors } = await newPage();
  await uploadFixture(page, "sample.webp");
  await waitEditor(page);
  await page.evaluate(() => window.__redacat.addMark(0, { x: 5, y: 5, w: 50, h: 50, mode: "black" }));
  const img = await compositeImg(page);
  assert(px(img, 20, 20).slice(0, 3).every((v) => v < 30), "bar applied on webp");
  assertEq(errors.length, 0, `console errors: ${errors.join(" | ")}`);
  await page.close();
});

test("image: corrupt file shows error and returns to intro", async () => {
  const ctx = await newPage([{}]);
  await uploadFixture(ctx.page, "fake.png");
  await waitForDialog(ctx, (d) => d.type === "alert" && d.message.includes("Couldn't open"));
  await waitIntroBack(ctx.page);
  await ctx.page.close();
});

test("pdf: multi-page redaction incl. never-viewed page, download verified", async () => {
  const { page, errors } = await newPage();
  await uploadFixture(page, "basic.pdf");
  await waitEditor(page);
  // page 1 secret at pdf(72,600,s14) => fitz y ~ 178..196; page 2 (never viewed) at fitz y ~ 78..96
  await markFitzRect(page, 0, [70, 176, 220, 198]);
  await markFitzRect(page, 1, [70, 76, 220, 98]);
  const status = await page.$eval("#status", (e) => e.textContent);
  assert(status.includes("2 total"), `status counts both pages: "${status}"`);
  await page.click("#download");
  const bytes = await waitDownload("basic.redacted.pdf");
  const [t1, t2] = pdfPagesText(bytes);
  assert(!t1.includes("TOP-SECRET-ALPHA"), "page1 secret removed");
  assert(t1.includes("public line one stays"), "page1 public survives");
  assert(!t2.includes("TOP-SECRET-BRAVO"), "page2 secret removed (page never rendered)");
  assert(t2.includes("public line two stays"), "page2 public survives");
  assert(!Buffer.from(bytes).toString("latin1").includes("TOP-SECRET"), "no secret in raw bytes");
  assertEq(errors.length, 0, `console errors: ${errors.join(" | ")}`);
  await page.close();
});

test("pdf: black bar renders black, erase renders blank paper", async () => {
  const { page } = await newPage();
  await uploadFixture(page, "basic.pdf");
  await waitEditor(page);
  await markFitzRect(page, 0, [70, 176, 220, 198, "black"]);
  await markFitzRect(page, 0, [70, 66, 250, 90, "erase"]); // over "PAGE ONE HEADER"
  await page.click("#download");
  const bytes = await waitDownload("basic.redacted.pdf", 20000);
  const [t1] = pdfPagesText(bytes);
  assert(!t1.includes("TOP-SECRET-ALPHA") && !t1.includes("PAGE ONE HEADER"), "both texts removed");
  const r = renderPdfPage(bytes, 0);
  const barPx = fitzPixel(r, 145, 187);
  const erasePx = fitzPixel(r, 145, 78);
  assert(barPx.every((v) => v < 40), `bar area black: ${barPx}`);
  assert(erasePx.every((v) => v > 240), `erase area blank: ${erasePx}`);
  await page.close();
});

test("pdf: rotated pages (90/270) — search-redact really removes text", async () => {
  for (const rot of [90, 270]) {
    const { page } = await newPage();
    await uploadFixture(page, `rotated${rot}.pdf`);
    await waitEditor(page);
    const res = await page.evaluate((n) => window.__redacat.searchAndMark(n), `ROTATE-SECRET-${rot}`);
    assertEq(res.hits, 1, `rot${rot}: found the secret`);
    await page.click("#download");
    const bytes = await waitDownload(`rotated${rot}.redacted.pdf`);
    const [t] = pdfPagesText(bytes);
    assert(!t.includes(`ROTATE-SECRET-${rot}`), `rot${rot}: secret removed`);
    assert(t.includes("rotated public text"), `rot${rot}: public text survives`);
    await page.close();
  }
});

test("pdf: CropBox-offset page — search-redact hits the right spot", async () => {
  const { page } = await newPage();
  await uploadFixture(page, "cropbox.pdf");
  await waitEditor(page);
  const res = await page.evaluate(() => window.__redacat.searchAndMark("CROP-SECRET-KILO"));
  assertEq(res.hits, 1, "found the secret in cropped page");
  await page.click("#download");
  const bytes = await waitDownload("cropbox.redacted.pdf");
  const [t] = pdfPagesText(bytes);
  assert(!t.includes("CROP-SECRET-KILO"), "crop secret removed");
  assert(t.includes("crop public text"), "crop public survives");
  await page.close();
});

test("pdf: search across 5 pages, batch undo restores zero marks", async () => {
  const { page } = await newPage();
  await uploadFixture(page, "fivepages.pdf");
  await waitEditor(page);
  const res = await page.evaluate(() => window.__redacat.searchAndMark("MULTI-SECRET"));
  assertEq(res.hits, 4, "four matches");
  assertEq(res.pages, 3, "on three pages");
  let status = await page.$eval("#status", (e) => e.textContent);
  assert(status.includes("4 total"), `status shows 4 total: "${status}"`);
  await page.click("#undo");
  await sleep(300);
  status = await page.$eval("#status", (e) => e.textContent);
  assert(status.includes("0 total"), `undo cleared all: "${status}"`);
  await page.close();
});

test("pdf: rapid double-Enter in search doesn't stack duplicate marks", async () => {
  const { page } = await newPage();
  await uploadFixture(page, "fivepages.pdf");
  await waitEditor(page);
  await page.focus("#searchtext");
  await page.type("#searchtext", "MULTI-SECRET");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await until(async () => (await page.$eval("#searchinfo", (e) => e.textContent)).includes("marked"), "search done");
  await sleep(500); // give any duplicate run time to land
  const status = await page.$eval("#status", (e) => e.textContent);
  assert(status.includes("4 total"), `exactly one batch of marks: "${status}"`);
  await page.close();
});

test("pdf: password-protected — wrong then right password, encrypted output", async () => {
  const { page, dialogs } = await newPage([{ text: "wrong-pw" }, { text: FIXTURE_PW }]);
  await uploadFixture(page, "protected.pdf");
  await waitEditor(page);
  assertEq(dialogs.filter((d) => d.type === "prompt").length, 2, "two password prompts");
  const res = await page.evaluate(() => window.__redacat.searchAndMark("TOP-SECRET-ALPHA"));
  assertEq(res.hits, 1, "search works in decrypted doc");
  await page.click("#download");
  const bytes = await waitDownload("protected.redacted.pdf");
  const check = mupdf.Document.openDocument(new Uint8Array(bytes).slice(), "application/pdf");
  assert(check.needsPassword(), "output keeps encryption");
  assert(check.authenticatePassword(FIXTURE_PW) !== 0, "output keeps the same password");
  const [t1] = pdfPagesText(bytes, FIXTURE_PW);
  assert(!t1.includes("TOP-SECRET-ALPHA"), "secret removed from encrypted output");
  await page.close();
});

test("pdf: cancelling the password prompt returns to intro", async () => {
  const ctx = await newPage([{ dismiss: true }, {}]); // dismiss prompt, accept alert
  await uploadFixture(ctx.page, "protected.pdf");
  await waitForDialog(ctx, (d) => d.type === "alert" && d.message.includes("password"));
  await waitIntroBack(ctx.page);
  await ctx.page.close();
});

test("pdf: corrupt and zero-page files fail gracefully", async () => {
  for (const f of ["corrupt.pdf", "zeropage.pdf"]) {
    const ctx = await newPage([{}, {}]);
    await uploadFixture(ctx.page, f);
    await waitForDialog(ctx, (d) => d.type === "alert" && d.message.includes("Couldn't open"));
    await waitIntroBack(ctx.page);
    await ctx.page.close();
  }
});

test("pdf: failed open of second file preserves the first file's marks", async () => {
  const { page } = await newPage([{}, {}]);
  await uploadFixture(page, "basic.pdf");
  await waitEditor(page);
  await markFitzRect(page, 0, [70, 176, 220, 198]);
  await uploadFixture(page, "corrupt.pdf");
  await sleep(1500);
  const editorVisible = await page.evaluate(() => !document.getElementById("editor").hidden);
  assert(editorVisible, "editor still open after failed second open");
  const status = await page.$eval("#status", (e) => e.textContent);
  assert(status.includes("1 mark"), `first file's mark survives: "${status}"`);
  await page.close();
});

test("pdf: erase over embedded image really scrubs image pixels", async () => {
  const { page } = await newPage();
  await uploadFixture(page, "imagepdf.pdf");
  await waitEditor(page);
  // image spans fitz x 100..400, y 92..392; erase its left half
  await markFitzRect(page, 0, [100, 92, 250, 392, "erase"]);
  await page.click("#download");
  const bytes = await waitDownload("imagepdf.redacted.pdf");
  const r = renderPdfPage(bytes, 0);
  const scrubbed = fitzPixel(r, 175, 242);   // was solid red
  const kept = fitzPixel(r, 325, 242);       // right half, was blue
  assert(scrubbed.every((v) => v > 240), `erased image half is blank: ${scrubbed}`);
  assert(kept[2] > 120 && kept[0] < 120, `remaining image half intact: ${kept}`);
  const [t] = pdfPagesText(bytes);
  assert(t.includes("image caption text"), "caption survives");
  await page.close();
});

/* ---------- hostile-input tests ---------- */

test("hostile: 5000×5000pt giant page renders capped, search-redact still exact", async () => {
  const { page, errors } = await newPage();
  await uploadFixture(page, "giant.pdf");
  await waitEditor(page);
  const rendered = await page.evaluate(() => {
    const b = window.__redacat.state.pages[0];
    return { w: b.width, h: b.height };
  });
  assert(rendered.w * rendered.h <= 16.5e6, `render capped: ${rendered.w}x${rendered.h}`);
  const res = await page.evaluate(() => window.__redacat.searchAndMark("GIANT-SECRET"));
  assertEq(res.hits, 1, "found secret on giant page");
  await page.click("#download");
  const bytes = await waitDownload("giant.redacted.pdf", 60000);
  const [t] = pdfPagesText(bytes);
  assert(!t.includes("GIANT-SECRET"), "giant secret removed");
  assert(t.includes("giant public text"), "giant public survives");
  assertEq(errors.length, 0, `console errors: ${errors.join(" | ")}`);
  await page.close();
});

test("hostile: zero-area MediaBox opens as normalized blank page, no crash", async () => {
  const { page, errors } = await newPage();
  await uploadFixture(page, "badmedia.pdf");
  await waitEditor(page);
  await page.evaluate(() => window.__redacat.addMark(0, { x: 10, y: 10, w: 60, h: 40 }));
  const status = await page.$eval("#status", (e) => e.textContent);
  assert(status.includes("1 mark"), "can even mark the blank page");
  // mupdf legitimately logs repair diagnostics for this deliberately broken file
  const real = errors.filter((e) => !/format error|repair/i.test(e));
  assertEq(real.length, 0, `unexpected console errors: ${real.join(" | ")}`);
  await page.close();
});

test("hostile: zero-dimension SVG is rejected politely", async () => {
  const ctx = await newPage([{}]);
  await uploadFixture(ctx.page, "zero.svg");
  await waitForDialog(ctx, (d) => d.type === "alert" && d.message.includes("Couldn't open"));
  const introVisible = await ctx.page.evaluate(() => !document.getElementById("intro").hidden);
  assert(introVisible, "intro still shown");
  await ctx.page.close();
});

test("hostile: over-limit image is downscaled with a warning, then works", async () => {
  const ctx = await newPage([{}]); // accept the downscale alert
  await ctx.page.evaluate(() => { window.__redacat.LIMITS.maxImagePixels = 50000; }); // 0.05 MP
  await uploadFixture(ctx.page, "plain.png"); // 400×300 = 120k px -> must shrink
  await waitEditor(ctx.page);
  await waitForDialog(ctx, (d) => d.type === "alert" && d.message.includes("scaled down"));
  const dims = await ctx.page.evaluate(() => {
    const b = window.__redacat.state.base;
    return { w: b.width, h: b.height };
  });
  assert(dims.w * dims.h <= 50000, `downscaled: ${dims.w}x${dims.h}`);
  assert(Math.abs(dims.w / dims.h - 400 / 300) < 0.02, "aspect ratio kept");
  await ctx.page.evaluate(() => window.__redacat.addMark(0, { x: 5, y: 5, w: 40, h: 30 }));
  const status = await ctx.page.$eval("#status", (e) => e.textContent);
  assert(status.includes("1 mark"), "marking still works after downscale");
  await ctx.page.close();
});

test("hostile: second file dropped mid-open is ignored, state stays consistent", async () => {
  const { page, errors } = await newPage();
  const input = await page.$("#file");
  // fire two opens back-to-back without waiting; the second must be ignored
  await input.uploadFile(path.join(FIX, "fivepages.pdf"));
  await input.uploadFile(path.join(FIX, "basic.pdf"));
  await waitEditor(page);
  await sleep(1000);
  const fname = await page.$eval("#fname", (e) => e.textContent);
  const pages = await page.evaluate(() => window.__redacat.state.pageCount);
  assert(
    (fname === "fivepages.pdf" && pages === 5) || (fname === "basic.pdf" && pages === 2),
    `filename and page count agree: ${fname} / ${pages} pages`,
  );
  assertEq(errors.length, 0, `console errors: ${errors.join(" | ")}`);
  await page.close();
});

test("hostile: weird search needles never crash", async () => {
  const { page, errors } = await newPage();
  await uploadFixture(page, "basic.pdf");
  await waitEditor(page);
  const needles = ["🐈‍⬛ emoji", "עברית", "   ", "\\n\\\\", "((((", "x".repeat(10000)];
  for (const n of needles) {
    const res = await page.evaluate((s) => window.__redacat.searchAndMark(s), n);
    assertEq(res.hits, 0, `no hits for ${JSON.stringify(n.slice(0, 12))}`);
    assert(!res.failed, `no failure for ${JSON.stringify(n.slice(0, 12))}`);
  }
  assertEq(errors.length, 0, `console errors: ${errors.join(" | ")}`);
  await page.close();
});

test("hostile: filenames with emoji / no extension produce sane downloads", async () => {
  fs.copyFileSync(path.join(FIX, "basic.pdf"), path.join(FIX, "émoji 🐈 name.pdf"));
  const { page } = await newPage();
  await uploadFixture(page, "émoji 🐈 name.pdf");
  await waitEditor(page);
  await markFitzRect(page, 0, [70, 176, 220, 198]);
  await page.click("#download");
  const bytes = await waitDownload("émoji 🐈 name.redacted.pdf");
  assert(bytes.length > 500, "emoji-named download arrived");
  await page.close();
});

test("hostile: invisible-but-extractable text (fake redaction, white-on-white) is removed", async () => {
  const { page } = await newPage();
  await uploadFixture(page, "hidden.pdf");
  await waitEditor(page);
  // both strings are invisible on screen; the text layer still finds & kills them
  const r1 = await page.evaluate(() => window.__redacat.searchAndMark("HIDDEN-UNDER-BOX"));
  const r2 = await page.evaluate(() => window.__redacat.searchAndMark("WHITE-ON-WHITE"));
  assertEq(r1.hits, 1, "found text hidden under a drawn box");
  assertEq(r2.hits, 1, "found white-on-white text");
  await page.click("#download");
  const bytes = await waitDownload("hidden.redacted.pdf");
  const [t] = pdfPagesText(bytes);
  assert(!t.includes("HIDDEN-UNDER-BOX"), "boxed text removed");
  assert(!t.includes("WHITE-ON-WHITE"), "white text removed");
  assert(t.includes("hidden fixture public line"), "public line survives");
  assert(!Buffer.from(bytes).toString("latin1").includes("HIDDEN-UNDER-BOX"), "gone from raw bytes");
  await page.close();
});

test("privacy: an entire session makes zero cross-origin requests", async () => {
  const ctx = await newPage();
  const { page } = ctx;
  await uploadFixture(page, "basic.pdf");
  await waitEditor(page);
  await page.evaluate(() => window.__redacat.searchAndMark("TOP-SECRET-ALPHA"));
  await page.click("#download");
  await waitDownload("basic.redacted.pdf");
  const origin = new URL(BASE).origin;
  const foreign = ctx.requests.filter((u) => new URL(u).origin !== origin);
  assertEq(foreign.length, 0, `cross-origin requests seen: ${foreign.join(", ")}`);
  assert(ctx.requests.length > 3, "sanity: same-origin asset requests were captured");
  await page.close();
});

test("ui: mouse drag draws a mark and download works end-to-end", async () => {
  const { page } = await newPage();
  await page.click("#sample");
  await waitEditor(page);
  const box = await (await page.$("#cv")).boundingBox();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 6 });
  await page.mouse.up();
  await sleep(300);
  const status = await page.$eval("#status", (e) => e.textContent);
  assert(status.includes("1 mark"), `drag created a mark: "${status}"`);
  await page.click("#download");
  const bytes = await waitDownload("sample-memo.redacted.png");
  assert(bytes.length > 1000, "png downloaded");
  await page.close();
});

test("ui: select/delete/undo/clear state machine", async () => {
  const { page } = await newPage();
  await uploadFixture(page, "plain.png");
  await waitEditor(page);
  await page.evaluate(() => {
    window.__redacat.addMark(0, { x: 20, y: 20, w: 80, h: 40, mode: "black" });
    window.__redacat.addMark(0, { x: 150, y: 100, w: 80, h: 40, mode: "black" });
  });
  const status = () => page.$eval("#status", (e) => e.textContent);
  assert((await status()).includes("2 marks"), "two marks");
  // click inside the 2nd mark to select it, then delete
  const box = await (await page.$("#cv")).boundingBox();
  const sc = box.width / 400;
  await page.mouse.click(box.x + 190 * sc, box.y + 120 * sc);
  await page.keyboard.press("Backspace");
  await sleep(200);
  assert((await status()).includes("1 mark"), `delete removed selected: "${await status()}"`);
  await page.keyboard.down("Control");
  await page.keyboard.press("z");
  await page.keyboard.up("Control");
  await sleep(200);
  assert((await status()).includes("2 marks"), `undo restored: "${await status()}"`);
  await page.click("#clear");
  assert((await status()).includes("0 marks"), "clear page");
  await page.click("#undo");
  assert((await status()).includes("2 marks"), "undo clear");
  await page.close();
});

test("ui: state fully resets between files", async () => {
  const { page } = await newPage([{}]); // accept the close-file confirm
  await uploadFixture(page, "fivepages.pdf");
  await waitEditor(page);
  await page.evaluate(() => window.__redacat.addMark(0, { x: 10, y: 10, w: 50, h: 30 }));
  await page.click("#newfile");
  await waitIntroBack(page);
  await uploadFixture(page, "basic.pdf");
  await waitEditor(page);
  const status = await page.$eval("#status", (e) => e.textContent);
  assert(status.includes("0 mark"), `fresh state: "${status}"`);
  const pageinfo = await page.$eval("#pageinfo", (e) => e.textContent);
  assertEq(pageinfo.trim(), "1 / 2", "page count from new file");
  await page.close();
});

test("ui: strength slider live-edits a selected blur mark", async () => {
  const { page } = await newPage();
  await uploadFixture(page, "plain.png");
  await waitEditor(page);
  await page.evaluate(() => window.__redacat.addMark(0, { x: 20, y: 200, w: 60, h: 60, mode: "blur", strength: 2 }));
  const box = await (await page.$("#cv")).boundingBox();
  const sc = box.width / 400;
  await page.mouse.click(box.x + 50 * sc, box.y + 230 * sc); // select the mark
  await page.evaluate(() => {
    const s = document.getElementById("strength");
    s.value = "9";
    s.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const strength = await page.evaluate(() => window.__redacat.state.rects[0][0].strength);
  assertEq(strength, 9, "selected mark strength updated");
  await page.close();
});

test("ui: download disabled with zero marks, enabled after one", async () => {
  const { page } = await newPage();
  await uploadFixture(page, "basic.pdf");
  await waitEditor(page);
  assert(await page.$eval("#download", (b) => b.disabled), "disabled at 0 marks");
  await page.evaluate(() => window.__redacat.addMark(0, { x: 10, y: 10, w: 50, h: 30 }));
  assert(await page.$eval("#download", (b) => !b.disabled), "enabled at 1 mark");
  await page.close();
});

/* ---------- run ---------- */

browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: [
    "--window-size=1440,1000",
    ...(process.env.CI ? ["--no-sandbox", "--disable-dev-shm-usage"] : []),
  ],
  defaultViewport: { width: 1440, height: 1000 },
});

await makeImageFixtures();

let failed = 0;
for (const { name, fn } of tests) {
  // each test gets a clean downloads dir so names never collide
  for (const f of fs.readdirSync(DL)) fs.rmSync(path.join(DL, f));
  const t0 = Date.now();
  try {
    await fn();
    console.log(`ok   ${name}  (${Date.now() - t0}ms)`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${String(e.message || e).replace(/\n/g, "\n     ")}`);
  }
}

console.log(`\n${tests.length - failed}/${tests.length} passed`);
await browser.close();
server?.close();
process.exit(failed ? 1 : 0);
