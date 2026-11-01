//! File-backed native hybrid parser. Call from a background queue, never JS/UI.
use std::ffi::{CStr, CString, c_char};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex;

use liteparse::types::PdfInput;
use liteparse::{LiteParse, LiteParseConfig, OutputFormat};
use serde::Serialize;

mod ocr;
use ocr::OcrConfig;

// Bound concurrent memory use even when different native hosts call the C ABI.
static PARSE_SLOT: Mutex<()> = Mutex::new(());
const BATCH_PAGES: usize = 8;

/// Limits apply before loading bytes and before returning text across the bridge.
#[derive(Clone, Copy)]
pub struct Limits {
    pub max_bytes: u64,
    pub max_chars: usize,
    pub max_pages: usize,
}

/// Same status contract as the desktop extractor. Page diagnostics stay metadata.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Extraction {
    pub status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_chars: Option<usize>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub partial: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl Extraction {
    fn failure(status: &'static str, detail: impl ToString) -> Self {
        Self {
            status,
            text: None,
            source_chars: None,
            partial: false,
            detail: Some(detail.to_string()),
        }
    }
}

fn local_path(raw: &str) -> Result<PathBuf, String> {
    let path = if raw.starts_with("file:") {
        let url = url::Url::parse(raw).map_err(|e| e.to_string())?;
        if url.host_str().is_some_and(|host| host != "localhost")
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err("Only local file URLs without queries or fragments are accepted".into());
        }
        url.to_file_path().map_err(|_| "Invalid local file URL")?
    } else {
        PathBuf::from(raw)
    };
    if !path.is_absolute() {
        return Err("Expected an absolute path or local file:// URL".into());
    }
    Ok(path)
}

/// Reads from disk directly. PDFium uses random file access, not a JS byte buffer.
pub fn extract_file(raw: &str, filename: &str, pdfium_path: &str, limits: Limits) -> Extraction {
    extract_file_with_ocr(raw, filename, pdfium_path, limits, OcrConfig::default())
}

fn extract_file_with_ocr(
    raw: &str,
    filename: &str,
    pdfium_path: &str,
    limits: Limits,
    ocr: OcrConfig,
) -> Extraction {
    let _slot = PARSE_SLOT.lock().unwrap_or_else(|e| e.into_inner());
    match extract_inner(raw, filename, pdfium_path, limits, ocr) {
        Ok(result) => result,
        Err(detail) => Extraction::failure("extraction-failed", detail),
    }
}

fn extract_inner(
    raw: &str,
    filename: &str,
    pdfium_path: &str,
    limits: Limits,
    ocr: OcrConfig,
) -> Result<Extraction, String> {
    if limits.max_bytes == 0 || limits.max_chars == 0 || limits.max_pages == 0 {
        return Err("Extraction limits must be positive".into());
    }
    let path = local_path(raw)?;
    let mut file = File::open(&path).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err("Expected a regular file".into());
    }
    if metadata.len() > limits.max_bytes {
        return Ok(Extraction::failure(
            "too-large",
            format!("Input exceeds {} bytes", limits.max_bytes),
        ));
    }
    let mut prefix = [0_u8; 1024];
    let read = file.read(&mut prefix).map_err(|e| e.to_string())?;
    let is_pdf = filename.to_ascii_lowercase().ends_with(".pdf")
        || prefix[..read].windows(5).any(|part| part == b"%PDF-");
    if is_pdf {
        // LiteParse's native path API routes by extension before opening PDFium.
        // Cached / mislabeled PDF paths need a .pdf alias, not a byte copy or an
        // attempted LibreOffice conversion. The temporary link owns no input bytes.
        if path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("pdf")) {
            return extract_pdf(&path, pdfium_path, limits, ocr);
        }
        let alias =
            tempfile::Builder::new().prefix("anydoc-pdf-").tempdir().map_err(|e| e.to_string())?;
        let pdf_path = alias.path().join("input.pdf");
        std::os::unix::fs::symlink(&path, &pdf_path).map_err(|e| e.to_string())?;
        return extract_pdf(&pdf_path, pdfium_path, limits, ocr);
    }

    // Office containers need random access too. One bounded native allocation;
    // no base64, JS ArrayBuffer, network service, or second input-sized copy.
    let file = File::open(&path).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(limits.max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limits.max_bytes {
        return Ok(Extraction::failure("too-large", "Input grew past the byte limit"));
    }
    let hint = if filename.to_ascii_lowercase().ends_with(".csv")
        && anydoc::Format::from_bytes(&bytes).is_none()
    {
        Some(anydoc::Format::Csv)
    } else {
        None
    };
    let text = match anydoc::to_markdown_bytes(&bytes, hint) {
        Ok(text) => text,
        Err(error) => {
            return Ok(Extraction::failure(
                match error {
                    anydoc::ConvertError::Unsupported(_) => "unsupported",
                    anydoc::ConvertError::NeedsOcr { .. } => "needs-ocr",
                    _ => "extraction-failed",
                },
                error,
            ));
        }
    };
    let mut output = BoundedText::new(limits.max_chars);
    output.append(text.trim());
    Ok(output.finish(false, Vec::new()))
}

