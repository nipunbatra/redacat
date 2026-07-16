// Redacat — client-side redaction for images & PDFs.
// Images: canvas re-encode (drops EXIF). PDFs: true content removal via MuPDF WASM.

const $ = (id) => document.getElementById(id);

const els = {
  intro: $("intro"), editor: $("editor"), drop: $("drop"), file: $("file"),
  sample: $("sample"), fname: $("fname"), tools: $("tools"),
  strengthwrap: $("strengthwrap"), strength: $("strength"),
  pager: $("pager"), prev: $("prev"), next: $("next"), pageinfo: $("pageinfo"),
  undo: $("undo"), clear: $("clear"), newfile: $("newfile"), download: $("download"),
  toolnote: $("toolnote"), cv: $("cv"), status: $("status"),
  busy: $("busy"), busytext: $("busytext"),
  searchbar: $("searchbar"), searchtext: $("searchtext"),
  searchbtn: $("searchbtn"), searchinfo: $("searchinfo"),
};

const ctx = els.cv.getContext("2d");

const state = {
  kind: null,            // "image" | "pdf"
  filename: "",
  base: null,            // image mode: ImageBitmap/canvas at full resolution
  mupdf: null,
  doc: null,
  pdfBytes: null,        // pristine copy of the loaded PDF
  pdfPassword: null,     // remembered so export can reopen the file
  pageCount: 1,
  pageIndex: 0,
  pages: [],             // pdf page render cache: ImageBitmap per page
  meta: [],              // pdf page geometry cache: {bounds, scale}, frozen per page at first touch
  rects: [[]],           // per-page marks: {x,y,w,h,mode,strength} in content px
  undoStack: [],
  tool: "black",
  strength: 5,
  selected: null,        // index into current page's marks
  composite: null,       // offscreen canvas: base + marks applied, content resolution
  viewScale: 1,
  drag: null,
};

const TOOL_NOTES = {
  blur: "note: blur and pixelation can sometimes be reversed for text — use █ bar for anything written.",
  pixelate: "note: blur and pixelation can sometimes be reversed for text — use █ bar for anything written.",
  erase: "erase deletes everything under the box from the PDF itself, leaving blank paper.",
  black_pdf: "text and graphics under the bar are deleted from the PDF on download — not just covered.",
};

/* ---------- helpers ---------- */

function busy(text) {
  els.busytext.textContent = text;
  els.busy.hidden = false;
  // let the overlay paint before heavy synchronous work
  return new Promise((r) => setTimeout(r, 30));
}
function unbusy() { els.busy.hidden = true; }

function content() {
  const src = state.kind === "image" ? state.base : state.pages[state.pageIndex];
  return { cw: src.width, ch: src.height };
}

function marks() { return state.rects[state.pageIndex]; }

function baseSource() {
  return state.kind === "image" ? state.base : state.pages[state.pageIndex];
}

function download(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function baseName(name) { return name.replace(/\.[^.]+$/, ""); }

/* ---------- mark rendering (shared by preview and image export) ---------- */

function blurRegion(target, src, r, radius) {
  const pad = Math.ceil(radius * 2) + 2;
  const t = document.createElement("canvas");
  t.width = Math.ceil(r.w + pad * 2);
  t.height = Math.ceil(r.h + pad * 2);
  const tc = t.getContext("2d");
  tc.filter = `blur(${radius}px)`;
  tc.drawImage(src, pad - r.x, pad - r.y);
  target.drawImage(t, pad, pad, r.w, r.h, r.x, r.y, r.w, r.h);
}

function pixelateRegion(target, src, r, cell) {
  const sw = Math.max(1, Math.round(r.w / cell));
  const sh = Math.max(1, Math.round(r.h / cell));
  const t = document.createElement("canvas");
  t.width = sw; t.height = sh;
  const tc = t.getContext("2d");
  // high-quality downsampling averages each cell; the default can pass
  // near-original colors through, which weakens the mosaic
  tc.imageSmoothingEnabled = true;
  tc.imageSmoothingQuality = "high";
  tc.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, sw, sh);
  target.save();
  target.imageSmoothingEnabled = false;
  target.drawImage(t, 0, 0, sw, sh, r.x, r.y, r.w, r.h);
  target.restore();
}

