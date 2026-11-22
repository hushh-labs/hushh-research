import SwiftUI
import UIKit
import ImageIO

/// Public presentation assets only. Article destinations remain registered JS actions.
struct NativeFinanceArtworkSource: Codable, Equatable {
    let url: String
    var admittedURL: URL? {
        guard url.utf16.count <= 2_048, let value = URLComponents(string: url),
              value.scheme == "https", value.user == nil, value.password == nil,
              value.port == nil, value.fragment == nil, let host = value.host?.lowercased(),
              let result = value.url else { return nil }
        if host == "financialmodelingprep.com" {
            guard value.query == nil, result.path.range(of: #"^/image-stock/[^/\\\p{Cc}]{1,64}\.png$"#, options: .regularExpression) != nil else { return nil }
        } else {
            guard ["static.seekingalpha.com", "s.yimg.com", "media.zenfs.com"].contains(host), !result.path.isEmpty else { return nil }
        }
        return result
    }
    static func closed(_ raw: Any) -> Bool {
        guard let value = raw as? [String: Any], Set(value.keys) == ["url"], value["url"] is String else { return false }
        return true
    }
}

private final class NativeFinanceArtworkRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

enum NativeFinanceArtwork {
    static let maximumBytes = 512 * 1_024
    enum Failure: Error { case unsupported, unavailable, oversized }

    /// Header bounds precede decoding. ImageIO creates a small thumbnail, not a full-size UIImage.
    static func thumbnail(_ data: Data) -> UIImage? {
        guard !data.isEmpty, data.count <= maximumBytes,
              let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              CGImageSourceGetCount(source) == 1,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              (1...4_096).contains(width), (1...4_096).contains(height), width * height <= 4_194_304,
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 192,
                kCGImageSourceShouldCacheImmediately: true,
              ] as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }

    static func download(_ source: NativeFinanceArtworkSource) async throws -> Data {
        guard let url = source.admittedURL else { throw Failure.unsupported }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil; configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never; configuration.urlCredentialStorage = nil; configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 8; configuration.timeoutIntervalForResource = 8
        let session = URLSession(configuration: configuration, delegate: NativeFinanceArtworkRedirects(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        return try await withTaskCancellationHandler {
            let (bytes, response) = try await session.bytes(for: URLRequest(url: url))
            guard let response = response as? HTTPURLResponse, response.statusCode == 200,
                  ["image/jpeg", "image/png", "image/webp"].contains(response.mimeType?.lowercased() ?? "") else { throw Failure.unavailable }
            guard response.expectedContentLength <= Int64(maximumBytes) else { throw Failure.oversized }
            var data = Data(); data.reserveCapacity(maximumBytes)
            for try await byte in bytes {
                try Task.checkCancellation()
                guard data.count < maximumBytes else { throw Failure.oversized }
                data.append(byte)
            }
            try Task.checkCancellation()
            return data
        } onCancel: { session.invalidateAndCancel() }
    }
}

/// Follows the authored thumbnail, article-image, company-logo order. Its task
/// belongs to this row and the existing workspace identity, never another lease.
@available(iOS 26.0, *)
struct NativeFinanceNewsCover: View {
    @ObservedObject var model: NativeWorkspaceModel
    let sources: [NativeFinanceArtworkSource]
    @State private var image: UIImage?
    @State private var privacy = HushhSessionPrivacyShield.shared.snapshot()
    private struct Request: Equatable {
        let owner: NativeWorkspaceIdentity; let privacy: Int; let active: Bool
        let sources: [NativeFinanceArtworkSource]
    }
    private var authorized: Bool {
        let privacy = HushhSessionPrivacyShield.shared.snapshot()
        return model.active && privacy.appIsActive && !privacy.shielded && privacy.generation == model.state.privacyGeneration
    }
    private func refreshPrivacy() {
        privacy = HushhSessionPrivacyShield.shared.snapshot()
        if !authorized { image = nil }
    }
    var body: some View {
        let request = Request(owner: model.state.identity, privacy: model.state.privacyGeneration,
            active: model.active && privacy.appIsActive && !privacy.shielded && privacy.generation == model.state.privacyGeneration, sources: sources)
        Group {
            if let image { Image(uiImage: image).resizable().scaledToFill() }
            else { Image(systemName: "newspaper").font(.title2).foregroundStyle(.secondary) }
        }.frame(width: 56, height: 56).background(Color(uiColor: .tertiarySystemFill))
            .clipShape(RoundedRectangle(cornerRadius: 8)).accessibilityHidden(true)
            .onAppear { refreshPrivacy() }
            .onReceive(NotificationCenter.default.publisher(for: HushhSessionPrivacyShield.presentationDidChange)) { _ in refreshPrivacy() }
            .task(id: request) {
                image = nil
                guard request.active, authorized else { return }
                for source in request.sources {
                    do {
                        let data = try await NativeFinanceArtwork.download(source)
                        guard !Task.isCancelled, authorized, model.state.identity == request.owner else { return }
                        guard let prepared = NativeFinanceArtwork.thumbnail(data) else { continue }
                        image = prepared; return
                    } catch {
                        if Task.isCancelled || !authorized || model.state.identity != request.owner { return }
                        // The next authored image is the existing failure behavior.
                    }
                }
            }
    }
}
