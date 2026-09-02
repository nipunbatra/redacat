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

/* ---------- compare (PDF diff) tests ---------- */

async function uploadComparePaths(page, pathA, pathB) {
  await page.click("#comparelink");
  await (await page.$("#fileA")).uploadFile(pathA);
  await page.waitForFunction(
    () => window.__redacatCompare?.state.A && document.getElementById("busy").hidden,
    { timeout: 120000 },
  );
  await (await page.$("#fileB")).uploadFile(pathB);
  await page.waitForFunction(
    () => window.__redacatCompare?.state.B && document.getElementById("busy").hidden,
    { timeout: 120000 },
  );
}
const uploadComparePair = (page, nameA, nameB) =>
  uploadComparePaths(page, path.join(FIX, nameA), path.join(FIX, nameB));

const waitDocDiff = (page) => page.waitForFunction(
  () => window.__redacatCompare.state.docDiff && document.getElementById("busy").hidden,
  { timeout: 120000 },
);

const waitScan = (page) =>
  page.waitForFunction(() => window.__redacatCompare?.state.scanned, { timeout: 120000 });

test("compare: pair scan classifies pages (changed/same/changed/added)", async () => {
  const { page, errors } = await newPage();
  await uploadComparePair(page, "diffv1.pdf", "diffv2.pdf");
  await waitScan(page);
  const statuses = await page.evaluate(() => window.__redacatCompare.state.scan.map((s) => s.status));
  assertEq(JSON.stringify(statuses), JSON.stringify(["changed", "same", "changed", "added"]), "page statuses");
  const summary = await page.$eval("#csummary", (e) => e.textContent);
  assert(summary.includes("3 of 4 pages differ"), `summary: "${summary}"`);
  assertEq(errors.length, 0, `console errors: ${errors.join(" | ")}`);
  await page.close();
});

test("compare: changed page has pixel regions and an exact word diff", async () => {
  const { page } = await newPage();
  await uploadComparePair(page, "diffv1.pdf", "diffv2.pdf");
  await waitScan(page);
  const info = await page.evaluate(() => {
    const S = window.__redacatCompare.state;
    const e = S.cache.get(0);
    const words = (side, t) => e.text.ops
      .filter((o) => o.t === t)
      .flatMap((o) => (t === "-" ? e.text.wordsA.slice(o.ai, o.ai + o.n) : e.text.wordsB.slice(o.bi, o.bi + o.n)))
      .map((w) => w.s);
    return {
      regions: e.regions.length,
      del: e.text.delCount, ins: e.text.insCount,
      delWords: words("A", "-"), insWords: words("B", "+"),
      delRects: e.text.delRects.length, insRects: e.text.insRects.length,
      w: e.w, h: e.h,
      rectsInBounds: [...e.text.delRects, ...e.text.insRects]
        .every((r) => r.x > -5 && r.y > -5 && r.x + r.w < e.w + 5 && r.y + r.h < e.h + 5),
    };
  });
  assert(info.regions >= 1, `changed page has diff regions: ${info.regions}`);
  assert(info.delWords.includes("USD-250000"), `old amount marked removed: ${info.delWords}`);
  assert(info.insWords.includes("USD-275000"), `new amount marked added: ${info.insWords}`);
  assert(info.insWords.includes("ADDED-LINE-V2"), `added line detected: ${info.insWords}`);
  assert(info.delRects === info.del && info.insRects === info.ins, "one highlight rect per changed word");
  assert(info.rectsInBounds, "word highlight rects lie on the canvas");
  const panel = await page.$eval("#ctext", (e) => e.textContent);
  assert(panel.includes("USD-250000") && panel.includes("USD-275000"), `text panel shows both amounts: "${panel.slice(0, 200)}"`);
  await page.close();
});

test("compare: identical page reports no differences", async () => {
  const { page } = await newPage();
  await uploadComparePair(page, "diffv1.pdf", "diffv2.pdf");
  await waitScan(page);
  await page.evaluate(() => window.__redacatCompare.gotoPage(1));
  await until(() => page.evaluate(() => window.__redacatCompare.state.cache.has(1)), "page 2 compared");
  const info = await page.evaluate(() => {
    const e = window.__redacatCompare.state.cache.get(1);
    return { regions: e.regions.length, del: e.text.delCount, ins: e.text.insCount };
  });
  assertEq(info.regions, 0, "zero regions on identical page");
  assertEq(info.del + info.ins, 0, "zero word changes on identical page");
  const status = await page.$eval("#cstatus", (e) => e.textContent);
  assert(status.includes("no differences"), `status says identical: "${status}"`);
  await page.close();
});