function applyMark(target, src, m) {
  if (m.mode === "black") {
    target.fillStyle = "#141412";
    target.fillRect(m.x, m.y, m.w, m.h);
  } else if (m.mode === "white" || m.mode === "erase") {
    target.fillStyle = "#ffffff";
    target.fillRect(m.x, m.y, m.w, m.h);
  } else if (m.mode === "blur") {
    const radius = Math.max(4, (m.strength * Math.min(m.w, m.h)) / 30);
    blurRegion(target, src, m, radius);
  } else if (m.mode === "pixelate") {
    const cell = Math.max(4, Math.round((m.strength * Math.min(m.w, m.h)) / 24));
    pixelateRegion(target, src, m, cell);
  }
}

function rebuildComposite() {
  const { cw, ch } = content();
  if (!state.composite) state.composite = document.createElement("canvas");
  const c = state.composite;
  if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
  const cc = c.getContext("2d");
  cc.clearRect(0, 0, cw, ch);
  cc.drawImage(baseSource(), 0, 0);
  for (const m of marks()) applyMark(cc, baseSource(), m);
}

/* ---------- view ---------- */

function layoutCanvas() {
  const { cw, ch } = content();
  const dpr = window.devicePixelRatio || 1;
  const wrap = els.cv.parentElement;
  wrap.style.maxWidth = `${Math.ceil(cw / dpr) + 2}px`;
  wrap.style.marginInline = "auto";
  const displayW = els.cv.clientWidth || wrap.clientWidth - 2 || 956;
  els.cv.width = Math.max(1, Math.round(displayW * dpr));
  els.cv.height = Math.max(1, Math.round(els.cv.width * (ch / cw)));
  state.viewScale = els.cv.width / cw;
}

function render() {
  const s = state.viewScale;
  ctx.setTransform(s, 0, 0, s, 0, 0);
  ctx.clearRect(0, 0, els.cv.width / s, els.cv.height / s);
  ctx.drawImage(state.composite, 0, 0);

  // erase marks on PDFs render as blank paper — outline them so they stay findable
  if (state.kind === "pdf") {
    for (const m of marks()) {
      if (m.mode !== "erase") continue;
      ctx.save();
      ctx.strokeStyle = "#b9b9b3";
      ctx.setLineDash([5 / s, 4 / s]);
      ctx.lineWidth = 1.5 / s;
      ctx.strokeRect(m.x, m.y, m.w, m.h);
      ctx.restore();
    }
  }

  if (state.selected != null && marks()[state.selected]) {
    const m = marks()[state.selected];
    ctx.save();
    ctx.strokeStyle = "#b3261e";
    ctx.lineWidth = 2 / s;
    ctx.setLineDash([6 / s, 4 / s]);
    ctx.strokeRect(m.x - 2 / s, m.y - 2 / s, m.w + 4 / s, m.h + 4 / s);
    ctx.restore();
  }

  if (state.drag) {
    const r = normRect(state.drag);
    ctx.save();
    ctx.fillStyle = "rgba(20,20,18,0.3)";
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeStyle = "#141412";
    ctx.lineWidth = 1.5 / s;
    ctx.setLineDash([5 / s, 4 / s]);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.restore();
  }
}

function refresh() { rebuildComposite(); render(); updateStatus(); }

function updateStatus() {
  const here = marks().length;
  const total = state.rects.reduce((n, r) => n + r.length, 0);
  els.status.textContent = state.kind === "pdf"
    ? `${here} mark${here === 1 ? "" : "s"} on this page · ${total} total`
    : `${here} mark${here === 1 ? "" : "s"}`;
  els.download.disabled = total === 0;
}

/* ---------- pointer interaction ---------- */

function pointerPos(e) {
  const r = els.cv.getBoundingClientRect();
  const { cw, ch } = content();
  return {
    x: Math.min(cw, Math.max(0, ((e.clientX - r.left) / r.width) * cw)),
    y: Math.min(ch, Math.max(0, ((e.clientY - r.top) / r.height) * ch)),
  };
}

function normRect(d) {
  return {
    x: Math.min(d.x0, d.x1), y: Math.min(d.y0, d.y1),
    w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0),
  };
}

els.cv.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  els.cv.setPointerCapture(e.pointerId);
  const p = pointerPos(e);
  state.drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
});

