import { requireOptionalNativeModule } from "expo";

const native = requireOptionalNativeModule("AnyDoc");

export function isAvailable() {
  return native !== null;
}

/** Only path strings enter native code. Input bytes never cross the JS bridge. */
export async function extractFile(path, filename, options = {}) {
  if (!native) {
    return { status: "extraction-failed", detail: "AnyDoc native module is unavailable. Rebuild your development client; Expo Go is not supported." };
  }
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  const maxChars = options.maxChars ?? 1_000_000;
  const maxPages = options.maxPages ?? 1000;
  const ocr = options.ocr ?? "off";
  if (!["off", "fast", "accurate"].includes(ocr)) throw new RangeError("ocr must be off, fast, or accurate");
  for (const [name, value] of Object.entries({ maxBytes, maxChars, maxPages })) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 0xffffffff) {
      throw new RangeError(`${name} must be a positive integer no greater than 4294967295`);
    }
  }
  // C strings cannot represent embedded NULs. Reject rather than reading a
  // different, silently truncated path on iOS.
  if (typeof path !== "string" || typeof filename !== "string" || path.includes("\0") || filename.includes("\0")) {
    throw new TypeError("Expected path and filename strings without NUL characters");
  }
  return native.extractFile(path, filename, maxBytes, maxChars, maxPages, ["off", "fast", "accurate"].indexOf(ocr));
}
