# Rust locates these methods through JNI, including the OCR callback. Preserve
# both the module and its generated Kotlin companion in minified release apps.
-keep class expo.modules.anydoc.AnyDocModule { *; }
-keep class expo.modules.anydoc.AnyDocModule$Companion { *; }
