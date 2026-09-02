// Generates the PDF fixture zoo in tests/fixtures/.
// Deliberately awkward files: rotated pages, CropBox offsets, encryption,
// embedded images, zero pages, corrupt bytes, multi-page secrets.
import { PDFDocument, StandardFonts, rgb, degrees } from "pdf-lib";
import * as mupdf from "mupdf";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Deliberately fake password for the generated, gitignored test PDF.
// Not a credential for anything — do not "rotate", there is nothing to rotate.
export const FIXTURE_PW = "fake-test-password-not-a-real-secret";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
fs.mkdirSync(DIR, { recursive: true });
const write = (name, bytes) => {
  fs.writeFileSync(path.join(DIR, name), bytes);
  console.log("wrote", name, bytes.length, "bytes");
};

async function newDoc() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  return { doc, font };
}

// ---- basic.pdf: 2 pages, one secret per page at known coordinates ----
{
  const { doc, font } = await newDoc();
  const p1 = doc.addPage([612, 792]);
  p1.drawText("PAGE ONE HEADER", { x: 72, y: 720, size: 20, font });
  p1.drawText("TOP-SECRET-ALPHA", { x: 72, y: 600, size: 14, font }); // fitz y = 792-600 = 192
  p1.drawText("public line one stays", { x: 72, y: 560, size: 14, font });
  const p2 = doc.addPage([612, 792]);
  p2.drawText("TOP-SECRET-BRAVO", { x: 72, y: 700, size: 14, font }); // fitz y = 92
  p2.drawText("public line two stays", { x: 72, y: 660, size: 14, font });
  write("basic.pdf", await doc.save());
}

// ---- rotated90.pdf / rotated270.pdf: pages with /Rotate set ----
for (const rot of [90, 270]) {
  const { doc, font } = await newDoc();
  const p = doc.addPage([612, 792]);
  p.setRotation(degrees(rot));
  p.drawText(`ROTATE-SECRET-${rot}`, { x: 100, y: 400, size: 16, font });
  p.drawText("rotated public text", { x: 100, y: 300, size: 16, font });
  write(`rotated${rot}.pdf`, await doc.save());
}

// ---- cropbox.pdf: CropBox smaller than and offset from MediaBox ----
{
  const { doc, font } = await newDoc();
  const p = doc.addPage([612, 792]);
  p.setCropBox(50, 100, 350, 400); // x, y, w, h from bottom-left
  p.drawText("CROP-SECRET-KILO", { x: 100, y: 350, size: 14, font });
  p.drawText("crop public text", { x: 100, y: 300, size: 14, font });
  write("cropbox.pdf", await doc.save());
}

// ---- fivepages.pdf: secrets scattered on pages 1, 3, 5 (twice on 3) ----
{
  const { doc, font } = await newDoc();
  for (let i = 1; i <= 5; i++) {
    const p = doc.addPage([612, 792]);
    p.drawText(`Page ${i} public content`, { x: 72, y: 700, size: 14, font });
    if (i === 1) p.drawText("MULTI-SECRET here", { x: 72, y: 600, size: 14, font });
    if (i === 3) {
      p.drawText("first MULTI-SECRET on page three", { x: 72, y: 600, size: 14, font });
      p.drawText("second MULTI-SECRET on page three", { x: 72, y: 560, size: 14, font });
    }
    if (i === 5) p.drawText("MULTI-SECRET again", { x: 72, y: 500, size: 14, font });
  }
  write("fivepages.pdf", await doc.save());
}

// ---- imagepdf.pdf: an embedded raster image plus a caption ----
{
  // make a small colorful PNG by rendering a vector page through mupdf
  const { doc: tmp } = await newDoc();
  const tp = tmp.addPage([64, 64]);
  tp.drawRectangle({ x: 0, y: 0, width: 64, height: 64, color: rgb(0.9, 0.2, 0.1) });
  tp.drawRectangle({ x: 32, y: 0, width: 32, height: 64, color: rgb(0.1, 0.3, 0.9) });
  const tmpDoc = mupdf.Document.openDocument(await tmp.save(), "application/pdf");
  const pix = tmpDoc.loadPage(0).toPixmap(mupdf.Matrix.scale(4, 4), mupdf.ColorSpace.DeviceRGB, false, true);
  const pngBytes = pix.asPNG();

  const { doc, font } = await newDoc();
  const png = await doc.embedPng(pngBytes);
  const p = doc.addPage([612, 792]);
  // image occupies x 100..400, pdf y 400..700  => fitz y 92..392
  p.drawImage(png, { x: 100, y: 400, width: 300, height: 300 });
  p.drawText("image caption text", { x: 100, y: 360, size: 14, font });
  write("imagepdf.pdf", await doc.save());
}

