# AnyDoc with LiteParse PDFs

The root JavaScript package of this fork exposes one async extraction API.
It uses LiteParse WASM 2.15.1 for PDFs, and AnyDoc WASM 0.2.4 for every
other format. OCR is disabled, and the PDF complexity probe is not a gate:
embedded text is extracted even from pages that the probe labels complex.
LiteParse's `continueOnPageError` preserves text from successful pages.

```js
import { extractMarkdownBytes } from "@bru02/anydoc";

const { text, pageErrors } = await extractMarkdownBytes(bytes, "lecture.pdf");
```

Node and Bun load each WASM binary lazily. Hosts that inline binaries, such
as Raycast, should pass both byte arrays to `initSync` at startup. The Rust,
Python, and original WASM APIs remain the upstream AnyDoc implementations.