els.cv.addEventListener("pointermove", (e) => {
  if (!state.drag) return;
  const p = pointerPos(e);
  state.drag.x1 = p.x;
  state.drag.y1 = p.y;
  render();
});

els.cv.addEventListener("pointerup", (e) => {
  if (!state.drag) return;
  const r = normRect(state.drag);
  state.drag = null;
  const clickThreshold = Math.min(5 / state.viewScale, 24);
  if (r.w < clickThreshold && r.h < clickThreshold) {
    // click: select topmost mark under the cursor
    const p = pointerPos(e);
    const list = marks();
    state.selected = null;
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (p.x >= m.x && p.x <= m.x + m.w && p.y >= m.y && p.y <= m.y + m.h) {
        state.selected = i;
        break;
      }
    }
    render();
    return;
  }
  if (r.w < 3 || r.h < 3) { render(); return; }
  state.selected = null;
  addMarkAt(state.pageIndex, { ...r, mode: state.tool, strength: state.strength });
});

// single entry point for adding a mark, shared by the pointer path and tests
function addMarkAt(pageIdx, mark) {
  state.rects[pageIdx].push(mark);
  state.undoStack.push({ type: "add", page: pageIdx });
  if (pageIdx === state.pageIndex) refresh(); else updateStatus();
}

/* ---------- toolbar ---------- */

els.tools.addEventListener("click", (e) => {
  const btn = e.target.closest(".tool");
  if (!btn) return;
  state.tool = btn.dataset.tool;
  for (const b of els.tools.querySelectorAll(".tool")) {
    const on = b === btn;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  }
  els.strengthwrap.hidden = !(state.tool === "blur" || state.tool === "pixelate");
  const note = state.tool === "black" && state.kind === "pdf"
    ? TOOL_NOTES.black_pdf : TOOL_NOTES[state.tool];
  els.toolnote.textContent = note || "";
  els.toolnote.hidden = !note;
});

els.strength.addEventListener("input", () => {
  state.strength = Number(els.strength.value);
  const sel = state.selected != null && marks()[state.selected];
  if (sel && (sel.mode === "blur" || sel.mode === "pixelate")) {
    sel.strength = state.strength;
    refresh();
  }
});

els.undo.addEventListener("click", doUndo);
function doUndo() {
  const op = state.undoStack.pop();
  if (!op) return;
  if (op.type === "add") {
    state.rects[op.page].pop();
  } else if (op.type === "remove") {
    state.rects[op.page].splice(op.index, 0, op.mark);
  } else if (op.type === "clear") {
    state.rects[op.page] = op.marks;
  } else if (op.type === "add-many") {
    for (const [pg, count] of op.pages) state.rects[pg].splice(-count, count);
    els.searchinfo.textContent = "";
  }
  state.selected = null;
  const target = op.type === "add-many" ? op.pages[0][0] : op.page;
  if (target !== state.pageIndex) gotoPage(target);
  else refresh();
}

els.clear.addEventListener("click", () => {
  if (!marks().length) return;
  state.undoStack.push({ type: "clear", page: state.pageIndex, marks: marks() });
  state.rects[state.pageIndex] = [];
  state.selected = null;
  refresh();
});

function removeSelected() {
  if (state.selected == null) return;
  const removed = marks().splice(state.selected, 1)[0];
  state.undoStack.push({ type: "remove", page: state.pageIndex, index: state.selected, mark: removed });
  state.selected = null;
  refresh();
}

window.addEventListener("keydown", (e) => {
  if (els.editor.hidden) return;
  if (!els.busy.hidden) return; // the overlay blocks clicks; block keys too
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  if ((e.key === "Backspace" || e.key === "Delete")) { e.preventDefault(); removeSelected(); }
  else if (e.key === "Escape") { state.selected = null; render(); }
  else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); doUndo(); }
});

/* ---------- pages ---------- */

// page geometry without rendering — search and export need this for unvisited pages.
// The scale is measured from the live window at the FIRST touch of each page
// (so late-visited pages render sharp after a resize) and frozen after that
// (so stored mark coordinates on the page stay valid).
// keeps a pathological 14400×14400pt page from becoming a 200-megapixel bitmap
const MAX_PAGE_PIXELS = 16e6;

