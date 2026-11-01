# Native AnyDoc + LiteParse for Expo / React Native

The public hybrid package also provides a native module for iOS 17+ and Android
API 24+, with Expo Modules autolinking. Use a development build, not Expo Go.
React Native projects without Expo need Expo Modules installed first.
Set `ios.deploymentTarget` to at least `"17.0"` in the Expo app config.

```ts
import { extractFile } from '@bru02/anydoc/expo';

const result = await extractFile(file.uri, 'lecture.pdf', {
  maxBytes: 64 * 1024 * 1024,
  maxChars: 1_000_000,
  maxPages: 1000,
  ocr: "accurate", // optional; defaults to "off"
});
if (result.status === 'ok') console.log(result.text, result.partial);
```

Install the pinned package revision, then run `bunx expo prebuild --no-clean`
and build the app normally. CocoaPods and Gradle download checksum-pinned native
artifacts on first installation; subsequent builds link them. No local Rust,
Chromium/PDFium, or C++ parser compilation is required. The small Swift/Kotlin
adapter builds against your app's installed Expo version. Expo SDK 58's own
precompiled modules remain enabled; this package does not override that setting.

## Execution and memory

- JS sends an absolute path or local `file://` URL, filename, and limits. No
  file bytes, base64, or input-sized JS ArrayBuffer crosses the bridge.
- A dedicated serial background queue runs the parser. Rust also serializes
  entry points to bound concurrent memory. Neither parsing nor waiting for the
  parser runs on JS/UI threads.
- PDFs use native LiteParse 2.17.0 and bundled PDFium. PDFium reads the file
  using random access. Without OCR, LiteParse processes eight pages per batch and drops each
  batch before continuing. Text returns once, bounded by `maxChars`; processing
  stops early when this cap is reached. The API does not expose a live text stream.
- Office/RTF/EPUB/CSV use native AnyDoc 0.2.4. Its existing API accepts bytes,
  so it reads the input once into bounded native memory. ZIP/compound containers
  and PDFs require random access; neither is a forward-only byte stream.
- OCR defaults to off. Set `ocr: "fast"` or `ocr: "accurate"` for native,
  on-device OCR of sparse/scanned PDF pages. iOS uses Apple Vision at the
  corresponding recognition level; fast renders at 144 DPI, accurate at 240 DPI.
  Android uses the bundled ML Kit Latin model at those render resolutions
  (ML Kit has no separate fast/accurate engine switch). OCR parses one page per
  batch and runs one recognition job at a time. No images enter JS and no document
  is uploaded; the Android model is included in the app, available offline on
  first use. Other scripts/models are not bundled.
- A failed PDF page preserves other readable pages and marks the result partial.
  Empty/image-only PDFs fail explicitly when OCR is off. Size/page/text caps are reported.
  A native OCR failure also marks retained text partial. If neither OCR nor
  embedded extraction yields text, extraction fails with the recognition error.
- `sourceChars` uses UTF-16 units, matching JS string length. It is omitted when
  a page or early text limit means the complete document length is unknown.
- Batching can change Markdown grouping and running-header removal at batch
  boundaries relative to a whole-document desktop parse. This is not byte-for-byte
  Markdown parity; test your document corpus before relying on its structure.

Both `extractMarkdownBytes` and `extractFile` return Promises, but their execution
is different. AnyDoc **WASM** `toMarkdownBytes` is synchronous CPU work inside the
desktop async wrapper. LiteParse WASM's async API does not itself create a worker.
The Expo entry point never imports either WASM package: the entire conversion
runs on native background threads. Nitro does not remove a useful input copy
here because the API passes paths, not byte arrays; using Expo Modules keeps
autolinking and threading integrated with Expo without another codegen layer.

## Prebuilt artifacts and CI

`.github/workflows/native.yml` runs host parser tests against the pinned LiteParse
PDFium fork, then cross-compiles:

- iOS arm64 device + arm64/x86_64 simulator slices in `AnyDocCore.xcframework`
  and a separate embedded `pdfium.xcframework`;
- Android arm64-v8a, armeabi-v7a, x86_64 and x86 Rust JNI/PDFium libraries, with
  16 KiB LOAD alignment checked for 64-bit ABIs and 4 KiB for 32-bit ABIs;
- upstream and transitive dependency license notices.

It never boots a simulator or emulator. Push a new `native-v*` tag to publish
the artifacts; commit their SHA-256 values to `native/artifacts.json` before
consumers adopt that package revision. Tags/assets must not be overwritten.
PDFium mobile binaries are built from the same pinned LiteParse fork as the desktop engine, with build/source revisions in `native/pdfium.json`. Desktop host-test inputs are pinned by SHA-256. Stock PDFium does not export the fork APIs required by LiteParse and must not be substituted.
Simulator **compilation** is supported without launching a simulator.

For source development, use `bun scripts/build-native.mjs host|ios|android`.
Android source builds require Linux and `ANDROID_NDK_HOME`; iOS requires Xcode.
These commands explicitly rebuild source and are not part of consumer builds.

On-device latency, memory peaks, cancellation, OS background execution,
Android content-provider URIs, and remote URLs are not claimed by this API.
Copy content-provider inputs to an app-owned native file before extraction.
