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
                      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                      let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
                      let height = properties[kCGImagePropertyPixelHeight] as? NSNumber,
                      width.intValue > 0, height.intValue > 0,
                      width.intValue <= 10000, height.intValue <= 10000,
                      width.intValue * height.intValue <= 24_000_000,
                      let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                        kCGImageSourceCreateThumbnailFromImageAlways: true,
                        kCGImageSourceCreateThumbnailWithTransform: true,
                        kCGImageSourceThumbnailMaxPixelSize: 2400
                      ] as CFDictionary) else {
                    call.reject("Invalid image", "invalid_image")
                    return
                }
                request.recognitionLevel = .accurate
                request.usesLanguageCorrection = false
                request.recognitionLanguages = ["en-US"]
                if #available(iOS 16.0, *) { request.automaticallyDetectsLanguage = true }
                let timeout = DispatchWorkItem { request.cancel() }
                DispatchQueue.global().asyncAfter(deadline: .now() + 30, execute: timeout)
                defer { timeout.cancel() }
                do {
                    try VNImageRequestHandler(cgImage: image, orientation: .up).perform([request])
                    self.lock.lock()
                    let stillActive = self.requests[id] === request
                    self.lock.unlock()
                    guard stillActive else { call.reject("Scan cancelled", "scan_cancelled"); return }
                    let lines = (request.results ?? []).compactMap { observation -> String? in
                        guard let candidate = observation.topCandidates(1).first, candidate.confidence >= 0.5 else { return nil }
                        return candidate.string
                    }
                    // Project permitted candidate fields inside the native boundary.
                    // No raw OCR transcript, short security code or PIN crosses the bridge.
                    var fields: [String] = []
                    let pan = try NSRegularExpression(pattern: "(?<![\\p{L}\\p{N}])[0-9](?:[ \\t-]*[0-9])*(?![\\p{L}\\p{N}])")
                    let date = try NSRegularExpression(pattern: "\\b(?:0[1-9]|1[0-2])\\s*/\\s*(?:20)?[0-9]{2}\\b")
                    let name = try NSRegularExpression(pattern: "^[\\p{L}][\\p{L}\\p{M} .'’-]{2,79}$")
                    let marketing = try NSRegularExpression(pattern: "(?i)\\b(?:bank|card|credit|debit|visa|mastercard|american|express|discover|rupay|platinum|gold|signature|world|valid|thru|from|until|expiry|expires|member|since|service|authorized)\\b")
                    for (index, line) in lines.enumerated() {
                        let range = NSRange(line.startIndex..<line.endIndex, in: line)
                        let numeric = date.stringByReplacingMatches(in: line, range: range, withTemplate: "/")
                        for match in pan.matches(in: numeric, range: NSRange(numeric.startIndex..<numeric.endIndex, in: numeric)) {
                            if let value = Range(match.range, in: numeric) { let candidate = String(numeric[value]); let count = candidate.filter { $0.isNumber }.count; if count >= 12 && count <= 19 { fields.append(candidate) } }
                        }
                        for match in date.matches(in: line, range: range) {
                            if let value = Range(match.range, in: line) {
                                let explicit = line.range(of: "issue|valid\\s+from|member\\s+since|valid\\s+(?:thru|through|until)|exp", options: [.regularExpression, .caseInsensitive]) != nil
                                let previous = index > 0 ? lines[index - 1] : ""
                                let standalone = previous.range(of: "^(?:valid\\s+(?:from|thru|through|until)|exp(?:iry|ires|iration)?|issued?)\\s*:?$", options: [.regularExpression, .caseInsensitive]) != nil
                                let label = explicit ? line : standalone ? previous : ""
                                let issue = label.range(of: "issue|valid\\s+from|member\\s+since", options: [.regularExpression, .caseInsensitive]) != nil
                                let expiry = label.range(of: "valid\\s+(?:thru|through|until)|exp", options: [.regularExpression, .caseInsensitive]) != nil
                                fields.append((issue ? "ISSUED " : expiry ? "EXPIRY " : "") + String(line[value]))
                            }
                        }
                        let candidate = line.replacingOccurrences(of: "^(?:cardholder|card holder|name on card)(?: name)?\\s*:?\\s*", with: "", options: [.regularExpression, .caseInsensitive])
                        let candidateRange = NSRange(candidate.startIndex..<candidate.endIndex, in: candidate)
                        if name.firstMatch(in: candidate, range: candidateRange) != nil && marketing.firstMatch(in: candidate, range: candidateRange) == nil && candidate.split(separator: " ").count >= 2 {
                            fields.append(candidate)
                        }
                    }
                    // Rejoin only adjacent numeric observations on the same printed
                    // row. Transcript order can otherwise concatenate a short code.
                    let numeric = (request.results ?? []).compactMap { observation -> (String, CGRect, Bool)? in
                        guard let candidate = observation.topCandidates(1).first,
                              candidate.string.range(of: "^[0-9]{1,6}$", options: .regularExpression) != nil else { return nil }
                        return (candidate.string, observation.boundingBox, candidate.confidence >= 0.65)
                    }.sorted { $0.1.minX < $1.1.minX }
                    var rows: [[(String, CGRect, Bool)]] = []
                    for item in numeric {
                        if let index = rows.firstIndex(where: { row in
                            let anchor = row[0].1, height = min(anchor.height, item.1.height)
                            return min(anchor.maxY, item.1.maxY) - max(anchor.minY, item.1.minY) >= height * 0.6
                        }) { rows[index].append(item) } else { rows.append([item]) }
                    }
                    for row in rows {
                        var value = "", previous: CGRect? = nil, confident = true
                        for item in row.sorted(by: { $0.1.minX < $1.1.minX }) {
                            if let box = previous {
                                let height = min(box.height, item.1.height)
                                if item.1.minX < box.maxX - height * 0.2 || item.1.minX - box.maxX > height * 1.5 || max(box.height, item.1.height) > height * 1.5 {
                                    if confident && value.count >= 12 && value.count <= 19 { fields.append(value) }
                                    value = ""; confident = true
                                }
                            }
                            value += item.0; previous = item.1; confident = confident && item.2
                        }
                        if confident && value.count >= 12 && value.count <= 19 { fields.append(value) }
                    }
                    call.resolve(["cardText": fields.joined(separator: "\n")])
                } catch {
                    call.reject("Could not recognize card", "recognition_failed")
                }
            }
        }
    }
}
