// Redacat compare — what changed between two PDFs (or images)?
// Both files are rendered locally by MuPDF WASM. Pages are first ALIGNED by
// content similarity (an inserted cover page in one file must not make every
// later page look "changed"), then each aligned pair is diffed two ways:
// pixels (changed regions, overlay tinting) and words (via the text layer, so
// insertions/deletions are marked at exact positions). Like the redaction
// editor, nothing ever leaves the tab.

import { loadEngine } from "./engine.js";
import { alignPages, jaccard, pixelRegions, pixelsDiffer, shingleSet, tokenDiff } from "./diff.js";

const $ = (id) => document.getElementById(id);

const els = {
  intro: $("intro"), compare: $("compare"), openBtn: $("comparelink"),
  slots: $("cslots"), samplerow: $("csamplerow"), sample: $("csample"), swap: $("cswap"),
  slotEl: { A: $("slotA"), B: $("slotB") },
  slotName: { A: $("slotAname"), B: $("slotBname") },
  slotInput: { A: $("fileA"), B: $("fileB") },
  bar: $("cbar"), names: $("cnames"), summary: $("csummary"),
  modes: $("cmodes"), hl: $("chl"),
  prev: $("cprev"), next: $("cnext"), pageinfo: $("cpageinfo"),
  close: $("cclose"), download: $("cdownload"),
  views: $("cviews"), strip: $("cstrip"),
  pair: $("cpair"), capA: $("capA"), capB: $("capB"), one: $("cone"),
  cvA: $("cvA"), cvB: $("cvB"), cvO: $("cvO"),
  status: $("cstatus"), legend: $("clegend"),
  textwrap: $("ctextwrap"), textsummary: $("ctextsummary"), text: $("ctext"),
  busy: $("busy"), busytext: $("busytext"),
};

// keep in sync with --stamp / --add / --chg in css/style.css
const COLORS = { del: "#b3261e", add: "#0e6b52", chg: "#c77400" };

const TARGET_W = 1300;        // preferred render width in px for the wider page
const MAX_DIFF_PIXELS = 6e6;  // per-page render cap (both sides use one scale)
const CACHE_PAGES = 6;        // full-res page pairs kept in memory
const THUMB_W = 120;          // page-strip thumbnail width
const MAX_THUMB_PAGES = 400;  // beyond this the strip skips thumbs & pixel scan
const ALIGN_MAX_CELLS = 25e4; // pageCountA × pageCountB cap for alignment
const MIN_PAGE_SIM = 0.3;     // below this, pages are add/remove, not a pair
const MIN_TEXT_WORDS = 8;     // pages with less text align by pixels instead

const S = {
  active: false,
  mupdf: null,
  opening: false,
  A: null, B: null,        // {name, doc, pageCount, password}
  pairs: [],               // aligned [{a, b}], a/b page index or null
  sigA: null, sigB: null,  // per-page {text, words, sh, vec?} (null on fallback)
  pageMax: 0,              // = pairs.length
  pageIndex: 0,            // index into pairs
  mode: "side",            // side | overlay | swipe
  highlights: true,
  swipeX: 0.55,
  scan: [],                // per pair {status, thumb}; status: pending|same|changed|added|removed
  scanned: false,
  scanToken: 0,
  cache: new Map(),        // pairIndex -> entry (LRU, capped at CACHE_PAGES)
};

/* ---------- helpers ---------- */

function busy(text) {
  els.busytext.textContent = text;
  els.busy.hidden = false;
  return new Promise((r) => setTimeout(r, 30));
}
function unbusy() { els.busy.hidden = true; }

const tick = () => new Promise((r) => setTimeout(r));
const baseName = (name) => name.replace(/\.[^.]+$/, "");

async function ensureEngine() {
  if (S.mupdf) return;
  await busy("loading the PDF engine (10 MB, one time)…");
  S.mupdf = await loadEngine();
}

/* ---------- lifecycle ---------- */

function showCompare() {
  S.active = true;
  document.body.classList.add("comparing");
  els.intro.hidden = true;
  els.compare.hidden = false;
  updateSlots();
  window.scrollTo({ top: 0 });
}

function closeCompare() {
  S.scanToken++; // stops any in-flight scan
  destroySide("A");
  destroySide("B");
  clearCache();
  resetScanThumbs();
  S.scan = [];
  S.scanned = false;
  S.pairs = [];
  S.sigA = S.sigB = null;
  S.pageMax = 0;
  S.pageIndex = 0;
  S.active = false;
  document.body.classList.remove("comparing");
  els.bar.hidden = true;
  els.views.hidden = true;
  els.compare.hidden = true;
  updateSlots();
  els.intro.hidden = false;
}

function destroySide(side) {
  const d = S[side];
  if (d?.doc) { try { d.doc.destroy(); } catch {} }
  S[side] = null;
}

function clearCache() {
  for (const e of S.cache.values()) { try { e.overlay?.close?.(); } catch {} }
  S.cache.clear();
}

