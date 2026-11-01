import AnyDocCore
import ExpoModulesCore
import Foundation

public final class AnyDocModule: Module {
  // A dedicated serial queue bounds native memory without blocking other Expo modules.
  private static let parserQueue = DispatchQueue(label: "app.anydoc.extract", qos: .utility)

  public func definition() -> ModuleDefinition {
    Name("AnyDoc")

    AsyncFunction("extractFile") { (path: String, filename: String, maxBytes: Int, maxChars: Int, maxPages: Int) throws -> [String: Any] in
      try autoreleasepool {
        guard maxBytes > 0, maxChars > 0, maxPages > 0,
          maxChars <= Int(UInt32.max), maxPages <= Int(UInt32.max),
          !path.contains("\0"), !filename.contains("\0") else {
          return ["status": "extraction-failed", "detail": "Invalid path or extraction limits"]
        }
        guard let frameworks = Bundle.main.privateFrameworksURL else {
          return ["status": "extraction-failed", "detail": "Application frameworks directory is unavailable"]
        }
        let pdfiumPath = frameworks.appendingPathComponent("pdfium.framework/pdfium").path
        guard let result = anydoc_mobile_extract(path, filename, pdfiumPath, UInt64(maxBytes), UInt32(maxChars), UInt32(maxPages)) else {
          return ["status": "extraction-failed", "detail": "Native parser returned no result"]
        }
        defer { anydoc_mobile_free(result) }
        // Decode natively: JS receives a bounded result object, never an input buffer.
        let data = Data(bytes: result, count: strlen(result))
        guard let output = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
          return ["status": "extraction-failed", "detail": "Invalid native parser result"]
        }
        return output
      }
    }.runOnQueue(Self.parserQueue)
  }
}
