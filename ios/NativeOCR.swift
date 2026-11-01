import AnyDocCore
import CoreGraphics
import Foundation
import Vision

// Both callbacks run synchronously on the parser's background thread. The raw
// RGB provider borrows Rust memory only for this call; it never enters JS.
let nativeOcrRecognize: anydoc_ocr_recognize = { bytes, length, width, height, mode in
  autoreleasepool {
    let response: Any
    do {
      response = try NativeOCR.recognize(bytes: bytes, length: length, width: width, height: height, mode: mode)
    } catch {
      response = ["error": String(reflecting: error)]
    }
    guard let data = try? JSONSerialization.data(withJSONObject: response),
      let json = String(data: data, encoding: .utf8) else { return nil }
    return strdup(json)
  }
}

let nativeOcrFree: anydoc_ocr_free = { result in free(result) }

private enum NativeOCR {
  static func recognize(bytes: UnsafePointer<UInt8>?, length: UInt64, width: UInt32, height: UInt32, mode: UInt32) throws -> [[String: Any]] {
    guard let bytes, width > 0, height > 0,
      UInt64(width) * UInt64(height) * 3 == length,
      let provider = CGDataProvider(dataInfo: nil, data: bytes, size: Int(length), releaseData: { _, _, _ in }),
      let rgbImage = CGImage(width: Int(width), height: Int(height), bitsPerComponent: 8, bitsPerPixel: 24,
        bytesPerRow: Int(width) * 3, space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue), provider: provider,
        decode: nil, shouldInterpolate: false, intent: .defaultIntent) else {
      throw NSError(domain: "AnyDoc", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid native OCR image"])
    }
    // Normalize the image to a conventional 32-bit format for Vision/Core ML.
    // CoreGraphics performs this conversion natively; no encoded PNG or JS copy.
    guard let context = CGContext(data: nil, width: Int(width), height: Int(height), bitsPerComponent: 8,
      bytesPerRow: Int(width) * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else {
      throw NSError(domain: "AnyDoc", code: 2, userInfo: [NSLocalizedDescriptionKey: "Cannot allocate native OCR image"])
    }
    context.draw(rgbImage, in: CGRect(x: 0, y: 0, width: Int(width), height: Int(height)))
    guard let image = context.makeImage() else {
      throw NSError(domain: "AnyDoc", code: 3, userInfo: [NSLocalizedDescriptionKey: "Cannot prepare native OCR image"])
    }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = mode == 1 ? .fast : .accurate
    request.usesLanguageCorrection = mode == 2
    request.automaticallyDetectsLanguage = true
    try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
    let tokens = try NSRegularExpression(pattern: "\\S+")
    var output: [[String: Any]] = []
    for observation in request.results ?? [] {
      guard let candidate = observation.topCandidates(1).first, !candidate.string.isEmpty else { continue }
      let text = candidate.string
      var line: [[String: Any]] = []
      var complete = true
      for match in tokens.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
        guard let range = Range(match.range, in: text),
          let box = try? candidate.boundingBox(for: range) else { complete = false; break }
        line.append(word(String(text[range]), box.boundingBox, candidate.confidence, width, height))
      }
      // Preserve punctuation/text if Vision cannot supply a word box for a line.
      output.append(contentsOf: complete && !line.isEmpty ? line : [word(text, observation.boundingBox, candidate.confidence, width, height)])
    }
    return output
  }

  private static func word(_ text: String, _ box: CGRect, _ confidence: Float, _ width: UInt32, _ height: UInt32) -> [String: Any] {
    let x1 = max(0, min(1, box.minX)), x2 = max(0, min(1, box.maxX))
    let y1 = max(0, min(1, 1 - box.maxY)), y2 = max(0, min(1, 1 - box.minY))
    return ["text": text, "bbox": [x1 * CGFloat(width), y1 * CGFloat(height), x2 * CGFloat(width), y2 * CGFloat(height)],
      "confidence": max(0, min(1, confidence))]
  }
}