function resetScanThumbs() {
  for (const s of S.scan) { try { s.thumb?.close?.(); } catch {} }
}

// a new/replaced file voids every derived result
function invalidateCompare() {
  S.scanToken++;
  clearCache();
  resetScanThumbs();
  S.scan = [];
  S.scanned = false;
  S.pairs = [];
  S.sigA = S.sigB = null;
  S.pageIndex = 0;
  els.bar.hidden = true;
  els.views.hidden = true;
}

function updateSlots() {
  for (const side of ["A", "B"]) {
    const d = S[side];
    els.slotName[side].textContent = d
      ? `${d.name} · ${d.pageCount} page${d.pageCount === 1 ? "" : "s"}`
      : "drop or click — pdf · png · jpeg";
    els.slotEl[side].classList.toggle("loaded", !!d);
  }
  els.samplerow.hidden = !!(S.A && S.B);
  els.swap.disabled = !(S.A && S.B);
}

/* ---------- opening files ---------- */

async function openSideFile(side, file) {
  const name = file.name || "untitled";
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(name);
  const type = isPdf ? "application/pdf" : (file.type || "image/png");
  await openSideBytes(side, name, new Uint8Array(await file.arrayBuffer()), type);
}

async function openSideBytes(side, name, bytes, type = "application/pdf") {
  if (S.opening) return;
  S.opening = true;
  try {
    await ensureEngine();
    await busy(`opening the ${side === "A" ? "old" : "new"} file…`);
    const doc = S.mupdf.Document.openDocument(bytes, type);
    let password = null, pageCount;
    // every fallible step runs before the old side is torn down
    try {
      if (doc.needsPassword()) {
        unbusy();
        for (let attempt = 0; ; attempt++) {
          if (attempt >= 3) throw new Error("Wrong password (3 attempts).");
          const pw = window.prompt(attempt === 0
            ? `“${name}” is password-protected. Enter the password to open it:`
            : "Wrong password — try again:");
          if (pw === null) throw new Error("A password is required to open this file.");
          if (doc.authenticatePassword(pw) !== 0) { password = pw; break; }
        }
        await busy("opening…");
      }
      pageCount = doc.countPages();
      if (pageCount === 0) throw new Error("This file has no pages.");
      doc.loadPage(0).getBounds(); // fail early on broken page trees
    } catch (err) {
      try { doc.destroy(); } catch {}
      throw err;
    }
    destroySide(side);
    S[side] = { name, doc, pageCount, password };
    invalidateCompare();
    updateSlots();
    unbusy();
    if (S.A && S.B) await beginCompare();
  } catch (err) {
    unbusy();
    alert(`Couldn't open that file.\n\n${err.message || err}`);
  } finally {
    S.opening = false;
  }
}

async function openPair(fileA, fileB) {
  await openSideFile("A", fileA);
  await openSideFile("B", fileB);
}

/* ---------- page alignment ---------- */

async function rasterBitmap(doc, i, scale) {
  const pix = doc.loadPage(i).toPixmap(
    S.mupdf.Matrix.scale(scale, scale),
    S.mupdf.ColorSpace.DeviceRGB, false, true,
  );
  const png = pix.asPNG();
  pix.destroy();
  return createImageBitmap(new Blob([png], { type: "image/png" }));
}

function pageDims(doc, i) {
  const b = doc.loadPage(i).getBounds();
  return { bounds: b, pw: Math.max(1, b[2] - b[0]), ph: Math.max(1, b[3] - b[1]) };
}

function pageTextRaw(doc, i) {
  const st = doc.loadPage(i).toStructuredText();
  const t = st.asText();
  st.destroy();
  return t;
}

// tiny stretched grayscale grid — lets near-textless (scanned) pages align
async function microVec(doc, i) {
  const GW = 16, GH = 20;
  const d = pageDims(doc, i);
  const bm = await rasterBitmap(doc, i, Math.min(1, Math.max(GW / d.pw, GH / d.ph)));
  const c = document.createElement("canvas");
  c.width = GW; c.height = GH;
  const g = c.getContext("2d");
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, GW, GH);
  g.drawImage(bm, 0, 0, GW, GH);
  bm.close?.();
  const px = g.getImageData(0, 0, GW, GH).data;
  const v = new Float32Array(GW * GH);
  for (let p = 0; p < v.length; p++) {
    v[p] = (px[p * 4] * 77 + px[p * 4 + 1] * 150 + px[p * 4 + 2] * 29) >> 8;
  }
  return v;
}

function rasterSim(a, b) {
  if (!a || !b) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return 1 - s / (a.length * 255);
}

async function docSignatures(doc, n) {
  const sigs = [];
  for (let i = 0; i < n; i++) {
    let text = "";
    try { text = pageTextRaw(doc, i); } catch {}
    const words = text.split(/\s+/).filter(Boolean);
    const sig = { text, words: words.length, sh: shingleSet(words), vec: null };
    if (words.length < MIN_TEXT_WORDS) {
      try { sig.vec = await microVec(doc, i); } catch {}
    }
    sigs.push(sig);
    if ((i & 7) === 7) await tick();
  }
  return sigs;
}

