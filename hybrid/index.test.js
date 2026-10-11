import assert from "node:assert/strict";
import { test } from "node:test";

import { extractMarkdownBytes } from "./index.js";

function pdfWithText(line) {
  const stream = `BT /F1 12 Tf 10 100 Td (${line}) Tj ET\n`;
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
    `<</Length ${stream.length}>>stream\n${stream}endstream`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [];
  for (const [index, body] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj${body}endobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets)
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;

  return new TextEncoder().encode(pdf);
}

test("PDF text is extracted without OCR", async () => {
  const result = await extractMarkdownBytes(pdfWithText("Hello PDF"), "hello.pdf");
  assert.match(result.text, /Hello PDF/);
  assert.equal(result.totalPages, 1);
  assert.deepEqual(result.pageErrors, []);
});

test("whitespace-only PDF does not yield a fake Markdown code block", async () => {
  const result = await extractMarkdownBytes(pdfWithText("   "), "blank.pdf");
  assert.equal(result.text, "");
});

test("RTF still uses AnyDoc", async () => {
  const result = await extractMarkdownBytes(
    new TextEncoder().encode("{\\rtf1\\ansi Hello RTF}"),
    "hello.rtf",
  );
  assert.match(result.text, /Hello RTF/);
  assert.equal(result.totalPages, undefined);
});