// ---- protected.pdf: AES-128, locked with the fake fixture password ----
{
  const basic = fs.readFileSync(path.join(DIR, "basic.pdf"));
  const doc = mupdf.Document.openDocument(basic, "application/pdf");
  const out = doc.saveToBuffer(`encrypt=aes-128,user-password=${FIXTURE_PW},owner-password=${FIXTURE_PW},permissions=-4`);
  write("protected.pdf", out.asUint8Array());
  const check = mupdf.Document.openDocument(out.asUint8Array().slice(), "application/pdf");
  if (!check.needsPassword()) throw new Error("protected.pdf is not actually encrypted!");
  if (check.authenticatePassword(FIXTURE_PW) === 0) throw new Error("password mismatch");
}

// ---- giant.pdf: 5000×5000pt page (25 MP at 1x — must be down-scaled) ----
{
  const { doc, font } = await newDoc();
  const p = doc.addPage([5000, 5000]);
  p.drawText("GIANT-SECRET", { x: 200, y: 4700, size: 120, font });
  p.drawText("giant public text", { x: 200, y: 4400, size: 120, font });
  write("giant.pdf", await doc.save());
}

// ---- badmedia.pdf: MediaBox [0 0 0 0] (mupdf normalizes to letter) ----
{
  const raw = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 0 0] >> endobj
trailer << /Size 4 /Root 1 0 R >>
%%EOF`;
  write("badmedia.pdf", Buffer.from(raw, "latin1"));
}

// ---- zero.svg: image with zero intrinsic dimensions ----
write("zero.svg", Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0"></svg>`));

// ---- hidden.pdf: text that is invisible on screen but fully extractable ----
{
  const { doc, font } = await newDoc();
  const p = doc.addPage([612, 792]);
  // classic fake redaction: text with an opaque box drawn on top of it
  p.drawText("HIDDEN-UNDER-BOX", { x: 72, y: 600, size: 14, font });
  p.drawRectangle({ x: 65, y: 590, width: 220, height: 30, color: rgb(0, 0, 0) });
  // white-on-white text
  p.drawText("WHITE-ON-WHITE", { x: 72, y: 500, size: 14, font, color: rgb(1, 1, 1) });
  p.drawText("hidden fixture public line", { x: 72, y: 400, size: 14, font });
  write("hidden.pdf", await doc.save());
}

// ---- corrupt.pdf: deterministic garbage bytes ----
{
  const junk = Buffer.alloc(4096);
  for (let i = 0; i < junk.length; i++) junk[i] = (i * 197 + 13) & 0xff;
  write("corrupt.pdf", junk);
}

// ---- zeropage.pdf: structurally valid, zero pages ----
{
  const raw = `%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [] /Count 0 >>
endobj
trailer
<< /Size 3 /Root 1 0 R >>
%%EOF
`;
  write("zeropage.pdf", Buffer.from(raw, "latin1"));
  const check = mupdf.Document.openDocument(fs.readFileSync(path.join(DIR, "zeropage.pdf")), "application/pdf");
  console.log("zeropage.pdf opens with", check.countPages(), "pages (want 0)");
}

// ---- diffv1.pdf / diffv2.pdf: a version pair with known differences ----
// page 1: one changed word + one added line;  page 2: identical;
// page 3: changed sentence;  page 4: exists only in v2.
{
  const mk = async (version) => {
    const { doc, font } = await newDoc();
    const p1 = doc.addPage([612, 792]);
    p1.drawText("DIFF FIXTURE TITLE", { x: 72, y: 720, size: 20, font });
    p1.drawText(
      version === 1 ? "amount due USD-250000 total" : "amount due USD-275000 total",
      { x: 72, y: 600, size: 14, font },
    );
    p1.drawText("shared line stays identical", { x: 72, y: 560, size: 14, font });
    if (version === 2) p1.drawText("ADDED-LINE-V2 appears here", { x: 72, y: 520, size: 14, font });
    const p2 = doc.addPage([612, 792]);
    p2.drawText("identical second page", { x: 72, y: 700, size: 14, font });
    const p3 = doc.addPage([612, 792]);
    p3.drawText(
      version === 1 ? "third page with OBSOLETE-CLAUSE inside" : "third page with nothing special",
      { x: 72, y: 700, size: 14, font },
    );
    if (version === 2) {
      const p4 = doc.addPage([612, 792]);
      p4.drawText("appendix page only in v2", { x: 72, y: 700, size: 14, font });
    }
    return doc.save();
  };
  write("diffv1.pdf", await mk(1));
  write("diffv2.pdf", await mk(2));
}