function pageSim(a, b) {
  if (a.words >= MIN_TEXT_WORDS && b.words >= MIN_TEXT_WORDS) return jaccard(a.sh, b.sh);
  if (a.words < MIN_TEXT_WORDS && b.words < MIN_TEXT_WORDS) return rasterSim(a.vec, b.vec);
  return 0.15; // one page has text, the other doesn't — no plausible pair
}

async function buildAlignment() {
  const N = S.A.pageCount, M = S.B.pageCount;
  // two single-page files were loaded to be compared — always pair them
  if (N === 1 && M === 1) {
    S.pairs = [{ a: 0, b: 0 }];
    S.sigA = S.sigB = null;
    return;
  }
  if (N * M > ALIGN_MAX_CELLS) {
    // enormous documents: fall back to index pairing
    S.pairs = Array.from({ length: Math.max(N, M) }, (_, i) => ({
      a: i < N ? i : null,
      b: i < M ? i : null,
    }));
    S.sigA = S.sigB = null;
    return;
  }
  await busy("aligning pages…");
  S.sigA = await docSignatures(S.A.doc, N);
  S.sigB = await docSignatures(S.B.doc, M);
  const grid = new Float32Array(N * M);
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < M; j++) grid[i * M + j] = pageSim(S.sigA[i], S.sigB[j]);
  }
  S.pairs = alignPages(N, M, (i, j) => grid[i * M + j], MIN_PAGE_SIM);
}

/* ---------- compare pipeline ---------- */

async function beginCompare() {
  await busy("comparing…");
  try {
    await buildAlignment();
  } catch (err) {
    unbusy();
    alert(`Couldn't align the two files.\n\n${err.message || err}`);
    return;
  }
  unbusy();
  S.pageMax = S.pairs.length;
  S.pageIndex = 0;
  els.bar.hidden = false;
  els.views.hidden = false;
  els.names.textContent = `${S.A.name} ⇄ ${S.B.name}`;
  els.names.title = els.names.textContent;
  S.scan = S.pairs.map(() => ({ status: "pending", thumb: null }));
  buildStrip();
  updateSummary();
  await cGotoPage(0, true);
  scanAll(); // async background sweep; guards itself with scanToken
}

// Render the pages of pair i at one shared points→pixels scale onto white
// union-size canvases, then derive everything the views need: changed
// regions, the tinted overlay, and the word-level text diff.
async function ensurePage(i) {
  if (S.cache.has(i)) {
    const e = S.cache.get(i);
    S.cache.delete(i);
    S.cache.set(i, e); // refresh LRU order
    return e;
  }
  const { a: pa, b: pb } = S.pairs[i];
  const dimA = pa != null ? pageDims(S.A.doc, pa) : null;
  const dimB = pb != null ? pageDims(S.B.doc, pb) : null;
  const pw = Math.max(dimA?.pw ?? 1, dimB?.pw ?? 1);
  const ph = Math.max(dimA?.ph ?? 1, dimB?.ph ?? 1);
  let scale = Math.min(2.5, Math.max(0.5, TARGET_W / pw));
  scale = Math.min(scale, Math.sqrt(MAX_DIFF_PIXELS / (pw * ph)));
  scale = Math.max(scale, 8 / Math.min(pw, ph)); // never a zero-pixel render
  const w = Math.max(1, Math.ceil(pw * scale));
  const h = Math.max(1, Math.ceil(ph * scale));

  const renderSide = async (doc, p) => {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d");
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, w, h);
    if (p != null) {
      const bm = await rasterBitmap(doc, p, scale);
      g.drawImage(bm, 0, 0);
      bm.close?.();
    }
    return c;
  };
  const cA = await renderSide(S.A?.doc, pa);
  const cB = await renderSide(S.B?.doc, pb);

  const dA = cA.getContext("2d").getImageData(0, 0, w, h);
  const dB = cB.getContext("2d").getImageData(0, 0, w, h);
  const regions = pa != null && pb != null ? pixelRegions(dA.data, dB.data, w, h) : [];

  // overlay: red = ink only in old, teal = ink only in new, dark = both
  const od = new ImageData(w, h);
  const a8 = dA.data, b8 = dB.data, o8 = od.data;
  for (let p = 0; p < a8.length; p += 4) {
    const la = (a8[p] * 77 + a8[p + 1] * 150 + a8[p + 2] * 29) >> 8;
    const lb = (b8[p] * 77 + b8[p + 1] * 150 + b8[p + 2] * 29) >> 8;
    o8[p] = lb;         // old ink knocks out red's complement -> shows red
    o8[p + 1] = la;     // new ink shows as teal/cyan
    o8[p + 2] = la;
    o8[p + 3] = 255;
  }
  const overlay = await createImageBitmap(od);

  const text = computeTextDiff(pa, pb, scale, dimA?.bounds, dimB?.bounds);

  const entry = { w, h, scale, cA, cB, pa, pb, regions, overlay, text };
  S.cache.set(i, entry);
  if (S.cache.size > CACHE_PAGES) {
    const [oldKey, oldEntry] = S.cache.entries().next().value;
    try { oldEntry.overlay?.close?.(); } catch {}
    S.cache.delete(oldKey);
  }
  return entry;
}