fn extract_pdf(
    path: &Path,
    pdfium_path: &str,
    limits: Limits,
    ocr: OcrConfig,
) -> Result<Extraction, String> {
    // Explicit bundled path avoids global environment mutation and desktop paths.
    liteparse_pdfium_sys::dynamic::load(Path::new(pdfium_path))?;
    let enabled = ocr.engine.is_some();
    let parser = LiteParse::new(LiteParseConfig {
        ocr_enabled: enabled,
        dpi: if ocr.mode == 2 { 240.0 } else { 144.0 },
        num_workers: 1,
        output_format: OutputFormat::Markdown,
        continue_on_page_error: true,
        max_pages: limits.max_pages,
        quiet: true,
        ..Default::default()
    });
    let parser = match &ocr.engine {
        Some(engine) => parser.with_ocr_engine(engine.clone()),
        None => parser,
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    runtime.block_on(async {
        let mut session = parser
            .open_batch_session(
                PdfInput::Path(path.to_string_lossy().into_owned()),
                if enabled { 1 } else { BATCH_PAGES },
            )
            .await
            .map_err(|e| e.to_string())?;
        let total_pages = session.total_pages();
        let mut last_page = 0;
        let mut errors = 0;
        let mut output = BoundedText::new(limits.max_chars);
        while let Some(batch) = session.next_batch().await.map_err(|e| e.to_string())? {
            last_page = batch.end_page;
            errors += batch.result.page_errors.len();
            // Whitespace-only pages can render empty Markdown fences upstream.
            if batch.result.pages.iter().any(|page| !page.text.trim().is_empty()) {
                let text = batch.result.text.trim();
                if !output.text.is_empty() && !text.is_empty() {
                    output.append("\n\n");
                }
                output.append(text);
            }
            if output.truncated {
                break;
            }
        }
        let mut details = Vec::new();
        let ocr_failures = ocr.failures();
        if ocr_failures > 0 {
            details.push(format!("{ocr_failures} native OCR tasks failed"));
        }
        if errors > 0 {
            details.push(format!("{errors} PDF pages failed to parse"));
        }
        let incomplete = last_page < total_pages;
        if incomplete {
            details.push(format!("Parsed {last_page} of {total_pages} PDF pages"));
        }
        if output.text.trim().is_empty() {
            return Ok(Extraction::failure(
                "extraction-failed",
                if enabled {
                    "No text found by embedded extraction or native OCR"
                } else {
                    "No extractable text found; OCR is disabled"
                },
            ));
        }
        Ok(output.finish(incomplete, details))
    })
}

struct BoundedText {
    text: String,
    limit: usize,
    retained: usize,
    source: usize,
    truncated: bool,
}
impl BoundedText {
    fn new(limit: usize) -> Self {
        Self { text: String::new(), limit, retained: 0, source: 0, truncated: false }
    }
    fn append(&mut self, text: &str) {
        for ch in text.chars() {
            let length = ch.len_utf16();
            self.source += length;
            // Never split a supplementary Unicode character / surrogate pair.
            if !self.truncated && self.retained + length <= self.limit {
                self.text.push(ch);
                self.retained += length;
            } else {
                self.truncated = true;
            }
        }
    }
    fn finish(self, incomplete: bool, mut details: Vec<String>) -> Extraction {
        if self.truncated {
            details.insert(0, format!("Extraction capped at {} UTF-16 characters", self.limit));
        }
        Extraction {
            status: "ok",
            text: Some(self.text),
            // An early PDF stop cannot claim to know the whole document size.
            source_chars: if incomplete { None } else { Some(self.source) },
            partial: incomplete || !details.is_empty(),
            detail: if details.is_empty() { None } else { Some(details.join("; ")) },
        }
    }
}

fn guarded_extract(
    path: &str,
    filename: &str,
    pdfium_path: &str,
    limits: Limits,
    ocr: OcrConfig,
) -> String {
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        extract_file_with_ocr(path, filename, pdfium_path, limits, ocr)
    }))
    .unwrap_or_else(|_| Extraction::failure("extraction-failed", "Native parser panicked"));
    serde_json::to_string(&result).expect("Extraction is JSON serializable")
}

