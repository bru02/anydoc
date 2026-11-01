use jni::JNIEnv;
use jni::objects::{JClass, JString};
use jni::sys::{jlong, jstring};

#[unsafe(no_mangle)]
pub extern "system" fn Java_expo_modules_anydoc_AnyDocModule_extractNative(
    mut env: JNIEnv,
    _class: JClass,
    path: JString,
    filename: JString,
    pdfium: JString,
    max_bytes: jlong,
    max_chars: jlong,
    max_pages: jlong,
) -> jstring {
    let result = (|| -> Result<String, String> {
        let path: String = env.get_string(&path).map_err(|e| e.to_string())?.into();
        let filename: String = env.get_string(&filename).map_err(|e| e.to_string())?.into();
        let pdfium: String = env.get_string(&pdfium).map_err(|e| e.to_string())?.into();
        if max_bytes <= 0 || max_chars <= 0 || max_pages <= 0 {
            return Err("Extraction limits must be positive".into());
        }
        Ok(super::guarded_extract(
            &path,
            &filename,
            &pdfium,
            super::Limits {
                max_bytes: max_bytes as u64,
                max_chars: max_chars as usize,
                max_pages: max_pages as usize,
            },
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