/* ---------- text diff ---------- */

// words with united character quads, in fitz page coordinates
function pageWords(doc, i) {
  const st = doc.loadPage(i).toStructuredText();
  const words = [];
  let cur = null;
  const flush = () => { if (cur && cur.s) words.push(cur); cur = null; };
  st.walk({
    endLine: flush,
    onChar(c, _origin, _font, _size, q) {
      if (/\s/.test(c)) { flush(); return; }
      const x0 = Math.min(q[0], q[2], q[4], q[6]);
      const x1 = Math.max(q[0], q[2], q[4], q[6]);
      const y0 = Math.min(q[1], q[3], q[5], q[7]);
      const y1 = Math.max(q[1], q[3], q[5], q[7]);
      if (!cur) cur = { s: "", x0, y0, x1, y1 };
      cur.s += c;
      if (x0 < cur.x0) cur.x0 = x0;
      if (y0 < cur.y0) cur.y0 = y0;
      if (x1 > cur.x1) cur.x1 = x1;
      if (y1 > cur.y1) cur.y1 = y1;
    },
  });
  flush();
  st.destroy();
  return words;
}

function computeTextDiff(pa, pb, scale, bndA, bndB) {
  const empty = { none: true, delCount: 0, insCount: 0, delRects: [], insRects: [] };
  let wordsA = [], wordsB = [];
  try {
    wordsA = pa != null ? pageWords(S.A.doc, pa) : [];
    wordsB = pb != null ? pageWords(S.B.doc, pb) : [];
  } catch {
    return empty;
  }
  if (!wordsA.length && !wordsB.length) return empty;
  const ops = tokenDiff(wordsA.map((w) => w.s), wordsB.map((w) => w.s));
  const out = { wordsA, wordsB, ops, delRects: [], insRects: [], delCount: 0, insCount: 0 };
  if (!ops) { out.overflow = true; return out; }
  const rect = (wd, bnd) => ({
    x: (wd.x0 - bnd[0]) * scale - 1,
    y: (wd.y0 - bnd[1]) * scale - 1,
    w: (wd.x1 - wd.x0) * scale + 2,
    h: (wd.y1 - wd.y0) * scale + 2,
  });
  for (const o of ops) {
    if (o.t === "-") {
      out.delCount += o.n;
      for (let k = 0; k < o.n; k++) out.delRects.push(rect(wordsA[o.ai + k], bndA));
    } else if (o.t === "+") {
      out.insCount += o.n;
      for (let k = 0; k < o.n; k++) out.insRects.push(rect(wordsB[o.bi + k], bndB));
    }
  }
  return out;
}

/* ---------- background pair scan (strip statuses + thumbnails) ---------- */

async function scanAll() {
  const token = ++S.scanToken;
  const withThumbs = S.pageMax <= MAX_THUMB_PAGES;
  els.strip.classList.toggle("nothumbs", !withThumbs);
  for (let i = 0; i < S.pageMax; i++) {
    if (token !== S.scanToken || !S.active) return;
    let status = "same", thumb = null;
    try {
      const { a: pa, b: pb } = S.pairs[i];
      if (pa == null) status = "added";
      else if (pb == null) status = "removed";
      else {
        const tA = S.sigA ? S.sigA[pa].text : pageTextRaw(S.A.doc, pa);
        const tB = S.sigB ? S.sigB[pb].text : pageTextRaw(S.B.doc, pb);
        if (tA !== tB) status = "changed";
      }

      if (withThumbs) {
        if (pa != null && pb != null) {
          // one shared scale, so the thumbnail pixel check is a fair comparison
          const a = pageDims(S.A.doc, pa), b = pageDims(S.B.doc, pb);
          const ts = Math.min(1, THUMB_W / Math.max(a.pw, b.pw));
          const tw = Math.max(1, Math.ceil(Math.max(a.pw, b.pw) * ts));
          const th = Math.max(1, Math.ceil(Math.max(a.ph, b.ph) * ts));
          const bmA = await rasterBitmap(S.A.doc, pa, ts);
          const bmB = await rasterBitmap(S.B.doc, pb, ts);
          if (token !== S.scanToken) { bmA.close?.(); bmB.close?.(); return; }
          if (status === "same") {
            const flat = (bm) => {
              const c = document.createElement("canvas");
              c.width = tw; c.height = th;
              const g = c.getContext("2d");
              g.fillStyle = "#ffffff";
              g.fillRect(0, 0, tw, th);
              g.drawImage(bm, 0, 0);
              return g.getImageData(0, 0, tw, th).data;
            };
            // catches graphics/image changes the text comparison can't see
            if (pixelsDiffer(flat(bmA), flat(bmB))) status = "changed";
          }
          thumb = bmB;
          bmA.close?.();
        } else {
          const src = pb != null ? S.B : S.A;
          const p = pb ?? pa;
          const d = pageDims(src.doc, p);
          thumb = await rasterBitmap(src.doc, p, Math.min(1, THUMB_W / d.pw));
          if (token !== S.scanToken) { thumb.close?.(); return; }
        }
      }
    } catch {
      status = "changed"; // a page that won't scan deserves a look
    }
    S.scan[i] = { status, thumb };
    updateStripCell(i);
    updateSummary();
    if ((i & 1) === 1) await tick(); // let the UI breathe
  }
  S.scanned = true;
  updateSummary();
}

