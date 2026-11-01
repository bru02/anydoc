package expo.modules.anydoc

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import android.graphics.Bitmap
import com.google.android.gms.tasks.Task
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.Text
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import java.nio.ByteBuffer
import java.util.concurrent.Executors
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit
import org.json.JSONArray
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
      , ocrMode: Long
    ): String

    private val recognizer by lazy { TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS) }
    @Volatile private var pendingRecognition: Task<Text>? = null

    // Called synchronously through JNI from the native parser worker. Rust owns
    // the direct RGB buffer until return; only the Bitmap is retained by ML Kit.
    @JvmStatic private fun recognizeNative(rgb: ByteBuffer, width: Int, height: Int): String {
      return try {
        // A timeout cannot cancel ML Kit. Do not queue more images behind it.
        check(pendingRecognition?.isComplete != false) { "The previous OCR request is still running" }
        require(width > 0 && height > 0 && width.toLong() * height * 3 == rgb.capacity().toLong())
        val pixels = IntArray(width * height)
        for (index in pixels.indices) {
          val r = rgb.get().toInt() and 255
          val g = rgb.get().toInt() and 255
          val b = rgb.get().toInt() and 255
          pixels[index] = (255 shl 24) or (r shl 16) or (g shl 8) or b
        }
        val bitmap = Bitmap.createBitmap(pixels, width, height, Bitmap.Config.ARGB_8888)
        val task = try {
          recognizer.process(InputImage.fromBitmap(bitmap, 0))
        } catch (error: Exception) {
          bitmap.recycle()
          throw error
        }
        pendingRecognition = task
        val result = try {
          Tasks.await(task, 60, TimeUnit.SECONDS)
        } finally {
          if (task.isComplete) {
            pendingRecognition = null
            bitmap.recycle()
          } else {
            // Keep timed-out input alive until the recognizer actually finishes.
            task.addOnCompleteListener(Executor { it.run() }) { bitmap.recycle() }
          }
        }
        val words = JSONArray()
        for (block in result.textBlocks) for (line in block.lines) for (element in line.elements) {
          val box = element.boundingBox ?: continue
          words.put(JSONObject().put("text", element.text)
            .put("bbox", JSONArray(listOf(box.left.coerceIn(0, width), box.top.coerceIn(0, height), box.right.coerceIn(0, width), box.bottom.coerceIn(0, height))))
            .put("confidence", (element.confidence ?: 1.0f).coerceIn(0.0f, 1.0f)))
        }
        words.toString()
      } catch (error: Exception) {
        JSONObject().put("error", error.message ?: "Native ML Kit OCR failed").toString()
      }
    }
  }

  override fun definition() = ModuleDefinition {
    Name("AnyDoc")
    AsyncFunction("extractFile") { path: String, filename: String, maxBytes: Long, maxChars: Long, maxPages: Long, ocrMode: Long, promise: Promise ->
        parserQueue.execute {
          try {
            val json = JSONObject(extractNative(path, filename, "libpdfium.so", maxBytes, maxChars, maxPages, ocrMode))
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