/// # Safety
/// Inputs must be non-null, NUL-terminated UTF-8 strings valid for this call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn anydoc_mobile_extract(
    path: *const c_char,
    filename: *const c_char,
    pdfium_path: *const c_char,
    max_bytes: u64,
    max_chars: u32,
    max_pages: u32,
    ocr_mode: u32,
    recognize: Option<ocr::RecognizeCallback>,
    free_ocr: Option<ocr::FreeCallback>,
) -> *mut c_char {
    let result = (|| {
        if path.is_null() || filename.is_null() || pdfium_path.is_null() {
            return Err("Null input pointer");
        }
        let path = unsafe { CStr::from_ptr(path) }.to_str().map_err(|_| "Path is not UTF-8")?;
        let filename =
            unsafe { CStr::from_ptr(filename) }.to_str().map_err(|_| "Filename is not UTF-8")?;
        let pdfium = unsafe { CStr::from_ptr(pdfium_path) }
            .to_str()
            .map_err(|_| "PDFium path is not UTF-8")?;
        let ocr = if ocr_mode == 0 {
            OcrConfig::default()
        } else {
            let engine = ocr::CallbackEngine {
                recognize: recognize.ok_or("Native OCR callback is missing")?,
                free: free_ocr.ok_or("Native OCR release callback is missing")?,
                mode: ocr_mode,
            };
            OcrConfig::native(ocr_mode, Arc::new(engine)).map_err(|_| "Invalid OCR mode")?
        };
        Ok(guarded_extract(
            path,
            filename,
            pdfium,
            Limits { max_bytes, max_chars: max_chars as usize, max_pages: max_pages as usize },
            ocr,
        ))
    })()
    .unwrap_or_else(|error| {
        serde_json::to_string(&Extraction::failure("extraction-failed", error)).unwrap()
    });
    CString::new(result).expect("JSON contains no literal NUL").into_raw()
}

/// # Safety
/// `result` must be null or an unfreed pointer returned by `anydoc_mobile_extract`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn anydoc_mobile_free(result: *mut c_char) {
    if !result.is_null() {
        drop(unsafe { CString::from_raw(result) });
    }
}

#[cfg(feature = "android-jni")]
mod android;