/* ---------- page strip ---------- */

function pairShort(p) {
  if (p.a == null) return `+${p.b + 1}`;
  if (p.b == null) return `−${p.a + 1}`;
  return p.a === p.b ? `${p.a + 1}` : `${p.a + 1}→${p.b + 1}`;
}

function pairLong(p) {
  if (p.a == null) return `new page ${p.b + 1}`;
  if (p.b == null) return `old page ${p.a + 1}`;
  return p.a === p.b ? `page ${p.a + 1}` : `old p${p.a + 1} ↔ new p${p.b + 1}`;
}

function buildStrip() {
  els.strip.replaceChildren();
  for (let i = 0; i < S.pageMax; i++) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "pcell s-pending";
    if (S.pageMax <= MAX_THUMB_PAGES) {
      const c = document.createElement("canvas");
      c.className = "pthumb";
      c.width = 3; c.height = 4;
      b.appendChild(c);
    }
    const n = document.createElement("span");
    n.className = "pnum";
    n.textContent = pairShort(S.pairs[i]);
    b.appendChild(n);
    b.title = pairLong(S.pairs[i]);
    b.addEventListener("click", () => cGotoPage(i));
    els.strip.appendChild(b);
  }
  markStripCurrent();
}

function updateStripCell(i) {
  const b = els.strip.children[i];
  if (!b) return;
  const s = S.scan[i];
  b.classList.remove("s-same", "s-changed", "s-added", "s-removed", "s-pending");
  b.classList.add(`s-${s.status}`);
  const label = {
    same: "unchanged", changed: "changed", added: "only in new",
    removed: "only in old", pending: "scanning…",
  }[s.status];
  b.title = `${pairLong(S.pairs[i])} — ${label}`;
  const c = b.querySelector(".pthumb");
  if (c && s.thumb) {
    c.width = s.thumb.width;
    c.height = s.thumb.height;
    c.getContext("2d").drawImage(s.thumb, 0, 0);
  }
}

