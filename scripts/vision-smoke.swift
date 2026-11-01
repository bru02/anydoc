import CoreGraphics
import CoreText
import Foundation

@main
enum VisionSmoke {
  static func main() throws {
    let width = 720, height = 240
    var rgba = [UInt8](repeating: 255, count: width * height * 4)
    rgba.withUnsafeMutableBytes { buffer in
      let context = CGContext(data: buffer.baseAddress, width: width, height: height,
        bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
      context.setFillColor(CGColor(gray: 1, alpha: 1))
      context.fill(CGRect(x: 0, y: 0, width: width, height: height))
      context.textPosition = CGPoint(x: 30, y: 100)
      let text = NSAttributedString(string: "NATIVE OCR MARKER", attributes: [
        NSAttributedString.Key(kCTFontAttributeName as String): CTFontCreateWithName("Helvetica-Bold" as CFString, 46, nil),
        NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 0, alpha: 1),
      ])
      CTLineDraw(CTLineCreateWithAttributedString(text), context)
    }
    var rgb = [UInt8](repeating: 0, count: width * height * 3)
    for pixel in 0..<(width * height) {
      for channel in 0..<3 { rgb[pixel * 3 + channel] = rgba[pixel * 4 + channel] }
    }
    for mode: UInt32 in [1, 2] {
      try rgb.withUnsafeBufferPointer { buffer in
        guard let result = nativeOcrRecognize(buffer.baseAddress, UInt64(buffer.count), UInt32(width), UInt32(height), mode) else {
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
