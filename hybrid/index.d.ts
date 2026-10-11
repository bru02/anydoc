export interface PageError {
  pageNum: number;
  message: string;
}

export interface MarkdownExtraction {
  text: string;
  pageErrors?: PageError[];
  totalPages?: number;
}

/** Bundled hosts can initialize either module from inlined WASM bytes. */
export function initSync(modules: {
  anydocModule?: Uint8Array;
  liteparseModule?: Uint8Array;
}): void;

/** Convert a document locally, with LiteParse for PDF and AnyDoc otherwise. */
export function extractMarkdownBytes(
  bytes: Uint8Array,
  filename?: string,
): Promise<MarkdownExtraction>;