function computeMeta(doc, i) {
  const bounds = doc.loadPage(i).getBounds();
  const pw = Math.max(1, bounds[2] - bounds[0]);
  const ph = Math.max(1, bounds[3] - bounds[1]);
  const dpr = window.devicePixelRatio || 1;
  const mainW = document.querySelector("main").clientWidth;
  const refWidth = Math.min(958, mainW || 958) * dpr * 1.25;
  let scale = Math.min(3, Math.max(1, refWidth / pw));
  scale = Math.min(scale, Math.sqrt(MAX_PAGE_PIXELS / (pw * ph)));
  scale = Math.max(scale, 16 / Math.min(pw, ph)); // never a zero-pixel render
  return { bounds, scale };
}

function ensureMeta(i) {
  if (!state.meta[i]) state.meta[i] = computeMeta(state.doc, i);
  return state.meta[i];
}

async function rasterize(doc, i, scale) {
  const pix = doc.loadPage(i).toPixmap(
    state.mupdf.Matrix.scale(scale, scale),
    state.mupdf.ColorSpace.DeviceRGB, false, true,
  );
  const png = pix.asPNG();
  pix.destroy();
  return createImageBitmap(new Blob([png], { type: "image/png" }));
}

async function renderPage(i) {
  if (!state.pages[i]) state.pages[i] = await rasterize(state.doc, i, ensureMeta(i).scale);
}

function updatePager() {
  els.pageinfo.textContent = `${state.pageIndex + 1} / ${state.pageCount}`;
  els.prev.disabled = state.pageIndex === 0;
  els.next.disabled = state.pageIndex === state.pageCount - 1;
}

async function gotoPage(i) {
  if (i < 0 || i >= state.pageCount) return;
  if (!state.pages[i]) {
    await busy(`rendering page ${i + 1}…`);
    try { await renderPage(i); }
    catch (err) {
      unbusy();
      alert(`Couldn't render page ${i + 1}.\n\n${err.message || err}`);
      return; // stay on the current page
    }
    unbusy();
  }
  state.pageIndex = i;
  state.selected = null;
  updatePager();
  layoutCanvas();
  refresh();
}

els.prev.addEventListener("click", () => gotoPage(state.pageIndex - 1));
els.next.addEventListener("click", () => gotoPage(state.pageIndex + 1));

/* ---------- find text & redact (PDF) ---------- */

// A redaction tool must never silently under-redact: if a page has more
// matches than we ask mupdf for, abort the whole operation and say so.
const SEARCH_MAX_HITS = 5000;

async function searchAndMark(needle) {
  needle = needle.trim();
  if (!needle || state.kind !== "pdf") return { hits: 0, pages: 0 };
  const tool = state.tool === "erase" ? "erase" : "black";
  await busy(`finding “${needle}”…`);
  // phase 1: collect matches — fallible, touches no state
  const found = []; // [pageIndex, rects[]]
  let hits = 0;
  try {
    for (let i = 0; i < state.pageCount; i++) {
      const results = state.doc.loadPage(i).search(needle, SEARCH_MAX_HITS);
      if (!results.length) continue;
      if (results.length >= SEARCH_MAX_HITS) {
        throw new Error(`Page ${i + 1} has ${SEARCH_MAX_HITS} or more matches — too many to mark reliably. Nothing was marked; try a more specific search.`);
      }
      const { bounds, scale } = ensureMeta(i);
      const pad = 1.5 * scale;
      const rects = [];
      for (const quads of results) {
        hits++;
        // a hit that wraps across lines yields one quad per line — mark each
        for (const q of quads) {
          const xs = [q[0], q[2], q[4], q[6]];
          const ys = [q[1], q[3], q[5], q[7]];
          rects.push({
            x: (Math.min(...xs) - bounds[0]) * scale - pad,
            y: (Math.min(...ys) - bounds[1]) * scale - pad,
            w: (Math.max(...xs) - Math.min(...xs)) * scale + 2 * pad,
            h: (Math.max(...ys) - Math.min(...ys)) * scale + 2 * pad,
            mode: tool,
            strength: state.strength,
          });
        }
      }
      found.push([i, rects]);
    }
  } catch (err) {
    unbusy();
    alert(`Search failed — no marks were added.\n\n${err.message || err}`);
    return { hits: 0, pages: 0, failed: true };
  }
  unbusy();
  // phase 2: commit — pure state mutation, cannot fail halfway
  if (found.length) {
    for (const [i, rects] of found) state.rects[i].push(...rects);
    state.undoStack.push({ type: "add-many", pages: found.map(([i, r]) => [i, r.length]) });
    state.selected = null;
    const first = found[0][0];
    if (first !== state.pageIndex) await gotoPage(first);
    else refresh();
  }
  return { hits, pages: found.length };
}