function markStripCurrent() {
  for (let i = 0; i < els.strip.children.length; i++) {
    els.strip.children[i].classList.toggle("current", i === S.pageIndex);
  }
  els.strip.children[S.pageIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/* ---------- navigation & drawing ---------- */

async function cGotoPage(i, force = false) {
  if (i < 0 || i >= S.pageMax) return;
  if (!force && i === S.pageIndex && S.cache.has(i)) { markStripCurrent(); return; }
  S.pageIndex = i;
  let e = S.cache.get(i);
  if (!e) {
    await busy(`comparing ${pairLong(S.pairs[i])}…`);
    try {
      e = await ensurePage(i);
    } catch (err) {
      unbusy();
      alert(`Couldn't compare ${pairLong(S.pairs[i])}.\n\n${err.message || err}`);
      return;
    }
    unbusy();
    // the full-res result can catch changes the quick scan missed
    const s = S.scan[i];
    if (s && s.status === "same" && (e.regions.length || e.text.delCount || e.text.insCount)) {
      s.status = "changed";
      updateStripCell(i);
      updateSummary();
    }
  }
  els.capA.textContent = `${S.A.name}${e.pa != null ? ` · page ${e.pa + 1}` : ""}`;
  els.capB.textContent = `${S.B.name}${e.pb != null ? ` · page ${e.pb + 1}` : ""}`;
  updatePager();
  drawViews();
  updateStatus();
  buildTextPanel(e);
  markStripCurrent();
}

function updatePager() {
  els.pageinfo.textContent = `${S.pageIndex + 1} / ${S.pageMax}`;
  els.prev.disabled = S.pageIndex === 0;
  els.next.disabled = S.pageIndex === S.pageMax - 1;
}

function drawViews() {
  const e = S.cache.get(S.pageIndex);
  if (!e) return;
  const side = S.mode === "side";
  els.pair.hidden = !side;
  els.one.hidden = side;
  if (side) {
    paintSide(els.cvA, e, "A");
    paintSide(els.cvB, e, "B");
  } else {
    els.cvO.width = e.w;
    els.cvO.height = e.h;
    const g = els.cvO.getContext("2d");
    if (S.mode === "overlay") {
      g.drawImage(e.overlay, 0, 0);
      paintRegions(g, e);
    } else {
      // swipe: new underneath, old clipped to the left of the divider
      g.drawImage(e.cB, 0, 0);
      const cut = Math.round(e.w * S.swipeX);
      g.save();
      g.beginPath();
      g.rect(0, 0, cut, e.h);
      g.clip();
      g.drawImage(e.cA, 0, 0);
      g.restore();
      g.save();
      g.fillStyle = "#141412";
      g.fillRect(cut - 1, 0, 3, e.h);
      const fs = Math.max(11, Math.round(e.w / 70));
      g.font = `700 ${fs}px ui-monospace, Menlo, monospace`;
      g.textBaseline = "top";
      const padx = Math.round(fs * 0.45);
      const tag = (label, x, align) => {
        const tw = g.measureText(label).width + padx * 2;
        const tx = align === "right" ? x - tw : x;
        g.fillStyle = "#141412";
        g.fillRect(tx, 8, tw, fs * 1.7);
        g.fillStyle = "#ffffff";
        g.fillText(label, tx + padx, 8 + fs * 0.33);
      };
      tag("old", cut - 8, "right");
      tag("new", cut + 8, "left");
      g.restore();
    }
    els.cvO.style.cursor = S.mode === "swipe" ? "col-resize" : "default";
  }
  updateLegend();
}

function paintSide(cv, e, side) {
  cv.width = e.w;
  cv.height = e.h;
  const g = cv.getContext("2d");
  g.drawImage(side === "A" ? e.cA : e.cB, 0, 0);
  const missing = side === "A" ? e.pa == null : e.pb == null;
  if (missing) {
    g.fillStyle = "#8a8a84";
    g.font = `${Math.max(12, Math.round(e.w / 32))}px ui-monospace, Menlo, monospace`;
    g.textAlign = "center";
    g.fillText(side === "A" ? "no matching page in the old file" : "no matching page in the new file", e.w / 2, e.h / 2);
  }
  if (!S.highlights) return;
  paintRegions(g, e);
  g.save();
  g.globalAlpha = 0.3;
  g.fillStyle = side === "A" ? COLORS.del : COLORS.add;
  for (const r of side === "A" ? e.text.delRects : e.text.insRects) {
    g.fillRect(r.x, r.y, r.w, r.h);
  }
  g.restore();
}

function paintRegions(g, e) {
  if (!S.highlights || !e.regions.length) return;
  g.save();
  g.strokeStyle = COLORS.chg;
  g.lineWidth = Math.max(1.5, e.w / 800);
  g.setLineDash([7, 5]);
  for (const r of e.regions) g.strokeRect(r.x + 0.5, r.y + 0.5, r.w, r.h);
  g.restore();
}

/* ---------- status, summary, legend, text panel ---------- */

function updateStatus() {
  const e = S.cache.get(S.pageIndex);
  if (!e) { els.status.textContent = ""; return; }
  const bits = [];
  const p = S.pairs[S.pageIndex];
  if (p.a != null && p.b != null && p.a !== p.b) bits.push(pairLong(p));
  if (e.pa == null) bits.push("this page exists only in the new file");
  else if (e.pb == null) bits.push("this page exists only in the old file");
  else if (!e.regions.length && !e.text.delCount && !e.text.insCount && !e.text.overflow) {
    bits.push("no differences on this page");
  } else {
    if (e.regions.length) bits.push(`${e.regions.length} changed region${e.regions.length === 1 ? "" : "s"}`);
    if (e.text.overflow) bits.push("text rewritten (too much to align word-by-word)");
    else if (e.text.delCount || e.text.insCount) bits.push(`−${e.text.delCount} +${e.text.insCount} words`);
  }
  els.status.textContent = bits.join(" · ");
}

function updateSummary() {
  if (!S.scan.length) { els.summary.textContent = ""; return; }
  const done = S.scan.filter((s) => s.status !== "pending").length;
  const diff = S.scan.filter((s) => s.status !== "pending" && s.status !== "same").length;
  const realigned = S.pairs.some((p) => p.a != null && p.b != null && p.a !== p.b);
  let text = done < S.scan.length
    ? `scanning… ${done} / ${S.scan.length}${diff ? ` · ${diff} differ so far` : ""}`
    : diff === 0
      ? "no differences found — the files render identically"
      : `${diff} of ${S.scan.length} page${S.scan.length === 1 ? "" : "s"} differ${diff === 1 ? "s" : ""}`;
  if (realigned && done === S.scan.length) text += " · pages realigned";
  els.summary.textContent = text;
}

function legendItem(swatchClass, label) {
  const item = document.createElement("span");
  item.className = "legend-item";
  const sw = document.createElement("span");
  sw.className = `swatch ${swatchClass}`;
  item.appendChild(sw);
  item.appendChild(document.createTextNode(label));
  return item;
}

function updateLegend() {
  els.legend.replaceChildren();
  if (S.mode === "swipe") {
    els.legend.textContent = "drag the divider — old on the left, new on the right";
    return;
  }
  if (S.mode === "overlay") {
    els.legend.appendChild(legendItem("sdel", "ink only in old (removed)"));
    els.legend.appendChild(legendItem("sins", "ink only in new (added)"));
    els.legend.appendChild(document.createTextNode(" dark = unchanged"));
    return;
  }
  els.legend.appendChild(legendItem("sdel", "removed words"));
  els.legend.appendChild(legendItem("sins", "added words"));
  els.legend.appendChild(legendItem("schg", "changed region"));
}

function buildTextPanel(e) {
  const t = e.text;
  els.text.replaceChildren();
  const span = (cls, s) => {
    const el = document.createElement("span");
    if (cls) el.className = cls;
    el.textContent = s;
    return el;
  };
  els.textsummary.textContent = t.delCount || t.insCount
    ? `text changes on this page (−${t.delCount} +${t.insCount} words)`
    : "text changes on this page";
  if (t.none) {
    els.text.appendChild(span("tmuted", "no text layer on this page — pixel comparison only."));
    return;
  }
  if (t.overflow) {
    els.text.appendChild(span("tmuted", "the text differs too much to align word-by-word."));
    return;
  }
  if (!t.delCount && !t.insCount) {
    els.text.appendChild(span("tmuted", "no text changes on this page."));
    return;
  }
  const CONTEXT = 6;
  for (const o of t.ops) {
    if (o.t === "=") {
      const words = t.wordsB.slice(o.bi, o.bi + o.n).map((w) => w.s);
      if (words.length > CONTEXT * 2 + 4) {
        els.text.appendChild(span("", words.slice(0, CONTEXT).join(" ") + " "));
        els.text.appendChild(span("tmuted", `⋯ ${words.length - CONTEXT * 2} unchanged words ⋯`));
        els.text.appendChild(span("", " " + words.slice(-CONTEXT).join(" ") + " "));
      } else {
        els.text.appendChild(span("", words.join(" ") + " "));
      }
    } else if (o.t === "-") {
      els.text.appendChild(span("tdel", t.wordsA.slice(o.ai, o.ai + o.n).map((w) => w.s).join(" ")));
      els.text.appendChild(span("", " "));
    } else {
      els.text.appendChild(span("tins", t.wordsB.slice(o.bi, o.bi + o.n).map((w) => w.s).join(" ")));
      els.text.appendChild(span("", " "));
    }
  }
}

/* ---------- built-in sample pair (generated locally) ---------- */

function samplePdfBytes(version) {
  const m = S.mupdf;
  const doc = new m.PDFDocument();
  try {
    const res = doc.newDictionary();
    const fonts = doc.newDictionary();
    fonts.put("F0", doc.addSimpleFont(new m.Font("Helvetica")));
    fonts.put("F1", doc.addSimpleFont(new m.Font("Helvetica-Bold")));
    res.put("Font", fonts);
    const esc = (s) => s.replace(/[\\()]/g, (c) => "\\" + c);
    const T = (f, size, x, y, s) => `BT /${f} ${size} Tf ${x} ${y} Td (${esc(s)}) Tj ET\n`;
    const page = (content) => doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, content));

    // version 2 gains a cover page — exercises the page realignment
    if (version === 2) {
      let p0 = T("F1", 26, 72, 700, "TRAVEL POLICY");
      p0 += T("F0", 13, 72, 660, "Cover sheet added in the new revision.");
      page(p0);
    }

    let p1 = T("F1", 22, 72, 716, "ACME LOGISTICS - TRAVEL POLICY");
    p1 += "72 700 468 2 re f\n";
    const rows = version === 1 ? [
      "Effective date: January 2026",
      "Daily meal allowance: USD 45",
      "Hotel cap: USD 180 per night",
      "Approval: manager signature required",
      "Flights: economy class only",
    ] : [
      "Effective date: March 2026",
      "Daily meal allowance: USD 60",
      "Hotel cap: USD 180 per night",
      "Approval: self-serve below USD 500",
      "Flights: economy class only",
      "New: rail travel is always pre-approved",
    ];
    let y = 640;
    for (const r of rows) { p1 += T("F0", 14, 72, y, r); y -= 34; }
    p1 += T("F0", 10, 72, 80, `fake sample document - version ${version} - generated locally by redacat`);
    page(p1);

    let p2 = T("F1", 18, 72, 716, "APPENDIX A - DEFINITIONS");
    for (let k = 0; k < 6; k++) {
      p2 += T("F0", 12, 72, 660 - k * 28, `${k + 1}. This clause is identical in both versions of the document.`);
    }
    page(p2);

    const buf = doc.saveToBuffer("compress=yes");
    const bytes = buf.asUint8Array().slice();
    buf.destroy?.();
    return bytes;
  } finally {
    try { doc.destroy(); } catch {}
  }
}

