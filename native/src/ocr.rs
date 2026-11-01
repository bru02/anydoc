use std::ffi::{CStr, c_char};
use std::pin::Pin;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use liteparse::ocr::{OcrEngine, OcrOptions, OcrResult};
use serde::Deserialize;

type OcrError = Box<dyn std::error::Error + Send + Sync>;

pub type RecognizeCallback = unsafe extern "C" fn(*const u8, u64, u32, u32, u32) -> *mut c_char;
pub type FreeCallback = unsafe extern "C" fn(*mut c_char);

#[derive(Clone, Default)]
pub struct OcrConfig {
    pub mode: u32,
    pub engine: Option<Arc<TrackedEngine>>,
}

impl OcrConfig {
    pub fn native(mode: u32, engine: Arc<dyn OcrEngine>) -> Result<Self, String> {
        if !(1..=2).contains(&mode) {
            return Err("OCR mode must be fast or accurate".into());
        }
        Ok(Self {
            mode,
            engine: Some(Arc::new(TrackedEngine { inner: engine, failures: AtomicUsize::new(0) })),
        })
    }
    pub fn failures(&self) -> usize {
        self.engine.as_ref().map_or(0, |engine| engine.failures.load(Ordering::Relaxed))
    }
}

pub struct TrackedEngine {
    inner: Arc<dyn OcrEngine>,
    failures: AtomicUsize,
}
impl OcrEngine for TrackedEngine {
    fn name(&self) -> &str {
        self.inner.name()
    }
    fn recognize<'a, 'b: 'a, 'c: 'a>(
        &'a self,
        data: &'c [u8],
        width: u32,
        height: u32,
        options: &'b OcrOptions,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<OcrResult>, OcrError>> + Send + '_>> {
        Box::pin(async move {
            let result = self.inner.recognize(data, width, height, options).await;
            if result.is_err() {
                self.failures.fetch_add(1, Ordering::Relaxed);
            }
            result
        })
    }
}

/// An iOS callback borrows raw RGB only until it returns owned UTF-8 JSON.
pub struct CallbackEngine {
    pub recognize: RecognizeCallback,
    pub free: FreeCallback,
    pub mode: u32,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Response {
    Words(Vec<OcrResult>),
    Error { error: String },
}

pub fn decode_response(json: &str, width: u32, height: u32) -> Result<Vec<OcrResult>, OcrError> {
    let words = match serde_json::from_str::<Response>(json)? {
        Response::Words(words) => words,
        Response::Error { error } => return Err(error.into()),
    };
    for word in &words {
        let [x1, y1, x2, y2] = word.bbox;
        if !word.confidence.is_finite()
            || !(0.0..=1.0).contains(&word.confidence)
            || !word.bbox.iter().all(|value| value.is_finite())
            || x1 < 0.0
            || y1 < 0.0
            || x2 < x1
            || y2 < y1
            || x2 > width as f32
            || y2 > height as f32
        {
            return Err("Native OCR returned invalid word geometry".into());
        }
    }
    Ok(words)
}

impl OcrEngine for CallbackEngine {
    fn name(&self) -> &str {
        "Apple Vision"
    }
    fn recognize<'a, 'b: 'a, 'c: 'a>(
        &'a self,
        data: &'c [u8],
        width: u32,
        height: u32,
        _options: &'b OcrOptions,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<OcrResult>, OcrError>> + Send + '_>> {
        Box::pin(async move {
            let result = unsafe {
                (self.recognize)(data.as_ptr(), data.len() as u64, width, height, self.mode)
            };
            if result.is_null() {
                return Err("Native OCR returned no result".into());
            }
            // Free platform allocations with the same allocator that created them.
            let parsed =
                (|| decode_response(unsafe { CStr::from_ptr(result) }.to_str()?, width, height))();
            unsafe { (self.free)(result) };
            parsed
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_native_errors_and_invalid_geometry() {
        assert!(decode_response(r#"{"error":"OCR unavailable"}"#, 100, 100).is_err());
        assert!(
            decode_response(r#"[{"text":"x","bbox":[0,0,200,10],"confidence":0.9}]"#, 100, 100)
                .is_err()
        );
        let words =
            decode_response(r#"[{"text":"native","bbox":[1,2,30,40],"confidence":0.9}]"#, 100, 100)
                .unwrap();
        assert_eq!(words[0].text, "native");
    }
}
