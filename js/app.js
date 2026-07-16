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
};

const ctx = els.cv.getContext("2d");

const state = {
  kind: null,            // "image" | "pdf"
  filename: "",
  base: null,            // image mode: ImageBitmap/canvas at full resolution
  mupdf: null,
  doc: null,
  pdfBytes: null,        // pristine copy of the loaded PDF
  pageCount: 1,
  pageIndex: 0,
  pages: [],             // pdf page cache: {bitmap, scale, cw, ch, bounds}
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
  if (state.kind === "image") return { cw: state.base.width, ch: state.base.height };
  const p = state.pages[state.pageIndex];
  return { cw: p.cw, ch: p.ch };
}

function marks() { return state.rects[state.pageIndex]; }

function baseSource() {
  if (state.kind === "image") return state.base;
  return state.pages[state.pageIndex].bitmap;
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
  t.getContext("2d").drawImage(src, r.x, r.y, r.w, r.h, 0, 0, sw, sh);
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
  const mark = { ...r, mode: state.tool, strength: state.strength };
  marks().push(mark);
  state.undoStack.push({ type: "add", page: state.pageIndex });
  state.selected = null;
  refresh();
});

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
  }
  state.selected = null;
  if (op.page !== state.pageIndex) gotoPage(op.page);
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
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  if ((e.key === "Backspace" || e.key === "Delete")) { e.preventDefault(); removeSelected(); }
  else if (e.key === "Escape") { state.selected = null; render(); }
  else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); doUndo(); }
});

/* ---------- pages ---------- */

async function renderPage(i) {
  if (state.pages[i]) return;
  const page = state.doc.loadPage(i);
  const bounds = page.getBounds();
  const pw = bounds[2] - bounds[0];
  const dpr = window.devicePixelRatio || 1;
  const wrapW = Math.min(958, els.editor.clientWidth || 958);
  const scale = Math.min(3, Math.max(1, (wrapW * dpr * 1.25) / pw));
  const pix = page.toPixmap(
    state.mupdf.Matrix.scale(scale, scale),
    state.mupdf.ColorSpace.DeviceRGB, false, true,
  );
  const png = pix.asPNG();
  pix.destroy();
  const bitmap = await createImageBitmap(new Blob([png], { type: "image/png" }));
  state.pages[i] = { bitmap, scale, cw: bitmap.width, ch: bitmap.height, bounds };
}

async function gotoPage(i) {
  if (i < 0 || i >= state.pageCount) return;
  state.pageIndex = i;
  state.selected = null;
  if (!state.pages[i]) {
    await busy(`rendering page ${i + 1}…`);
    try { await renderPage(i); } finally { unbusy(); }
  }
  els.pageinfo.textContent = `${i + 1} / ${state.pageCount}`;
  els.prev.disabled = i === 0;
  els.next.disabled = i === state.pageCount - 1;
  layoutCanvas();
  refresh();
}

els.prev.addEventListener("click", () => gotoPage(state.pageIndex - 1));
els.next.addEventListener("click", () => gotoPage(state.pageIndex + 1));

/* ---------- file loading ---------- */

async function loadFile(file) {
  const name = file.name || "pasted-image.png";
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(name);
  // the editor must be visible before layout runs, or the canvas measures 0 wide
  els.intro.hidden = true;
  els.editor.hidden = false;
  try {
    if (isPdf) await openPdf(file, name);
    else await openImage(file, name);
  } catch (err) {
    unbusy();
    resetDoc();
    state.kind = null;
    els.editor.hidden = true;
    els.intro.hidden = false;
    alert(`Couldn't open that file.\n\n${err.message || err}`);
    return;
  }
  els.fname.textContent = name;
  els.fname.title = name;
  // show only the tools that apply to this file kind
  let firstVisible = null;
  for (const b of els.tools.querySelectorAll(".tool")) {
    const show = b.dataset.for.includes(state.kind);
    b.hidden = !show;
    if (show && !firstVisible) firstVisible = b;
  }
  firstVisible.click();
  window.scrollTo({ top: 0 });
}

function resetDoc() {
  if (state.doc) { try { state.doc.destroy(); } catch {} }
  state.doc = null;
  state.base = null;
  state.pdfBytes = null;
  state.pages = [];
  state.rects = [[]];
  state.undoStack = [];
  state.selected = null;
  state.pageIndex = 0;
  state.pageCount = 1;
  state.composite = null;
}

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
  resetDoc();
  state.kind = "image";
  state.filename = name;
  state.base = bitmap;
  els.pager.hidden = true;
  unbusy();
  layoutCanvas();
  refresh();
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
  if (doc.needsPassword()) {
    doc.destroy();
    throw new Error("Password-protected PDFs aren't supported yet.");
  }
  resetDoc();
  state.kind = "pdf";
  state.filename = name;
  state.doc = doc;
  state.pdfBytes = bytes;
  state.pageCount = doc.countPages();
  state.rects = Array.from({ length: state.pageCount }, () => []);
  els.pager.hidden = state.pageCount === 1;
  await renderPage(0);
  unbusy();
  await gotoPage(0);
}

/* ---------- export ---------- */

els.download.addEventListener("click", async () => {
  if (state.kind === "image") {
    await busy("rebuilding image…");
    rebuildComposite();
    state.composite.toBlob((blob) => {
      unbusy();
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
    }
  }
});

function exportPdf() {
  const mupdf = state.mupdf;
  const { PDFPage } = mupdf;
  // work on a fresh copy so the on-screen document stays editable
  const doc = mupdf.Document.openDocument(state.pdfBytes.slice(), "application/pdf");
  try {
    for (let i = 0; i < state.pageCount; i++) {
      const list = state.rects[i];
      if (!list || !list.length) continue;
      const info = state.pages[i];
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
    const buf = doc.saveToBuffer("garbage=2,compress=yes");
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

els.sample.addEventListener("click", (e) => {
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
  els.intro.hidden = true;
  els.editor.hidden = false;
  els.fname.textContent = "sample-memo.png";
  for (const b of els.tools.querySelectorAll(".tool")) b.hidden = !b.dataset.for.includes("image");
  els.tools.querySelector('[data-tool="black"]').click();
  openImage(c, "sample-memo.png");
});