/* ---------- wiring ---------- */

els.openBtn.addEventListener("click", showCompare);
els.close.addEventListener("click", closeCompare);

for (const side of ["A", "B"]) {
  const slot = els.slotEl[side];
  const input = els.slotInput[side];
  slot.addEventListener("click", () => input.click());
  slot.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); }
  });
  input.addEventListener("change", () => {
    if (input.files[0]) openSideFile(side, input.files[0]);
    input.value = "";
  });
  slot.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
    slot.classList.add("dragover");
  });
  slot.addEventListener("dragleave", () => slot.classList.remove("dragover"));
  slot.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    slot.classList.remove("dragover");
    const f = e.dataTransfer.files[0];
    if (f) openSideFile(side, f);
  });
}

// drops anywhere else while comparing: two files fill both sides, one file
// fills the first empty slot
window.addEventListener("drop", (e) => {
  if (!S.active) return;
  e.preventDefault();
  const files = [...e.dataTransfer.files];
  if (files.length >= 2) openPair(files[0], files[1]);
  else if (files.length === 1) {
    const side = !S.A ? "A" : !S.B ? "B" : null;
    if (side) openSideFile(side, files[0]);
  }
});

els.swap.addEventListener("click", async () => {
  if (!S.A || !S.B) return;
  [S.A, S.B] = [S.B, S.A];
  invalidateCompare();
  updateSlots();
  await beginCompare();
});