// ---- shiftv1.pdf / shiftv2.pdf: v2 inserts a cover page at the front ----
// Without page alignment every page after the cover would look "changed".
// Expected pairing: +cover, p1<->p2 same, p2<->p3 changed (one word), p3<->p4 same.
{
  const pageOf = (doc, font, lines) => {
    const p = doc.addPage([612, 792]);
    let y = 700;
    for (const l of lines) { p.drawText(l, { x: 72, y, size: 14, font }); y -= 40; }
  };
  const chapters = (mid) => [
    ["CHAPTER ONE shared opening", "the quick brown fox jumps", "over the lazy dog daily"],
    ["CHAPTER TWO results section", `the ${mid} measurement was stable`, "across all trials we observed"],
    ["CHAPTER THREE conclusion", "we conclude nothing surprising", "future work remains open"],
  ];
  {
    const { doc, font } = await newDoc();
    for (const lines of chapters("original")) pageOf(doc, font, lines);
    write("shiftv1.pdf", await doc.save());
  }
  {
    const { doc, font } = await newDoc();
    pageOf(doc, font, ["COVER SHEET brand new frontmatter", "inserted only in version two"]);
    for (const lines of chapters("revised")) pageOf(doc, font, lines);
    write("shiftv2.pdf", await doc.save());
  }
}

// ---- reflowv1.pdf / reflowv2.pdf: same sentences, different pagination ----
// v2 repaginates (a sentence moves from page 1 to page 2), v1 hyphenates
// "infor-mation" across lines, and exactly ONE word changes
// (efficiency -> throughput). Every page also carries a running head and a
// page number. The per-page views see changes everywhere; the document text
// view must report exactly the one changed word.
{
  const HEAD = "REFLOW REPORT - INTERNAL";
  const pageOf = (doc, font, lines, num) => {
    const p = doc.addPage([612, 792]);
    p.drawText(HEAD, { x: 72, y: 740, size: 10, font });
    let y = 690;
    for (const l of lines) { p.drawText(l, { x: 72, y, size: 14, font }); y -= 34; }
    p.drawText(String(num), { x: 300, y: 60, size: 10, font });
  };
  {
    const { doc, font } = await newDoc();
    pageOf(doc, font, [
      "The pipeline ingests raw sensor data and normalizes it",
      "before the model consumes it for training purposes.",
      "Careful batching improves overall efficiency of the infor-",
      "mation processing stage in production deployments.",
    ], 1);
    pageOf(doc, font, [
      "A second phase validates the outputs against golden data.",
      "Alerts fire when drift exceeds the configured threshold.",
    ], 2);
    pageOf(doc, font, ["Final page content stays identical in both versions."], 3);
    write("reflowv1.pdf", await doc.save());
  }
  {
    const { doc, font } = await newDoc();
    pageOf(doc, font, [
      "The pipeline ingests raw sensor data and normalizes it",
      "before the model consumes it for training purposes.",
      "Careful batching improves overall throughput of the information",
    ], 1);
    pageOf(doc, font, [
      "processing stage in production deployments.",
      "A second phase validates the outputs against golden data.",
    ], 2);
    pageOf(doc, font, [
      "Alerts fire when drift exceeds the configured threshold.",
      "Final page content stays identical in both versions.",
    ], 3);
    write("reflowv2.pdf", await doc.save());
  }
}

// ---- movev1.pdf / movev2.pdf: a paragraph relocates, nothing is edited ----
// Paragraph order A, B, C becomes A, C, B (B also lands on a different page).
// B is deliberately the shortest paragraph so the minimal edit is "B moved"
// rather than "C moved". The text view must report a move, not a deletion
// plus an insertion.
{
  const A = ["Alpha paragraph opens the report with the usual framing sentence.",
             "It then restates the goal of the quarter in plain words."];
  const B = ["Bravo paragraph holds the budget numbers that finance signed off on twice."];
  const C = ["Charlie paragraph closes with next steps and the owner of each one.",
             "Every owner confirmed their step before the report was circulated."];
  const mk = async (order) => {
    const { doc, font } = await newDoc();
    let p = doc.addPage([612, 792]);
    let y = 700, n = 0;
    for (const para of order) {
      for (const line of para) {
        if (n === 3) { p = doc.addPage([612, 792]); y = 700; } // page break after 3 lines
        p.drawText(line, { x: 72, y, size: 13, font });
        y -= 34; n++;
      }
    }
    return doc.save();
  };
  write("movev1.pdf", await mk([A, B, C]));
  write("movev2.pdf", await mk([A, C, B]));
}

console.log("fixtures done.");
