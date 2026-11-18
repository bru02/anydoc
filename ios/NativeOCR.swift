import AnyDocCore
import CoreGraphics
import Foundation
import Vision

// Both callbacks run synchronously on the parser's background thread. The page
// pixels are PDFium's own BGRx render, borrowed from Rust only for this call
// and wrapped in place: no conversion, no second page-sized buffer, never JS.
let nativeOcrPixelFormat = UInt32(ANYDOC_OCR_PIXELS_BGRX8)

let nativeOcrRecognize: anydoc_ocr_recognize = { pixels, length, width, height, format, mode in
  autoreleasepool {
    let response: Any
    do {
      response = try NativeOCR.recognize(pixels: pixels, length: length, width: width, height: height, format: format, mode: mode)
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
  static func recognize(pixels: UnsafePointer<UInt8>?, length: UInt64, width: UInt32, height: UInt32, format: UInt32, mode: UInt32) throws -> [[String: Any]] {
    // 32-bit little-endian xRGB is BGRx in memory, so the image wraps the
    // buffer instead of copying it. The provider never frees: Rust owns it.
    guard let pixels, width > 0, height > 0, format == nativeOcrPixelFormat,
      length <= UInt64(Int.max), length % (UInt64(width) * 4) == 0,
      length / (UInt64(width) * 4) == UInt64(height),
      let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
      let provider = CGDataProvider(dataInfo: nil, data: pixels, size: Int(length), releaseData: { _, _, _ in }),
      let image = CGImage(width: Int(width), height: Int(height), bitsPerComponent: 8, bitsPerPixel: 32,
        bytesPerRow: Int(width) * 4, space: colorSpace,
        bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue),
        provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent) else {
      throw NSError(domain: "AnyDoc", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid native OCR image"])
    }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = mode == 1 ? .fast : .accurate
    request.usesLanguageCorrection = mode == 2
    request.automaticallyDetectsLanguage = true
    #if os(macOS)
    // Host contract checks use the CPU; iOS keeps Vision's device selection.
    for (stage, devices) in try request.supportedComputeStageDevices {
      if let cpu = devices.first(where: { device in if case .cpu = device { return true }; return false }) {
        request.setComputeDevice(cpu, for: stage)
      }
    }
    #endif
    // The handler and image are released when the callback's pool drains,
    // before Rust frees the pixels.
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