els.sample.addEventListener("click", async () => {
  try {
    await ensureEngine();
    await busy("writing the sample pair…");
    const v1 = samplePdfBytes(1);
    const v2 = samplePdfBytes(2);
    unbusy();
    await openSideBytes("A", "policy-v1.pdf", v1);
    await openSideBytes("B", "policy-v2.pdf", v2);
  } catch (err) {
    unbusy();
    alert(`Couldn't build the sample.\n\n${err.message || err}`);
  }
});

els.modes.addEventListener("click", (e) => {
  const btn = e.target.closest(".tool");
  if (!btn) return;
  S.mode = btn.dataset.mode;
  for (const b of els.modes.querySelectorAll(".tool")) {
    const on = b === btn;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  }
  drawViews();
});

els.hl.addEventListener("click", () => {
  S.highlights = !S.highlights;
  els.hl.classList.toggle("on", S.highlights);
  els.hl.setAttribute("aria-pressed", String(S.highlights));
  drawViews();
});

els.prev.addEventListener("click", () => cGotoPage(S.pageIndex - 1));
els.next.addEventListener("click", () => cGotoPage(S.pageIndex + 1));

window.addEventListener("keydown", (e) => {
  if (els.compare.hidden || !els.busy.hidden) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  if (e.key === "ArrowLeft") { e.preventDefault(); cGotoPage(S.pageIndex - 1); }
  else if (e.key === "ArrowRight") { e.preventDefault(); cGotoPage(S.pageIndex + 1); }
});

let swiping = false;
els.cvO.addEventListener("pointerdown", (e) => {
  if (S.mode !== "swipe" || e.button !== 0) return;
  swiping = true;
  els.cvO.setPointerCapture(e.pointerId);
  moveSwipe(e);
});
els.cvO.addEventListener("pointermove", (e) => { if (swiping) moveSwipe(e); });
els.cvO.addEventListener("pointerup", () => { swiping = false; });
function moveSwipe(e) {
  const r = els.cvO.getBoundingClientRect();
  S.swipeX = Math.min(0.98, Math.max(0.02, (e.clientX - r.left) / r.width));
  drawViews();
}

els.download.addEventListener("click", () => {
  const e = S.cache.get(S.pageIndex);
  if (!e || !S.A || !S.B) return;
  const pad = 14, header = 30;
  const out = document.createElement("canvas");
  const sideBySide = S.mode === "side";
  out.width = sideBySide ? e.w * 2 + pad * 3 : e.w + pad * 2;
  out.height = e.h + header + pad * 2;
  const g = out.getContext("2d");
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, out.width, out.height);
  g.fillStyle = "#141412";
  g.font = `700 ${Math.max(12, Math.round(e.w / 70))}px ui-monospace, Menlo, monospace`;
  const title = `${S.A.name}  vs  ${S.B.name} — ${pairLong(S.pairs[S.pageIndex])} (${S.mode === "side" ? "side by side" : S.mode})`;
  g.fillText(title, pad, header - 8, out.width - pad * 2);
  if (sideBySide) {
    g.drawImage(els.cvA, pad, header + pad);
    g.drawImage(els.cvB, e.w + pad * 2, header + pad);
  } else {
    g.drawImage(els.cvO, pad, header + pad);
  }
  out.toBlob((blob) => {
    if (!blob) { alert("Export failed — the diff image may be too large for this browser."); return; }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${baseName(S.A.name)}-vs-${baseName(S.B.name)}.page${S.pageIndex + 1}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }, "image/png");
});

// entry point for app.js: two files dropped on the landing dropzone
window.__redacatCompareOpen = async (files) => {
  showCompare();
  if (files?.length >= 2) await openPair(files[0], files[1]);
};

/* ---------- test hook (harmless in production: everything is client-side anyway) ---------- */

window.__redacatCompare = {
  state: S,
  gotoPage: cGotoPage,
  openBytes: openSideBytes,
  show: showCompare,
  close: closeCompare,
};