#[cfg(test)]
mod tests {
    use super::*;
    fn pdf(lines: &[&str]) -> Vec<u8> {
        pdf_fixture(lines, false)
    }
    fn pdf_fixture(lines: &[&str], scan: bool) -> Vec<u8> {
        let mut objects = vec![String::from("<</Type/Catalog/Pages 2 0 R>>"), String::new()];
        let mut kids = Vec::new();
        for line in lines {
            let page = objects.len() + 1;
            kids.push(format!("{page} 0 R"));
            let drawing = if scan { "q 0 0 0 rg 20 20 150 120 re f Q\n" } else { "" };
            let stream = format!("{drawing}BT /F1 12 Tf 10 100 Td ({line}) Tj ET\n");
            objects.push(format!("<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents {} 0 R/Resources<</Font<</F1 {} 0 R>>>>>>", page + 1, page + 2));
            objects.push(format!("<</Length {}>>stream\n{stream}endstream", stream.len()));
            objects.push("<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>".into());
        }
        objects[1] = format!("<</Type/Pages/Kids[{}]/Count {}>>", kids.join(" "), lines.len());
        let mut result = String::from("%PDF-1.4\n");
        let mut offsets = Vec::new();
        for (index, body) in objects.iter().enumerate() {
            offsets.push(result.len());
            result.push_str(&format!("{} 0 obj{body}endobj\n", index + 1));
        }
        let xref = result.len();
        result.push_str(&format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1));
        for offset in offsets {
            result.push_str(&format!("{offset:010} 00000 n \n"));
        }
        result.push_str(&format!(
            "trailer<</Size {}/Root 1 0 R>>\nstartxref\n{xref}\n%%EOF",
            objects.len() + 1
        ));
        result.into_bytes()
    }

    #[test]
    fn native_ocr_callback_is_opt_in_and_uses_quality_resolution() {
        use std::sync::atomic::{AtomicU32, Ordering};
        static WIDTH: AtomicU32 = AtomicU32::new(0);
        unsafe extern "C" fn recognize(
            _bytes: *const u8,
            length: u64,
            width: u32,
            height: u32,
            _mode: u32,
        ) -> *mut c_char {
            assert_eq!(length, u64::from(width) * u64::from(height) * 3);
            WIDTH.store(width, Ordering::Relaxed);
            CString::new(
                r#"[{"text":"Native OCR marker","bbox":[20,20,180,50],"confidence":0.99}]"#,
            )
            .unwrap()
            .into_raw()
        }
        unsafe extern "C" fn release(value: *mut c_char) {
            drop(unsafe { CString::from_raw(value) });
        }
        let pdfium =
            std::env::var("ANYDOC_TEST_PDFIUM").expect("Run bun scripts/build-native.mjs host");
        let file = tempfile::Builder::new().suffix(".pdf").tempfile().unwrap();
        std::fs::write(file.path(), pdf_fixture(&[" "], true)).unwrap();
        let path = file.path().to_str().unwrap();
        let result = extract_file(path, "scan.pdf", &pdfium, limits());
        assert_eq!(result.status, "extraction-failed");
        assert_eq!(WIDTH.load(Ordering::Relaxed), 0);
        let mut widths = Vec::new();
        for mode in [1, 2] {
            let engine = ocr::CallbackEngine { recognize, free: release, mode };
            let config = OcrConfig::native(mode, Arc::new(engine)).unwrap();
            let result = extract_file_with_ocr(path, "scan.pdf", &pdfium, limits(), config);
            assert_eq!(result.status, "ok", "{result:?}");
            assert!(result.text.unwrap().contains("Native OCR marker"));
            widths.push(WIDTH.load(Ordering::Relaxed));
        }
        assert!(widths[1] > widths[0]);
    }

    #[test]
    fn pdf_batches_keep_readable_pages_and_report_early_stops() {
        let pdfium =
            std::env::var("ANYDOC_TEST_PDFIUM").expect("Run bun scripts/build-native.mjs host");
        // An extensionless cache path must remain file-backed and never invoke a converter.
        let file = tempfile::NamedTempFile::new().unwrap();
        let lines = [
            "First marker",
            "   ",
            "Middle marker",
            "page four",
            "page five",
            "page six",
            "page seven",
            "page eight",
            "Final marker",
        ];
        std::fs::write(file.path(), pdf(&lines)).unwrap();
        let output = extract_file(
            file.path().to_str().unwrap(),
            "test.pdf",
            &pdfium,
            Limits { max_chars: 10000, ..limits() },
        );
        assert_eq!(output.status, "ok", "{output:?}");
        assert!(output.text.as_ref().unwrap().contains("First marker"));
        assert!(output.text.as_ref().unwrap().contains("Final marker"));
        assert!(!output.partial);
        let output = extract_file(
            file.path().to_str().unwrap(),
            "test.pdf",
            &pdfium,
            Limits { max_pages: 1, ..limits() },
        );
        assert!(output.partial);
        assert_eq!(output.source_chars, None);
        assert!(output.detail.unwrap().contains("1 of 9"));
        let output = extract_file(
            file.path().to_str().unwrap(),
            "test.pdf",
            &pdfium,
            Limits { max_chars: 3, ..limits() },
        );
        assert!(output.partial);
        assert_eq!(output.source_chars, None);
        std::fs::write(file.path(), pdf(&["   "])).unwrap();
        assert_eq!(
            extract_file(file.path().to_str().unwrap(), "test.pdf", &pdfium, limits()).status,
            "extraction-failed"
        );
        std::fs::write(file.path(), b"%PDF-broken").unwrap();
        assert_eq!(
            extract_file(file.path().to_str().unwrap(), "test.pdf", &pdfium, limits()).status,
            "extraction-failed"
        );
    }
    fn limits() -> Limits {
        Limits { max_bytes: 1024 * 1024, max_chars: 100, max_pages: 100 }
    }
    #[test]
    fn office_reads_a_file_url_and_enforces_caps() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("space ü.rtf");
        std::fs::write(&path, b"{\\rtf1\\ansi Hello native}").unwrap();
        let uri = url::Url::from_file_path(&path).unwrap().to_string();
        let output = extract_file(&uri, "input.rtf", "", limits());
        assert_eq!(output.text.as_deref(), Some("Hello native"));
        let output = extract_file(&uri, "input.rtf", "", Limits { max_chars: 5, ..limits() });
        assert_eq!(output.text.as_deref(), Some("Hello"));
        assert!(output.partial);
        assert_eq!(output.source_chars, Some(12));
        assert_eq!(
            extract_file(&uri, "input.rtf", "", Limits { max_bytes: 1, ..limits() }).status,
            "too-large"
        );
    }
    #[test]
    fn unicode_cap_is_utf16_without_splitting_a_character() {
        let mut output = BoundedText::new(3);
        output.append("a😀b");
        let output = output.finish(false, vec![]);
        assert_eq!(output.text.as_deref(), Some("a😀"));
        assert_eq!(output.source_chars, Some(4));
        let mut output = BoundedText::new(2);
        output.append("a😀b");
        assert_eq!(output.finish(false, vec![]).text.as_deref(), Some("a"));
    }
    #[test]
    fn rejects_nonlocal_or_relative_paths() {
        for path in [
            "relative.docx",
            "https://example.com/a.pdf",
            "file://remote/a.pdf",
            "file:///a.pdf?x=1",
        ] {
            assert_eq!(extract_file(path, "a.pdf", "", limits()).status, "extraction-failed");
        }
    }
    #[test]
    fn unknown_and_corrupt_documents_are_explicit_failures() {
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), b"not a document").unwrap();
        assert_eq!(
            extract_file(file.path().to_str().unwrap(), "a.docx", "", limits()).status,
            "unsupported"
        );
    }
}
