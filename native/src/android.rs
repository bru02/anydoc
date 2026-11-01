use jni::objects::{GlobalRef, JClass, JString, JValue};
use jni::sys::{jlong, jstring};
use jni::{JNIEnv, JavaVM};
use liteparse::ocr::{OcrEngine, OcrOptions, OcrResult};
use std::{pin::Pin, sync::Arc};

struct AndroidOcr {
    vm: JavaVM,
    class: GlobalRef,
}
impl OcrEngine for AndroidOcr {
    fn name(&self) -> &str {
        "ML Kit Latin"
    }
    fn recognize<'a, 'b: 'a, 'c: 'a>(
        &'a self,
        data: &'c [u8],
        width: u32,
        height: u32,
        _options: &'b OcrOptions,
    ) -> Pin<
        Box<
            dyn Future<Output = Result<Vec<OcrResult>, Box<dyn std::error::Error + Send + Sync>>>
                + Send
                + '_,
        >,
    > {
        Box::pin(async move {
            let mut env = self.vm.attach_current_thread()?;
            let json: Result<String, jni::errors::Error> = env.with_local_frame(16, |env| {
                let class = JClass::from(env.new_local_ref(self.class.as_obj())?);
                // ML Kit never retains this buffer. The synchronous Java method
                // copies pixels into a native Bitmap before starting recognition.
                let buffer =
                    unsafe { env.new_direct_byte_buffer(data.as_ptr() as *mut u8, data.len())? };
                let result = env
                    .call_static_method(
                        class,
                        "recognizeNative",
                        "(Ljava/nio/ByteBuffer;II)Ljava/lang/String;",
                        &[
                            JValue::Object(buffer.as_ref()),
                            JValue::Int(width as i32),
                            JValue::Int(height as i32),
                        ],
                    )?
                    .l()?;
                Ok(env.get_string(&JString::from(result))?.into())
            });
            if env.exception_check()? {
                env.exception_clear()?;
            }
            super::ocr::decode_response(&json?, width, height)
        })
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_expo_modules_anydoc_AnyDocModule_extractNative(
    mut env: JNIEnv,
    class: JClass,
    path: JString,
    filename: JString,
    pdfium: JString,
    max_bytes: jlong,
    max_chars: jlong,
    max_pages: jlong,
    ocr_mode: jlong,
) -> jstring {
    let result = (|| -> Result<String, String> {
        let path: String = env.get_string(&path).map_err(|e| e.to_string())?.into();
        let filename: String = env.get_string(&filename).map_err(|e| e.to_string())?.into();
        let pdfium: String = env.get_string(&pdfium).map_err(|e| e.to_string())?.into();
        if max_bytes <= 0 || max_chars <= 0 || max_pages <= 0 {
            return Err("Extraction limits must be positive".into());
        }
        let ocr = if ocr_mode == 0 {
            super::OcrConfig::default()
        } else {
            let engine = AndroidOcr {
                vm: env.get_java_vm().map_err(|e| e.to_string())?,
                class: env.new_global_ref(&class).map_err(|e| e.to_string())?,
            };
            super::OcrConfig::native(
                u32::try_from(ocr_mode).map_err(|_| "Invalid OCR mode")?,
                Arc::new(engine),
            )?
        };
        Ok(super::guarded_extract(
            &path,
            &filename,
            &pdfium,
            super::Limits {
                max_bytes: max_bytes as u64,
                max_chars: max_chars as usize,
                max_pages: max_pages as usize,
            },
            ocr,
        ))
    })()
    .unwrap_or_else(|error| {
        serde_json::to_string(&super::Extraction::failure("extraction-failed", error)).unwrap()
    });
    match env.new_string(result) {
        Ok(value) => value.into_raw(),
        Err(_) => std::ptr::null_mut(), // JNI preserves the pending allocation exception.
    }
}