test("compare: page present only in the new file is flagged", async () => {
  const { page } = await newPage();
  await uploadComparePair(page, "diffv1.pdf", "diffv2.pdf");
  await waitScan(page);
  await page.evaluate(() => window.__redacatCompare.gotoPage(3));
  await until(() => page.evaluate(() => window.__redacatCompare.state.cache.has(3)), "page 4 compared");
  const status = await page.$eval("#cstatus", (e) => e.textContent);
  assert(status.includes("only in the new file"), `status: "${status}"`);
  await page.close();
});

test("compare: inserted cover page realigns pages instead of cascading diffs", async () => {
  const { page, errors } = await newPage();
  await uploadComparePair(page, "shiftv1.pdf", "shiftv2.pdf");
  await waitScan(page);
  const st = await page.evaluate(() => {
    const S = window.__redacatCompare.state;
    return { statuses: S.scan.map((s) => s.status), pairs: S.pairs };
  });
  assertEq(JSON.stringify(st.statuses), JSON.stringify(["added", "same", "changed", "same"]),
    "cover page is 'added'; shifted pages pair up");
  assertEq(JSON.stringify(st.pairs), JSON.stringify([
    { a: null, b: 0 }, { a: 0, b: 1 }, { a: 1, b: 2 }, { a: 2, b: 3 },
  ]), "alignment pairs old i with new i+1");
  const summary = await page.$eval("#csummary", (e) => e.textContent);
  assert(summary.includes("pages realigned"), `summary notes realignment: "${summary}"`);
  await page.evaluate(() => window.__redacatCompare.gotoPage(2));
  await until(() => page.evaluate(() => window.__redacatCompare.state.cache.has(2)), "pair 3 compared");
  const info = await page.evaluate(() => {
    const e = window.__redacatCompare.state.cache.get(2);
    const words = (t) => e.text.ops.filter((o) => o.t === t)
      .flatMap((o) => (t === "-" ? e.text.wordsA.slice(o.ai, o.ai + o.n) : e.text.wordsB.slice(o.bi, o.bi + o.n)))
      .map((w) => w.s);
    return { del: words("-"), ins: words("+"), status: document.getElementById("cstatus").textContent };
  });
  assertEq(JSON.stringify(info.del), JSON.stringify(["original"]), "exactly the changed word marked removed");
  assertEq(JSON.stringify(info.ins), JSON.stringify(["revised"]), "exactly the changed word marked added");
  assert(info.status.includes("old p2 ↔ new p3"), `status shows the mapping: "${info.status}"`);
  assertEq(errors.length, 0, `console errors: ${errors.join(" | ")}`);
  await page.close();
});

test("compare: sample pair, view modes, and diff-image download", async () => {
  const { page, errors } = await newPage();
  await page.click("#comparelink");
  await page.click("#csample");
  await page.waitForFunction(
    () => window.__redacatCompare?.state.A && window.__redacatCompare?.state.B
      && document.getElementById("busy").hidden,
    { timeout: 120000 },
  );
  await waitScan(page);
  const st = await page.evaluate(() => {
    const S = window.__redacatCompare.state;
    return { pages: S.pageMax, statuses: S.scan.map((s) => s.status) };
  });
  assertEq(st.pages, 3, "sample pair has 3 aligned pairs");
  assertEq(JSON.stringify(st.statuses), JSON.stringify(["added", "changed", "same"]),
    "sample: cover added, policy changed, appendix same");
  for (const mode of ["overlay", "swipe", "side"]) {
    await page.click(`#cmodes [data-mode="${mode}"]`);
    await sleep(150);
  }
  await page.click("#chl"); // highlights off…
  await page.click("#chl"); // …and back on: both draws must survive
  await page.click("#cdownload");
  const bytes = await waitDownload("policy-v1-vs-policy-v2.page1.png");
  assert(bytes.length > 5000, "diff image downloaded");
  assertEq(errors.length, 0, `console errors: ${errors.join(" | ")}`);
  await page.close();
});