let searchRunning = false;
async function runSearch() {
  if (searchRunning) return; // the busy overlay blocks clicks but not key-repeat
  searchRunning = true;
  els.searchbtn.disabled = true;
  try {
    const res = await searchAndMark(els.searchtext.value);
    els.searchinfo.textContent = res.failed ? "search failed — nothing marked"
      : !els.searchtext.value.trim() ? ""
      : res.hits === 0 ? "no matches"
      : `marked ${res.hits} match${res.hits === 1 ? "" : "es"} on ${res.pages} page${res.pages === 1 ? "" : "s"}`;
  } finally {
    searchRunning = false;
    els.searchbtn.disabled = false;
  }
}

els.searchbtn.addEventListener("click", runSearch);
els.searchtext.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); runSearch(); }
});

/* ---------- file loading ---------- */

let opening = false;

async function loadFile(file) {
  if (opening) return; // drops/pastes during an in-flight open are ignored
  opening = true;
  try {
    const name = file.name || "pasted-image.png";
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(name);
    try {
      if (isPdf) await openPdf(file, name);
      else await openImage(file, name);
    } catch (err) {
      unbusy();
      alert(`Couldn't open that file.\n\n${err.message || err}`);
      return; // nothing was torn down — whatever was open before stays open
    }
    showEditor(name);
  } finally {
    opening = false;
  }
}

// switch the UI to the editor — only after a successful open
function showEditor(name) {
  els.intro.hidden = true;
  els.editor.hidden = false;
  els.fname.textContent = name;
  els.fname.title = name;
  els.searchbar.hidden = state.kind !== "pdf";
  els.searchtext.value = "";
  els.searchinfo.textContent = "";
  // show only the tools that apply to this file kind
  let firstVisible = null;
  for (const b of els.tools.querySelectorAll(".tool")) {
    const show = b.dataset.for.includes(state.kind);
    b.hidden = !show;
    if (show && !firstVisible) firstVisible = b;
  }
  firstVisible.click();
  if (state.kind === "pdf") updatePager();
  layoutCanvas();
  refresh();
  window.scrollTo({ top: 0 });
}

function resetDoc() {
  if (state.doc) { try { state.doc.destroy(); } catch {} }
  for (const p of state.pages) { try { p?.close?.(); } catch {} }
  if (state.base?.close) { try { state.base.close(); } catch {} }
  state.doc = null;
  state.base = null;
  state.pdfBytes = null;
  state.pdfPassword = null;
  state.pages = [];
  state.meta = [];
  state.rects = [[]];
  state.undoStack = [];
  state.selected = null;
  state.pageIndex = 0;
  state.pageCount = 1;
  state.composite = null;
}

// canvases much beyond this fail or thrash; oversized images are scaled down
const LIMITS = { maxImagePixels: 80e6 };

async function openImage(source, name) {
  await busy("opening image…");
  let bitmap;
  try {
    if (source instanceof HTMLCanvasElement) {
      bitmap = source;
    } else {
      bitmap = await createImageBitmap(source, { imageOrientation: "from-image" });
    }
  } catch {
    // fallback decode path
    const url = URL.createObjectURL(source);
    bitmap = await new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error("Not a supported image format."));
      img.src = url;
    });
  }
  const w = bitmap.width, h = bitmap.height;
  if (!w || !h) throw new Error("That image has zero width or height.");
  if (w * h > LIMITS.maxImagePixels) {
    const s = Math.sqrt(LIMITS.maxImagePixels / (w * h));
    const c = document.createElement("canvas");
    // floor, not round — rounding up can overshoot the pixel budget
    c.width = Math.max(1, Math.floor(w * s));
    c.height = Math.max(1, Math.floor(h * s));
    c.getContext("2d").drawImage(bitmap, 0, 0, c.width, c.height);
    bitmap.close?.();
    bitmap = c;
    alert(`This image is very large (${w}×${h}), which browsers can't edit reliably. It was scaled down to ${c.width}×${c.height} — the redacted copy will be that size.`);
  }
  resetDoc();
  state.kind = "image";
  state.filename = name;
  state.base = bitmap;
  els.pager.hidden = true;
  unbusy();
}

