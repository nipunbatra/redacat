// Shared MuPDF WASM engine loader — one instance serves both the redaction
// editor and the compare view. The vendored module is ~10 MB, so it is
// imported lazily and exactly once.

let promise = null;

export function loadEngine() {
  return (promise ??= import("../vendor/mupdf/mupdf.js"));
}