test("compare: encrypted old side opens with password; identical content = no differences", async () => {
  const { page, dialogs } = await newPage([{ text: FIXTURE_PW }]);
  await uploadComparePair(page, "protected.pdf", "basic.pdf");
  await waitScan(page);
  assertEq(dialogs.filter((d) => d.type === "prompt").length, 1, "one password prompt");
  const statuses = await page.evaluate(() => window.__redacatCompare.state.scan.map((s) => s.status));
  assertEq(JSON.stringify(statuses), JSON.stringify(["same", "same"]), "decrypted pages match their plain twin");
  const summary = await page.$eval("#csummary", (e) => e.textContent);
  assert(summary.includes("no differences found"), `summary: "${summary}"`);
  await page.close();
});

test("compare: images of different sizes diff by pixels, note the missing text layer", async () => {
  const { page } = await newPage();
  await uploadComparePair(page, "plain.png", "alpha.png");
  await waitScan(page);
  const info = await page.evaluate(() => {
    const e = window.__redacatCompare.state.cache.get(0);
    return { regions: e.regions.length, none: !!e.text.none, w: e.w, h: e.h };
  });
  assert(info.regions >= 1, `different images produce regions: ${info.regions}`);
  assert(info.none, "no text layer flagged");
  assert(info.w >= 400 && info.h >= 300, `union canvas covers the larger image: ${info.w}x${info.h}`);
  const panel = await page.$eval("#ctext", (e) => e.textContent);
  assert(panel.includes("no text layer"), `panel notes missing text: "${panel}"`);
  await page.close();
});

test("compare: two-file drop entry point works from the landing page", async () => {
  const { page } = await newPage();
  await page.evaluate(async () => {
    const get = async (n) =>
      new File([await (await fetch(n)).arrayBuffer()], n.split("/").pop(), { type: "application/pdf" });
    await window.__redacatCompareOpen([
      await get("tests/fixtures/diffv1.pdf"),
      await get("tests/fixtures/diffv2.pdf"),
    ]);
  });
  await waitScan(page);
  const pages = await page.evaluate(() => window.__redacatCompare.state.pageMax);
  assertEq(pages, 4, "compare opened from the drop entry point");
  await page.close();
});

test("compare: text view sees through reflow — exactly one changed word", async () => {
  const { page, errors } = await newPage();
  await uploadComparePair(page, "reflowv1.pdf", "reflowv2.pdf");
  await waitScan(page);
  // pagination shifted, so the per-page scan flags pages as changed…
  const statuses = await page.evaluate(() => window.__redacatCompare.state.scan.map((s) => s.status));
  assert(statuses.some((s) => s !== "same"), `per-page scan sees reflow: ${statuses}`);
  // …but the document text view reduces it all to the real edit
  await page.click('#cmodes [data-mode="text"]');
  await page.waitForFunction(
    () => window.__redacatCompare.state.docDiff && document.getElementById("busy").hidden,
    { timeout: 120000 },
  );
  const info = await page.evaluate(() => {
    const d = window.__redacatCompare.state.docDiff;
    const words = (t) => d.ops.filter((o) => o.t === t).flatMap((o) => o.words);
    return {
      del: words("-"), ins: words("+"),
      panel: document.getElementById("cdoctext").textContent,
      status: document.getElementById("cstatus").textContent,
      stripHidden: document.getElementById("cstrip").hidden,
      pagerHidden: document.getElementById("cpager").hidden,
    };
  });
  assertEq(JSON.stringify(info.del), JSON.stringify(["efficiency"]), "only the real word removed");
  assertEq(JSON.stringify(info.ins), JSON.stringify(["throughput"]), "only the real word added");
  assert(info.status.includes("−1 +1 words"), `doc status: "${info.status}"`);
  assert(!info.panel.includes("REFLOW REPORT"), "running head stripped from the text view");
  assert(info.panel.includes("information processing"), "hyphenated word rejoined");
  assert(info.stripHidden && info.pagerHidden, "page strip and pager hidden in text view");
  // download the text diff
  await page.click("#cdownload");
  const txt = (await waitDownload("reflowv1-vs-reflowv2.textdiff.txt")).toString("utf8");
  assert(txt.includes("[-efficiency-]") && txt.includes("{+throughput+}"), `textdiff content: ${txt.slice(0, 200)}`);
  // switching back restores the visual views
  await page.click('#cmodes [data-mode="side"]');
  await sleep(200);
  const back = await page.evaluate(() => ({
    strip: document.getElementById("cstrip").hidden,
    doctext: document.getElementById("cdoctext").hidden,
    pair: document.getElementById("cpair").hidden,
  }));
  assert(!back.strip && back.doctext && !back.pair, "side-by-side restored after text view");
  assertEq(errors.length, 0, `console errors: ${errors.join(" | ")}`);
  await page.close();
});