async function loadEngine() {
  if (state.mupdf) return;
  await busy("loading the PDF engine (10 MB, one time)…");
  state.mupdf = await import("../vendor/mupdf/mupdf.js");
}

async function openPdf(file, name) {
  await loadEngine();
  await busy("opening pdf…");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const doc = state.mupdf.Document.openDocument(bytes.slice(), "application/pdf");
  // every fallible step runs BEFORE the current document is torn down, so a
  // failed open can never leave half-swapped state or lose existing marks
  let password = null, pageCount, meta0, bitmap0;
  try {
    if (doc.needsPassword()) {
      unbusy();
      for (let attempt = 0; ; attempt++) {
        if (attempt >= 3) throw new Error("Wrong password (3 attempts).");
        const pw = window.prompt(attempt === 0
          ? "This PDF is password-protected. Enter the password to open it:"
          : "Wrong password — try again:");
        if (pw === null) throw new Error("A password is required to open this PDF.");
        if (doc.authenticatePassword(pw) !== 0) { password = pw; break; }
      }
      await busy("opening pdf…");
    }
    pageCount = doc.countPages();
    if (pageCount === 0) throw new Error("This PDF has no pages.");
    meta0 = computeMeta(doc, 0);
    bitmap0 = await rasterize(doc, 0, meta0.scale);
  } catch (err) {
    try { doc.destroy(); } catch {}
    throw err;
  }
  // commit — pure assignments from here on
  resetDoc();
  state.kind = "pdf";
  state.filename = name;
  state.doc = doc;
  state.pdfBytes = bytes;
  state.pdfPassword = password;
  state.pageCount = pageCount;
  state.rects = Array.from({ length: pageCount }, () => []);
  state.meta[0] = meta0;
  state.pages[0] = bitmap0;
  els.pager.hidden = pageCount === 1;
  unbusy();
}

/* ---------- export ---------- */

els.download.addEventListener("click", async () => {
  if (els.download.disabled) return;
  els.download.disabled = true; // no double-exports from rapid clicks
  if (state.kind === "image") {
    await busy("rebuilding image…");
    rebuildComposite();
    state.composite.toBlob((blob) => {
      unbusy();
      updateStatus();
      if (!blob) { alert("Export failed — the image may be too large for this browser."); return; }
      download(blob, `${baseName(state.filename)}.redacted.png`);
    }, "image/png");
  } else {
    await busy("applying redactions…");
    try {
      const blob = exportPdf();
      unbusy();
      download(blob, `${baseName(state.filename)}.redacted.pdf`);
    } catch (err) {
      unbusy();
      alert(`Redaction failed.\n\n${err.message || err}`);
    } finally {
      updateStatus();
    }
  }
});

function exportPdf() {
  const mupdf = state.mupdf;
  const { PDFPage } = mupdf;
  // work on a fresh copy so the on-screen document stays editable
  const doc = mupdf.Document.openDocument(state.pdfBytes.slice(), "application/pdf");
  try {
    if (doc.needsPassword()) doc.authenticatePassword(state.pdfPassword ?? "");
    for (let i = 0; i < state.pageCount; i++) {
      const list = state.rects[i];
      if (!list || !list.length) continue;
      const info = ensureMeta(i);
      const page = doc.loadPage(i);
      // erase marks leave blank paper; bar marks paint black boxes — both delete content
      for (const pass of [{ mode: "erase", black: false }, { mode: "black", black: true }]) {
        const group = list.filter((m) => m.mode === pass.mode);
        if (!group.length) continue;
        for (const m of group) {
          const a = page.createAnnotation("Redact");
          a.setRect([
            m.x / info.scale + info.bounds[0],
            m.y / info.scale + info.bounds[1],
            (m.x + m.w) / info.scale + info.bounds[0],
            (m.y + m.h) / info.scale + info.bounds[1],
          ]);
          a.update();
        }
        page.applyRedactions(
          pass.black,
          PDFPage.REDACT_IMAGE_PIXELS,
          PDFPage.REDACT_LINE_ART_REMOVE_IF_COVERED,
          PDFPage.REDACT_TEXT_REMOVE,
        );
      }
    }
    // keep the original encryption (and password) on protected files
    const opts = state.pdfPassword != null
      ? "garbage=2,compress=yes,encrypt=keep"
      : "garbage=2,compress=yes";
    const buf = doc.saveToBuffer(opts);
    return new Blob([buf.asUint8Array().slice()], { type: "application/pdf" });
  } finally {
    try { doc.destroy(); } catch {}
  }
}

