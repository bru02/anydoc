// Peak memory of the native OCR path on macOS: the same Rust parser, PDFium
// render and Swift Vision callback that iOS ships, linked into one process.
//
//   swiftc -O -I native/include ios/NativeOCR.swift scripts/ocr-footprint.swift \
//     target/release/libanydoc_mobile.a -framework Vision -framework CoreGraphics \
//     -framework CoreText -framework ImageIO -lc++ -liconv -lresolv -o native/dist/ocr-footprint
//   native/dist/ocr-footprint scan <out.pdf> <pages>       # synthetic scanned A4 pages
//   native/dist/ocr-footprint run <in.pdf> <libpdfium.dylib> fast|accurate [out.md]
//
// `run` prints the process footprint before extraction and its peak after,
// read from the kernel ledger. Run `scan` separately so generation is not
// counted.
import AnyDocCore
import CoreGraphics
import CoreText
import Foundation
import ImageIO

@main
enum OcrFootprint {
  static func main() {
    let args = CommandLine.arguments
    do {
      switch (args.count, args.count > 1 ? args[1] : "") {
      case (4, "scan"): try scan(to: URL(fileURLWithPath: args[2]), pages: Int(args[3]) ?? 0)
      case (5, "run"), (6, "run"): try run(pdf: args[2], pdfium: args[3], mode: args[4], text: args.count == 6 ? args[5] : nil)
      default:
        fputs("usage: ocr-footprint scan <out.pdf> <pages> | run <in.pdf> <libpdfium.dylib> fast|accurate [out.md]\n", stderr)
        exit(2)
      }
    } catch {
      fputs("ocr-footprint: \(error)\n", stderr)
      exit(1)
    }
  }

  /// A4 pages that are only an embedded grayscale JPEG of text, like a scan.
  static func scan(to url: URL, pages: Int) throws {
    guard pages > 0 else { throw failure("page count must be positive") }
    var box = CGRect(x: 0, y: 0, width: 595, height: 842)
    guard let pdf = CGContext(url as CFURL, mediaBox: &box, nil) else { throw failure("cannot create \(url.path)") }
    let dpi = 200.0, width = Int(595 / 72 * dpi), height = Int(842 / 72 * dpi)
    let font = CTFontCreateWithName("Times-Roman" as CFString, 11 * dpi / 72, nil)
    for page in 1...pages {
      guard let bitmap = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else {
        throw failure("cannot allocate page bitmap")
      }
      bitmap.setFillColor(gray: 1, alpha: 1)
      bitmap.fill(CGRect(x: 0, y: 0, width: width, height: height))
      var y = Double(height) - 2 * dpi * 0.75
      var line = 0
      while y > dpi {
        let text = "Page \(page) line \(line): scanned paragraph text \(String(repeating: "\(line * 7919 % 1000) ", count: 6))"
        let attributed = NSAttributedString(string: text, attributes: [
          NSAttributedString.Key(kCTFontAttributeName as String): font,
          NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 0, alpha: 1),
        ])
        bitmap.textPosition = CGPoint(x: dpi, y: y)
        CTLineDraw(CTLineCreateWithAttributedString(attributed), bitmap)
        y -= 16 * dpi / 72
        line += 1
      }
      guard let image = bitmap.makeImage() else { throw failure("cannot finish page bitmap") }
      let jpeg = NSMutableData()
      guard let destination = CGImageDestinationCreateWithData(jpeg, "public.jpeg" as CFString, 1, nil) else {
        throw failure("cannot encode JPEG")
      }
      CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
      guard CGImageDestinationFinalize(destination), let source = CGImageSourceCreateWithData(jpeg, nil),
        let decoded = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw failure("cannot encode JPEG") }
      pdf.beginPDFPage(nil)
      pdf.draw(decoded, in: box)
      pdf.endPDFPage()
    }
    pdf.closePDF()
  }

  static func run(pdf: String, pdfium: String, mode: String, text path: String?) throws {
    guard let ocrMode: UInt32 = ["fast": 1, "accurate": 2][mode] else { throw failure("mode must be fast or accurate") }
    let before = footprint()
    let start = Date()
    let input = URL(fileURLWithPath: pdf), library = URL(fileURLWithPath: pdfium).path
    guard let result = anydoc_mobile_extract(input.path, input.lastPathComponent, library,
      1 << 30, 10_000_000, 10_000, ocrMode, nativeOcrPixelFormat, nativeOcrRecognize, nativeOcrFree) else {
      throw failure("parser returned no result")
    }
    defer { anydoc_mobile_free(result) }
    let elapsed = Date().timeIntervalSince(start)
    let after = footprint()
    let output = try JSONSerialization.jsonObject(with: Data(bytes: result, count: strlen(result))) as? [String: Any] ?? [:]
    let text = output["text"] as? String ?? ""
    let partial = output["partial"] as? Bool ?? false
    let mib = { (bytes: UInt64) in String(format: "%.1f", Double(bytes) / 1_048_576) }
    print("status=\(output["status"] ?? "?") partial=\(partial) chars=\(text.count) seconds=\(String(format: "%.2f", elapsed))"
      + " footprint_before_mib=\(mib(before.current)) peak_mib=\(mib(after.peak))"
      + " peak_delta_mib=\(mib(after.peak - before.current))")
    if let detail = output["detail"] { print("detail=\(detail)") }
    guard output["status"] as? String == "ok", !partial, !text.isEmpty else {
      throw failure("OCR did not complete")
    }
    if let path { try text.write(toFile: path, atomically: true, encoding: .utf8) }
  }

  static func footprint() -> (current: UInt64, peak: UInt64) {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
    let status = withUnsafeMutablePointer(to: &info) {
      $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
        task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
      }
    }
    return status == KERN_SUCCESS ? (info.phys_footprint, UInt64(max(0, info.ledger_phys_footprint_peak))) : (0, 0)
  }

  static func failure(_ message: String) -> NSError {
    NSError(domain: "OcrFootprint", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
  }
}