test("compare: text view on the standard pair shows amount change and added line", async () => {
  const { page } = await newPage();
  await uploadComparePair(page, "diffv1.pdf", "diffv2.pdf");
  await waitScan(page);
  await page.click('#cmodes [data-mode="text"]');
  await page.waitForFunction(
    () => window.__redacatCompare.state.docDiff && document.getElementById("busy").hidden,
    { timeout: 120000 },
  );
  const info = await page.evaluate(() => {
    const d = window.__redacatCompare.state.docDiff;
    const words = (t) => d.ops.filter((o) => o.t === t).flatMap((o) => o.words);
    return { del: words("-"), ins: words("+") };
  });
  assert(info.del.includes("USD-250000"), `old amount removed: ${info.del}`);
  assert(info.ins.includes("USD-275000"), `new amount added: ${info.ins}`);
  assert(info.ins.includes("ADDED-LINE-V2"), `added line present: ${info.ins}`);
  assert(info.ins.join(" ").includes("appendix page only in v2"), "added page's text shows as insertion");
  await page.close();
});

test("compare: page ranges skip front matter, restrict the text view, and reset", async () => {
  const { page, errors } = await newPage();
  await uploadComparePair(page, "shiftv1.pdf", "shiftv2.pdf");
  await waitScan(page);
  // compare old 1–3 with new 2–4: the cover page is simply out of scope
  await page.evaluate(() => {
    document.getElementById("rB0").value = "2";
    document.getElementById("rB1").value = "4";
  });
  await page.click("#crangeapply");
  await waitScan(page);
  const st = await page.evaluate(() => {
    const S = window.__redacatCompare.state;
    return {
      statuses: S.scan.map((s) => s.status), pairs: S.pairs,
      info: document.getElementById("crangeinfo").textContent,
      labels: [...document.querySelectorAll("#cstrip .pnum")].map((e) => e.textContent),
    };
  });
  assertEq(JSON.stringify(st.statuses), JSON.stringify(["same", "changed", "same"]), "no 'added' page once the cover is excluded");
  assertEq(JSON.stringify(st.pairs), JSON.stringify([{ a: 0, b: 1 }, { a: 1, b: 2 }, { a: 2, b: 3 }]), "pairs carry absolute page numbers");
  assertEq(JSON.stringify(st.labels), JSON.stringify(["1→2", "2→3", "3→4"]), "strip shows the absolute mapping");
  assert(st.info.includes("old 1–3 with new 2–4"), `range info: "${st.info}"`);
  // the text view now sees only the windowed pages
  await page.click('#cmodes [data-mode="text"]');
  await page.waitForFunction(
    () => window.__redacatCompare.state.docDiff && document.getElementById("busy").hidden,
    { timeout: 120000 },
  );
  const txt = await page.evaluate(() => {
    const d = window.__redacatCompare.state.docDiff;
    const words = (t) => d.ops.filter((o) => o.t === t).flatMap((o) => o.words);
    return { del: words("-"), ins: words("+") };
  });
  assertEq(JSON.stringify(txt.del), JSON.stringify(["original"]), "text view: only the real removal");
  assertEq(JSON.stringify(txt.ins), JSON.stringify(["revised"]), "text view: cover-page text no longer counts as added");
  // "all pages" restores the full comparison
  await page.click('#cmodes [data-mode="side"]');
  await page.click("#crangeall");
  await waitScan(page);
  const full = await page.evaluate(() => ({
    pairs: window.__redacatCompare.state.pairs.length,
    info: document.getElementById("crangeinfo").textContent,
    b0: document.getElementById("rB0").value, b1: document.getElementById("rB1").value,
  }));
  assertEq(full.pairs, 4, "all four pairs back");
  assertEq(full.info, "all pages", "range info reset");
  assert(full.b0 === "1" && full.b1 === "4", `inputs reset: ${full.b0}–${full.b1}`);
  assertEq(errors.length, 0, `console errors: ${errors.join(" | ")}`);
  await page.close();
});

