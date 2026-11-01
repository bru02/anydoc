export interface ExtractOptions {
  /** Default 64 MiB. Checked before reading the input. */
  maxBytes?: number;
  /** Default 1M UTF-16 units; supplementary characters are never split. */
  maxChars?: number;
  /** Default 1000. PDF pages are processed in batches of eight. */
  maxPages?: number;
}

export type ExtractionResult =
  | { status: "ok"; text: string; sourceChars?: number; partial?: boolean; detail?: string }
  | { status: "unsupported" | "too-large" | "extraction-failed" | "needs-ocr"; detail?: string };

export function isAvailable(): boolean;
/** Accepts an absolute local path or file:// URL. Always runs off the JS/UI thread. */
export function extractFile(path: string, filename: string, options?: ExtractOptions): Promise<ExtractionResult>;
