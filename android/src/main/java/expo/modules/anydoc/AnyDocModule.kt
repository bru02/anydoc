package expo.modules.anydoc

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.Executors
import org.json.JSONObject

class AnyDocModule : Module() {
  companion object {
    private val parserQueue = Executors.newSingleThreadExecutor { task ->
      Thread(task, "anydoc-parser").apply { priority = Thread.MIN_PRIORITY }
    }
    init {
      // Let Android's linker handle APK-backed libraries without extraction.
      System.loadLibrary("pdfium")
      System.loadLibrary("anydoc_mobile")
    }
    @JvmStatic private external fun extractNative(
      path: String, filename: String, pdfium: String,
      maxBytes: Long, maxChars: Long, maxPages: Long
    ): String
  }

  override fun definition() = ModuleDefinition {
    Name("AnyDoc")
    AsyncFunction("extractFile") { path: String, filename: String, maxBytes: Long, maxChars: Long, maxPages: Long, promise: Promise ->
        parserQueue.execute {
          try {
            val json = JSONObject(extractNative(path, filename, "libpdfium.so", maxBytes, maxChars, maxPages))
            val result = mutableMapOf<String, Any>()
            for (key in json.keys()) if (!json.isNull(key)) result[key] = json.get(key)
            promise.resolve(result)
          } catch (error: Exception) {
            promise.resolve(mapOf("status" to "extraction-failed", "detail" to (error.message ?: "Native extraction failed")))
          }
        }
    }
  }
}