test("compare: out-of-range page numbers are clamped, not rejected", async () => {
  const { page } = await newPage();
  await uploadComparePair(page, "diffv1.pdf", "diffv2.pdf");
  await waitScan(page);
  await page.evaluate(() => {
    document.getElementById("rA0").value = "0";
    document.getElementById("rA1").value = "99";
    document.getElementById("rB0").value = "3";
    document.getElementById("rB1").value = "2"; // end before start
  });
  await page.click("#crangeapply");
  await waitScan(page);
  const v = await page.evaluate(() => ({
    a0: document.getElementById("rA0").value, a1: document.getElementById("rA1").value,
    b0: document.getElementById("rB0").value, b1: document.getElementById("rB1").value,
    pairs: window.__redacatCompare.state.pairs,
  }));
  assert(v.a0 === "1" && v.a1 === "3", `old range clamped to the file: ${v.a0}–${v.a1}`);
  assert(v.b0 === "3" && v.b1 === "3", `inverted new range collapses to a single page: ${v.b0}–${v.b1}`);
  // old 1–3 vs new page 3 only: the matching third page pairs up, the rest are removed
  assert(v.pairs.some((p) => p.a === 2 && p.b === 2), `old p3 pairs with new p3: ${JSON.stringify(v.pairs)}`);
  assertEq(v.pairs.filter((p) => p.b == null).length, 2, "old pages 1–2 have no counterpart in the window");
  await page.close();
});

test("compare: text view reports a relocated paragraph as a move, not an edit", async () => {
  const { page, errors } = await newPage();
  await uploadComparePair(page, "movev1.pdf", "movev2.pdf");
  await waitScan(page);
  await page.click('#cmodes [data-mode="text"]');
  await page.waitForFunction(
    () => window.__redacatCompare.state.docDiff && document.getElementById("busy").hidden,
    { timeout: 120000 },
  );
  const info = await page.evaluate(() => {
    const d = window.__redacatCompare.state.docDiff;
    const words = (t) => d.ops.filter((o) => o.t === t).flatMap((o) => o.words);
    return {
      del: d.delCount, ins: d.insCount, moved: d.movedCount,
      out: words("<").join(" "), into: words(">").join(" "),
      status: document.getElementById("cstatus").textContent,
      movSpans: document.querySelectorAll("#cdoctext .tmov").length,
    };
  });
  assertEq(info.del + info.ins, 0, `no words counted as edited: −${info.del} +${info.ins}`);
  assertEq(info.moved, 12, `exactly the Bravo paragraph counts as moved: ${info.moved} words`);
  assert(info.out.startsWith("Bravo paragraph") && info.into.startsWith("Bravo paragraph"), `moved text identified: "${info.out.slice(0, 40)}"`);
  assert(info.status.includes("no text differences") && info.status.includes("words moved"), `status: "${info.status}"`);
  assertEq(info.movSpans, 2, "moved-away and moved-here spans rendered");
  await page.click("#cdownload");
  const txt = (await waitDownload("movev1-vs-movev2.textdiff.txt")).toString("utf8");
  assert(txt.includes("[~Bravo paragraph") && txt.includes("{~Bravo paragraph"), "text export marks the move");
  assertEq(errors.length, 0, `console errors: ${errors.join(" | ")}`);
  await page.close();
});

