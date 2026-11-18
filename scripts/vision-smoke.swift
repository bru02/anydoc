import AnyDocCore
import CoreGraphics
import CoreText
import Foundation

@main
enum VisionSmoke {
  static func main() {
    do { try run() }
    catch { fputs("Vision smoke failed: \(error)\n", stderr); exit(1) }
  }
  static func run() throws {
    let width = 720, height = 240
    // The layout Rust hands the callback: PDFium BGRx, rows tightly packed.
    var bgrx = [UInt8](repeating: 255, count: width * height * 4)
    bgrx.withUnsafeMutableBytes { buffer in
      let context = CGContext(data: buffer.baseAddress, width: width, height: height,
        bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
      context.setFillColor(CGColor(gray: 1, alpha: 1))
      context.fill(CGRect(x: 0, y: 0, width: width, height: height))
      context.textPosition = CGPoint(x: 30, y: 100)
      let text = NSAttributedString(string: "NATIVE OCR MARKER", attributes: [
        NSAttributedString.Key(kCTFontAttributeName as String): CTFontCreateWithName("Helvetica-Bold" as CFString, 46, nil),
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 0, alpha: 1),
      ])
      CTLineDraw(CTLineCreateWithAttributedString(text), context)
    }
    try bgrx.withUnsafeBufferPointer { buffer in
      // Any other layout is refused rather than misread.
      guard let result = nativeOcrRecognize(buffer.baseAddress, UInt64(buffer.count), UInt32(width), UInt32(height),
        UInt32(ANYDOC_OCR_PIXELS_RGB8), 1) else { throw NSError(domain: "VisionSmoke", code: 3) }
      defer { nativeOcrFree(result) }
      guard String(cString: result).contains("\"error\"") else {
        throw NSError(domain: "VisionSmoke", code: 4, userInfo: [NSLocalizedDescriptionKey: "Accepted an RGB layout"])
      }
    }
    for mode: UInt32 in [1, 2] {
      try bgrx.withUnsafeBufferPointer { buffer in
        guard let result = nativeOcrRecognize(buffer.baseAddress, UInt64(buffer.count), UInt32(width), UInt32(height), nativeOcrPixelFormat, mode) else {
          throw NSError(domain: "VisionSmoke", code: 1)
        }
        defer { nativeOcrFree(result) }
        let json = String(cString: result)
        let words = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [[String: Any]]
        let text = words?.compactMap { $0["text"] as? String }.joined(separator: " ") ?? ""
        guard text.contains("NATIVE OCR MARKER") else {
          throw NSError(domain: "VisionSmoke", code: 2, userInfo: [NSLocalizedDescriptionKey: "Vision mode \(mode) failed: \(json)"])
        }
        print("Apple Vision mode \(mode): recognized generated fixture")
      }
    }
  }
}
