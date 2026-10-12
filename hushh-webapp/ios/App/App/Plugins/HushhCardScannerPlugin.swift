import Foundation
import Capacitor
import Vision
import ImageIO

/// Local-only card text recognition. Photos and results are never persisted or logged.
@objc(HushhCardScannerPlugin)
public class HushhCardScannerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "HushhCardScannerPlugin"
    public let jsName = "HushhCardScanner"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "recognize", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise)
    ]

    private let lock = NSLock()
    private var requests: [String: VNRecognizeTextRequest] = [:]

    @objc func cancel(_ call: CAPPluginCall) {
        if let id = call.getString("requestId") {
            lock.lock()
            let request = requests.removeValue(forKey: id)
            lock.unlock()
            request?.cancel()
        }
        call.resolve()
    }

    @objc func recognize(_ call: CAPPluginCall) {
        guard let id = call.getString("requestId"), UUID(uuidString: id) != nil,
              let encoded = call.getString("image"), encoded.utf8.count <= 21_000_000,
              let data = Data(base64Encoded: encoded), data.count <= 15 * 1024 * 1024 else {
            call.reject("Invalid image", "invalid_image")
            return
        }
        let request = VNRecognizeTextRequest()
        lock.lock()
        guard requests.isEmpty else {
            lock.unlock()
            call.reject("Scanner busy", "scan_busy")
            return
        }
        requests[id] = request
        lock.unlock()
        DispatchQueue.global(qos: .userInitiated).async {
            autoreleasepool {
                defer {
                    self.lock.lock()
                    if self.requests[id] === request { self.requests.removeValue(forKey: id) }
                    self.lock.unlock()
                }
                self.lock.lock()
                let active = self.requests[id] === request
                self.lock.unlock()
                guard active else { call.reject("Scan cancelled", "scan_cancelled"); return }
                guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
                    call.reject("Invalid image", "invalid_image")
                    return
                }
                let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
                let rawOrientation = (properties?[kCGImagePropertyOrientation] as? NSNumber)?.uint32Value ?? 1
                let orientation = CGImagePropertyOrientation(rawValue: rawOrientation) ?? .up
                request.recognitionLevel = .accurate
                request.usesLanguageCorrection = false
                request.recognitionLanguages = ["en-US"]
                let timeout = DispatchWorkItem { request.cancel() }
                DispatchQueue.global().asyncAfter(deadline: .now() + 30, execute: timeout)
                defer { timeout.cancel() }
                do {
                    try VNImageRequestHandler(cgImage: image, orientation: orientation).perform([request])
                    self.lock.lock()
                    let stillActive = self.requests[id] === request
                    self.lock.unlock()
                    guard stillActive else { call.reject("Scan cancelled", "scan_cancelled"); return }
                    let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
                    call.resolve(["text": text])
                } catch {
                    call.reject("Could not recognize card", "recognition_failed")
                }
            }
        }
    }
}