test("compare: ranges follow a swap, apply on Enter, and reset when a file is replaced", async () => {
  const { page } = await newPage();
  await uploadComparePair(page, "shiftv1.pdf", "shiftv2.pdf");
  await waitScan(page);
  // Enter in a range box applies it
  await page.focus("#rB0");
  await page.evaluate(() => { document.getElementById("rB0").value = "2"; });
  await page.keyboard.press("Enter");
  await waitScan(page);
  let info = await page.$eval("#crangeinfo", (e) => e.textContent);
  assert(info.includes("old 1–3 with new 2–4"), `Enter applied the range: "${info}"`);
  // swapping sides carries each window with its file
  await page.click("#cswap");
  await waitScan(page);
  info = await page.$eval("#crangeinfo", (e) => e.textContent);
  assert(info.includes("old 2–4 with new 1–3"), `windows swapped with the files: "${info}"`);
  const swapped = await page.evaluate(() => ({
    a: document.getElementById("slotAname").textContent,
    labels: [...document.querySelectorAll("#cstrip .pnum")].map((e) => e.textContent),
  }));
  assert(swapped.a.startsWith("shiftv2.pdf"), `old side is now v2: "${swapped.a}"`);
  assertEq(JSON.stringify(swapped.labels), JSON.stringify(["2→1", "3→2", "4→3"]), "labels reflect the swapped mapping");
  // replacing a file resets that side's window to all pages
  await (await page.$("#fileA")).uploadFile(path.join(FIX, "diffv1.pdf"));
  await page.waitForFunction(
    () => window.__redacatCompare.state.A?.name === "diffv1.pdf" && window.__redacatCompare.state.scanned,
    { timeout: 120000 },
  );
  const after = await page.evaluate(() => ({
    a0: document.getElementById("rA0").value, a1: document.getElementById("rA1").value,
    b0: document.getElementById("rB0").value, b1: document.getElementById("rB1").value,
  }));
  assert(after.a0 === "1" && after.a1 === "3", `replaced side compares whole: ${after.a0}–${after.a1}`);
  assert(after.b0 === "1" && after.b1 === "3", `untouched side keeps its window: ${after.b0}–${after.b1}`);
  await page.close();
});

