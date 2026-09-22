import Foundation
import Capacitor

/**
 * HushhStream: a generic streaming HTTP transport for the WebView.
 *
 * WKWebView buffers a `fetch()` response body until the request completes,
 * and the app routes native calls through CapacitorHttp, which returns whole
 * bodies; a server-sent event stream therefore reaches the page only when it
 * has ended. This plugin performs the request with a delegate `URLSession`
 * and forwards the raw response bytes as they arrive (`hushhStreamEvent`,
 * `type: "chunk"`, base64), then one `end` event. It carries bytes only: no
 * SSE parsing, no JSON, no retry. Several streams may run at once, each
 * addressed by the caller's `streamId`.
 *
 * `open` resolves when the response headers arrive (`{status, headers}`), so
 * a non-2xx status is known before any body byte; the body still streams so
 * the JavaScript side can read the error payload. The backend URL for an
 * app-relative path resolves the way every other plugin resolves it
 * (`HushhProxyClient`). Mirrors the URLSession pattern of `KaiPlugin`.
 */
@objc(HushhStreamPlugin)
public class HushhStreamPlugin: CAPPlugin, CAPBridgedPlugin, URLSessionDataDelegate {

    private let TAG = "HushhStreamPlugin"

    // MARK: - CAPBridgedPlugin Protocol (MUST be declared before any other properties)
    public let identifier = "HushhStreamPlugin"
    public let jsName = "HushhStream"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
    ]

    private static let eventName = "hushhStreamEvent"
    private static let requestTimeout: TimeInterval = 180
    private static let resourceTimeout: TimeInterval = 900

    private final class StreamState {
        let streamId: String
        var openCall: CAPPluginCall?
        var task: URLSessionDataTask?
        var status: Int = 0
        var cancelled = false

        init(streamId: String, openCall: CAPPluginCall) {
            self.streamId = streamId
            self.openCall = openCall
        }
    }

    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = HushhStreamPlugin.requestTimeout
        config.timeoutIntervalForResource = HushhStreamPlugin.resourceTimeout
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    private let registryLock = NSLock()
    private var byTaskIdentifier: [Int: StreamState] = [:]
    private var byStreamId: [String: StreamState] = [:]

    // MARK: - Registry

    private func register(_ state: StreamState, task: URLSessionDataTask) {
        registryLock.lock()
        state.task = task
        byTaskIdentifier[task.taskIdentifier] = state
        byStreamId[state.streamId] = state
        registryLock.unlock()
    }

    private func state(for task: URLSessionTask) -> StreamState? {
        registryLock.lock()
        defer { registryLock.unlock() }
        return byTaskIdentifier[task.taskIdentifier]
    }

    private func state(for streamId: String) -> StreamState? {
        registryLock.lock()
        defer { registryLock.unlock() }
        return byStreamId[streamId]
    }

    private func remove(_ state: StreamState) {
        registryLock.lock()
        if let task = state.task {
            byTaskIdentifier.removeValue(forKey: task.taskIdentifier)
        }
        byStreamId.removeValue(forKey: state.streamId)
        registryLock.unlock()
    }

    private func emit(_ data: [String: Any]) {
        DispatchQueue.main.async { [weak self] in
            self?.notifyListeners(HushhStreamPlugin.eventName, data: data)
        }
    }

    private func emitEnd(_ state: StreamState, error: String?, code: String?) {
        var payload: [String: Any] = ["streamId": state.streamId, "type": "end"]
        if let error = error { payload["error"] = error }
        if let code = code { payload["code"] = code }
        emit(payload)
    }

    // MARK: - Plugin Methods

    @objc func open(_ call: CAPPluginCall) {
        guard let streamId = call.getString("streamId")?.trimmingCharacters(in: .whitespacesAndNewlines),
              !streamId.isEmpty else {
            call.reject("Missing streamId")
            return
        }
        guard let path = call.getString("path"), !path.isEmpty else {
            call.reject("Missing path")
            return
        }
        if state(for: streamId) != nil {
            call.reject("A stream with this id is already open", "HUSHH_STREAM_BUSY")
            return
        }

        let urlString: String
        if path.lowercased().hasPrefix("http://") || path.lowercased().hasPrefix("https://") {
            urlString = path
        } else {
            let backendUrl = HushhProxyClient.resolveBackendUrl(call: call, plugin: self, jsName: jsName)
            guard !backendUrl.isEmpty else {
                call.reject("Backend URL is not configured", "HUSHH_STREAM_NO_BACKEND")
                return
            }
            urlString = "\(backendUrl)\(path.hasPrefix("/") ? path : "/\(path)")"
        }
        guard let url = URL(string: urlString) else {
            call.reject("Invalid URL: \(urlString)")
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = (call.getString("method") ?? "GET").uppercased()
        if let headers = call.getObject("headers") {
            for (key, value) in headers {
                if let text = value as? String {
                    request.setValue(text, forHTTPHeaderField: key)
                }
            }
        }
        if let body = call.getString("body"), request.httpMethod != "GET" {
            request.httpBody = body.data(using: .utf8)
        }

        // The call is held by the stream state and settled when the response
        // headers arrive (the same late-resolve pattern as KaiPlugin).
        let state = StreamState(streamId: streamId, openCall: call)
        let task = session.dataTask(with: request)
        register(state, task: task)
        task.resume()
    }

    @objc func cancel(_ call: CAPPluginCall) {
        guard let streamId = call.getString("streamId"), let state = state(for: streamId) else {
            call.resolve(["cancelled": false])
            return
        }
        state.cancelled = true
        state.task?.cancel()
        call.resolve(["cancelled": true])
    }

    // MARK: - URLSessionDataDelegate

    public func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        guard let state = state(for: dataTask) else {
            completionHandler(.cancel)
            return
        }
        let http = response as? HTTPURLResponse
        let status = http?.statusCode ?? 0
        state.status = status
        var headers: [String: String] = [:]
        if let http = http {
            for (key, value) in http.allHeaderFields {
                if let name = key as? String, let text = value as? String {
                    headers[name.lowercased()] = text
                }
            }
        }
        let openCall = state.openCall
        state.openCall = nil
        DispatchQueue.main.async {
            openCall?.resolve(["status": status, "headers": headers])
        }
        completionHandler(.allow)
    }

    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let state = state(for: dataTask), !state.cancelled, !data.isEmpty else { return }
        emit([
            "streamId": state.streamId,
            "type": "chunk",
            "base64": data.base64EncodedString(),
        ])
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let state = state(for: task) else { return }
        remove(state)

        // A failure before the headers arrived settles the pending `open`.
        if let openCall = state.openCall {
            state.openCall = nil
            DispatchQueue.main.async {
                let code = state.cancelled ? "CANCELLED" : HushhStreamPlugin.errorCode(error)
                openCall.reject(error?.localizedDescription ?? "Stream request failed", code)
            }
        }

        if state.cancelled {
            emitEnd(state, error: "Cancelled", code: "CANCELLED")
            return
        }
        if let error = error {
            emitEnd(state, error: error.localizedDescription, code: HushhStreamPlugin.errorCode(error))
            return
        }
        emitEnd(state, error: nil, code: nil)
    }

    private static func errorCode(_ error: Error?) -> String {
        guard let error = error as NSError? else { return "NETWORK" }
        switch error.code {
        case NSURLErrorCancelled: return "CANCELLED"
        case NSURLErrorTimedOut: return "TIMEOUT"
        default: return "NETWORK"
        }
    }
}