/* ---------- open / close ---------- */

els.drop.addEventListener("click", () => els.file.click());
els.drop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); els.file.click(); }
});
els.file.addEventListener("change", () => {
  if (els.file.files[0]) loadFile(els.file.files[0]);
  els.file.value = "";
});

window.addEventListener("dragover", (e) => {
  e.preventDefault();
  els.drop.classList.add("dragover");
});
window.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) els.drop.classList.remove("dragover");
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  els.drop.classList.remove("dragover");
  const f = e.dataTransfer.files[0];
  if (f) loadFile(f);
});

window.addEventListener("paste", (e) => {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
  if (item) loadFile(item.getAsFile());
});

els.newfile.addEventListener("click", () => {
  const total = state.rects.reduce((n, r) => n + r.length, 0);
  if (total > 0 && !confirm("Close this file? Marks you drew will be discarded.")) return;
  resetDoc();
  state.kind = null;
  els.editor.hidden = true;
  els.intro.hidden = false;
});

window.addEventListener("resize", () => {
  if (els.editor.hidden || !state.composite) return;
  layoutCanvas();
  render();
});

/* ---------- sample memo (generated locally, obviously fake) ---------- */

els.sample.addEventListener("click", async (e) => {
  e.stopPropagation();
  const c = document.createElement("canvas");
  c.width = 1200; c.height = 820;
  const g = c.getContext("2d");
  g.fillStyle = "#ffffff"; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "#8a8a84"; g.font = "600 20px ui-monospace, Menlo, monospace";
  g.fillText("ACME LOGISTICS PVT. LTD. — HR RECORDS", 70, 78);
  g.fillStyle = "#141412"; g.font = "700 46px system-ui, sans-serif";
  g.fillText("Internal memo — employee file", 70, 150);
  g.fillRect(70, 178, 1060, 4);
  g.font = "26px ui-monospace, Menlo, monospace";
  const lines = [
    ["Employee",     "Jane Q. Doe"],
    ["Employee ID",  "ACME-004521"],
    ["SSN",          "123-45-6789"],
    ["Date of birth","1988-03-14"],
    ["Home address", "42 Nowhere Lane, Faketown 560001"],
    ["Salary",       "$250,000 / year"],
    ["Bank account", "IBAN FK00 REDA CAT0 0042"],
  ];
  let y = 250;
  for (const [k, v] of lines) {
    g.fillStyle = "#8a8a84"; g.fillText(k.padEnd(14, " "), 70, y);
    g.fillStyle = "#141412"; g.fillText(v, 340, y);
    y += 58;
  }
  g.fillStyle = "#8a8a84"; g.font = "20px system-ui, sans-serif";
  g.fillText("This memo is fake and was generated locally by Redacat — try drawing over the SSN.", 70, 740);
  g.save();
  g.translate(980, 300); g.rotate(-0.18);
  g.strokeStyle = "#b3261e"; g.lineWidth = 5; g.strokeRect(-130, -42, 260, 84);
  g.fillStyle = "#b3261e"; g.font = "700 44px ui-monospace, Menlo, monospace";
  g.textAlign = "center"; g.fillText("SAMPLE", 0, 16);
  g.restore();
  await openImage(c, "sample-memo.png");
  showEditor("sample-memo.png");
});

/* ---------- test hook (harmless in production: everything is client-side anyway) ---------- */

window.__redacat = {
  state,
  refresh,
  loadFile,
  LIMITS,
  searchAndMark,
  exportPdf,
  addMark: (pageIdx, m) => addMarkAt(pageIdx, { mode: "black", strength: state.strength, ...m }),
  compositeDataURL: () => state.composite.toDataURL(),
  meta: (i) => ensureMeta(i),
  gotoPage,
};