// A real preprint-vs-publisher-proof pair lives in tests/private/ (gitignored:
// it is someone's unpublished chapter). When present, the tool must reproduce
// the findings of the hand-checked comparison summary made for its author.
test("compare: real proof pair (local only) — page range + text view reproduce the hand-checked findings", async () => {
  const OLD = path.join(HERE, "private", "proof-old.pdf");
  const NEW = path.join(HERE, "private", "proof-new.pdf");
  if (!fs.existsSync(OLD) || !fs.existsSync(NEW)) {
    console.log("     (skipped — tests/private/proof-old.pdf / proof-new.pdf not present)");
    return;
  }
  const { page, errors } = await newPage();
  await uploadComparePaths(page, OLD, NEW);
  await waitScan(page);
  // the proof wraps the chapter in a metadata sheet + stub (pp. 1–2) and
  // author queries + figure alt-text (pp. 21–23): compare the chapter body only
  await page.evaluate(() => {
    document.getElementById("rB0").value = "3";
    document.getElementById("rB1").value = "20";
  });
  await page.click("#crangeapply");
  await waitScan(page);
  const st = await page.evaluate(() => {
    const S = window.__redacatCompare.state;
    return { statuses: S.scan.map((s) => s.status), info: document.getElementById("crangeinfo").textContent };
  });
  assert(st.info.includes("old 1–19 with new 3–20"), `range applied: "${st.info}"`);
  console.log(`     real pair, page statuses: ${st.statuses.join(",")}`);
  const unmatched = st.statuses.filter((s) => s === "removed" || s === "added").length;
  const flows = st.statuses.filter((s) => s === "flow").length;
  // only the preprint's first page is genuinely unmatched: its abstract left
  // for the metadata sheet, which the range excludes
  assert(unmatched <= 1, `at most one page without a counterpart (got ${unmatched}): ${st.statuses}`);
  assert(flows >= 3, `pages merged/split by re-pagination read as text flow, not add/remove: ${st.statuses}`);
  await page.evaluate(() => window.__redacatCompare.gotoPage(0));
  const status0 = await page.$eval("#cstatus", (e) => e.textContent);
  assert(/only in the (old|new) file \(\d+% of its words appear on/.test(status0) || status0.includes("↝"),
    `unmatched/flow page explains where its text went: "${status0}"`);

  await page.click('#cmodes [data-mode="text"]');
  await waitDocDiff(page);
  const t = await page.evaluate(() => {
    const d = window.__redacatCompare.state.docDiff;
    const words = (k) => d.ops.filter((o) => o.t === k).flatMap((o) => o.words);
    return { del: words("-"), ins: words("+"), delCount: d.delCount, insCount: d.insCount, moved: d.movedCount };
  });
  console.log(`     real pair, chapter body only: −${t.delCount} +${t.insCount} words, ${t.moved} words moved`);
  // the four "worth checking" findings from the summary
  assert(t.del.includes("organism") && t.ins.includes("organism's"), "verb→possessive change (organism functions → organism's functions)");
  assert(t.del.includes('"RP.".') && t.ins.includes('"RP.."'), "doubled period inside the RP quotation");
  assert(t.del.includes("Ewald,") && t.ins.includes("Weibel"), "reference 10 author corrected to Weibel");
  assert(t.del.includes("5th") && t.ins.includes("fifth") && t.del.includes("6th") && t.ins.includes("sixth"), "ordinals spelled out");
  assert(t.del.includes("section") && t.ins.some((w) => w.startsWith("Sect.")), "cross-reference restyle (section → Sect.)");
  // publisher scaffolding is out of scope thanks to the range
  assert(!t.ins.includes("Kindly"), "author-query text excluded");
  assert(!t.ins.includes("HolderName"), "metadata sheet excluded");
  // relocated footnotes read as moves; the remaining volume (reference-list
  // restyle, affiliation/copyright block, caption resets) is stable at
  // roughly −780/+450 words — a regression would show up as a jump
  assert(t.moved >= 100, `relocated footnotes recognized as moves: ${t.moved}`);
  assert(t.delCount + t.insCount < 1500, `edit volume stays at the known level: −${t.delCount} +${t.insCount}`);
  assertEq(errors.length, 0, `console errors: ${errors.join(" | ")}`);
  await page.close();
});

test("compare: tightly justified text without space glyphs still diffs word by word", async () => {
  const { page, errors } = await newPage();
  await uploadComparePair(page, "tightv1.pdf", "tightv2.pdf");
  await waitScan(page);
  await page.click('#cmodes [data-mode="text"]');
  await waitDocDiff(page);
  const info = await page.evaluate(() => {
    const d = window.__redacatCompare.state.docDiff;
    const words = (t) => d.ops.filter((o) => o.t === t).flatMap((o) => o.words);
    const e = window.__redacatCompare.state.cache.get(0);
    return {
      del: words("-"), ins: words("+"),
      panel: document.getElementById("cdoctext").textContent,
      pageWords: e.text.wordsB.length, pageDel: e.text.delCount, pageIns: e.text.insCount,
    };
  });
  assertEq(JSON.stringify(info.del), JSON.stringify(["quick"]), "only the edited word removed — no welded tokens");
  assertEq(JSON.stringify(info.ins), JSON.stringify(["swift"]), "only the edited word added");
  assert(!/brownfox|overthe|withoutany|jumpsover/.test(info.panel), `no welded words in the text view: "${info.panel.slice(0, 120)}"`);
  assertEq(info.pageWords, 27, "every word on the tight page is its own box");
  assert(info.pageDel === 1 && info.pageIns === 1, `page view sees one changed word: −${info.pageDel} +${info.pageIns}`);
  assertEq(errors.length, 0, `console errors: ${errors.join(" | ")}`);
  await page.close();
});

test("compare: close resets state and the redaction editor still works", async () => {
  const { page } = await newPage();
  await uploadComparePair(page, "diffv1.pdf", "diffv2.pdf");
  await waitScan(page);
  await page.click("#cclose");
  await waitIntroBack(page);
  const cleared = await page.evaluate(() => {
    const S = window.__redacatCompare.state;
    return !S.A && !S.B && S.cache.size === 0 && !document.body.classList.contains("comparing");
  });
  assert(cleared, "compare state fully cleared");
  await uploadFixture(page, "basic.pdf");
  await waitEditor(page);
  await page.evaluate(() => window.__redacat.addMark(0, { x: 10, y: 10, w: 50, h: 30 }));
  const status = await page.$eval("#status", (e) => e.textContent);
  assert(status.includes("1 mark"), `redaction works after compare: "${status}"`);
  await page.close();
});

test("privacy: a full compare session makes zero cross-origin requests", async () => {
  const ctx = await newPage();
  const { page } = ctx;
  await uploadComparePair(page, "diffv1.pdf", "diffv2.pdf");
  await waitScan(page);
  await page.click(`#cmodes [data-mode="overlay"]`);
  await page.click("#cdownload");
  await waitDownload("diffv1-vs-diffv2.page1.png");
  const origin = new URL(BASE).origin;
  const foreign = ctx.requests.filter((u) => new URL(u).origin !== origin);
  assertEq(foreign.length, 0, `cross-origin requests seen: ${foreign.join(", ")}`);
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
