import {
  formatFromBytes,
  formatFromExtension,
  initSync as initAnydocSync,
  toMarkdownBytes as anydocToMarkdownBytes,
} from "@firecrawl/anydoc-wasm";
import {
  LiteParse,
  initSync as initLiteparseSync,
} from "@llamaindex/liteparse-wasm";

let anydocReady = false;
let liteparseReady = false;

/** Initialize the WASM modules from bytes supplied by a bundler such as Raycast. */
export function initSync({ anydocModule, liteparseModule }) {
  if (anydocModule && !anydocReady) {
    initAnydocSync({ module: anydocModule });
    anydocReady = true;
  }
  if (liteparseModule && !liteparseReady) {
    initLiteparseSync({ module: liteparseModule });
    liteparseReady = true;
  }
}

async function ensureWasm(which) {
  if (which === "anydoc" ? anydocReady : liteparseReady) return;

  // Node and Bun load the package's binary lazily. Bundled hosts pass the
  // bytes to initSync instead, so this filesystem branch is never reached.
  const [{ readFile }, { createRequire }] = await Promise.all([
    import("node:fs/promises"),
    import("node:module"),
  ]);
  const specifier =
    which === "anydoc"
      ? "@firecrawl/anydoc-wasm/anydoc_wasm_bg.wasm"
      : "@llamaindex/liteparse-wasm/liteparse_wasm_bg.wasm";
  const bytes = new Uint8Array(
    await readFile(createRequire(import.meta.url).resolve(specifier)),
  );
  initSync(
    which === "anydoc"
      ? { anydocModule: bytes }
      : { liteparseModule: bytes },
  );
}

function extensionOf(filename) {
  const basename = filename.split(/[\\/]/).pop() ?? "";
  const dot = basename.lastIndexOf(".");
  return dot <= 0 ? "" : basename.slice(dot).toLowerCase();
}

// The PDF header may appear within the first 1024 bytes. A filename hint
// covers malformed headers so LiteParse can return a useful parse error.
function isPdf(bytes, filename) {
  const prefix = new TextDecoder("ascii").decode(bytes.subarray(0, 1024));
  return prefix.includes("%PDF-") || extensionOf(filename) === ".pdf";
}

/**
 * Convert a document to Markdown without OCR. PDFs always go through
 * LiteParse, including pages its complexity probe would label as needing
 * OCR. A failed page does not discard text from the remaining pages.
 * Non-PDF formats retain AnyDoc's existing converter and format detection.
 */
export async function extractMarkdownBytes(bytes, filename = "") {
  if (isPdf(bytes, filename)) {
    await ensureWasm("liteparse");
    const parser = new LiteParse({
      ocrEnabled: false,
      outputFormat: "markdown",
      continueOnPageError: true,
    });
    try {
      const result = await parser.parse(bytes);
      // LiteParse can emit an empty fenced block for a page containing only
      // whitespace. Its page text is the reliable signal for searchable text.
      const hasText = result.pages.some((page) => page.text.trim().length > 0);
      return {
        text: hasText ? result.text.trim() : "",
        pageErrors: result.pageErrors,
        totalPages: result.totalPages,
      };
    } finally {
      parser.free();
    }
  }

  await ensureWasm("anydoc");
  const hint =
    extensionOf(filename) === ".csv" && formatFromBytes(bytes) === undefined
      ? formatFromExtension(".csv")
      : undefined;
  return { text: anydocToMarkdownBytes(bytes, hint).trim() };
}
