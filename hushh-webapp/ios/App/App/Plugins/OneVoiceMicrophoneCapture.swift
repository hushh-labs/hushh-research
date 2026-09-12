import AVFoundation
import Foundation

/// The single native microphone owner for One Voice.
///
/// This component deliberately has no transcript, model, or action knowledge.
/// It starts capture before provider/network setup and delivers each PCM frame
/// immediately to the selected speech provider. Keeping it separate lets the
/// physical-device gate measure the production capture path without retaining
/// audio or adding a second voice session owner.
public final class OneVoiceMicrophoneCapture {
    public typealias FrameHandler = (
        _ buffer: AVAudioPCMBuffer,
        _ time: AVAudioTime,
        _ sequence: Int
    ) -> Void

    public enum CaptureError: Error {
        case alreadyRunning
    }

    private let audioEngine: AVAudioEngine
    private let audioSession: AVAudioSession
    private let stateLock = NSLock()
    private static let ownershipLock = NSLock()
    private static var activeOwner: ObjectIdentifier?
    private var running = false
    private var frameSequence = 0

    public init(
        audioEngine: AVAudioEngine = AVAudioEngine(),
        audioSession: AVAudioSession = .sharedInstance()
    ) {
        self.audioEngine = audioEngine
        self.audioSession = audioSession
    }

    deinit {
        stop()
    }

    public var isRunning: Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return running
    }

    /// Opens capture and delivers monotonic frame sequences. The caller must
    /// call stop before another One Voice capture owner can begin.
    public func start(
        bufferSize: AVAudioFrameCount = 1_024,
        onFrame: @escaping FrameHandler
    ) throws {
        stateLock.lock()
        let alreadyRunning = running
        stateLock.unlock()
        guard !alreadyRunning else {
            throw CaptureError.alreadyRunning
        }
        guard claimGlobalOwnership() else {
            throw CaptureError.alreadyRunning
        }
        var started = false
        defer {
            if !started {
                releaseGlobalOwnership()
            }
        }

        try audioSession.setCategory(.record, mode: .measurement, options: [.duckOthers])
        try audioSession.setActive(true, options: .notifyOthersOnDeactivation)

        let inputNode = audioEngine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        inputNode.removeTap(onBus: 0)
        inputNode.installTap(
            onBus: 0,
            bufferSize: bufferSize,
            format: format
        ) { [weak self] buffer, time in
            guard let self else { return }
            onFrame(buffer, time, self.nextFrameSequence())
        }

        do {
            audioEngine.prepare()
            try audioEngine.start()
            stateLock.lock()
            running = true
            stateLock.unlock()
            started = true
        } catch {
            inputNode.removeTap(onBus: 0)
            try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
            throw error
        }
    }

    public func stop() {
        stateLock.lock()
        guard running else { stateLock.unlock(); return }
        running = false
        stateLock.unlock()
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        audioEngine.reset()
        try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)

        stateLock.lock()
        running = false
        frameSequence = 0
        stateLock.unlock()
        releaseGlobalOwnership()
    }

    private func nextFrameSequence() -> Int {
        stateLock.lock()
        defer { stateLock.unlock() }
        frameSequence += 1
        return frameSequence
    }

    private func claimGlobalOwnership() -> Bool {
        Self.ownershipLock.lock()
        defer { Self.ownershipLock.unlock() }
        guard Self.activeOwner == nil else {
            return false
        }
        Self.activeOwner = ObjectIdentifier(self)
        return true
    }

    private func releaseGlobalOwnership() {
        Self.ownershipLock.lock()
        defer { Self.ownershipLock.unlock() }
        if Self.activeOwner == ObjectIdentifier(self) {
            Self.activeOwner = nil
        }
    }
}

/// A bounded, transient recording over the existing microphone owner.
final class OneCommandRecording {
    let sessionID: String
    private let capture = OneVoiceMicrophoneCapture()
    private let lock = NSLock()
    private var pcm = Data()
    private var converter: AVAudioConverter?
    private var conversionFailed = false
    private var closed = false
    private var deadline: DispatchWorkItem?
    private let output = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true)!
    private let maximumBytes: Int

    init(sessionID: String, maxDurationMs: Int) {
        self.sessionID = sessionID
        maximumBytes = min(60_000, max(1, maxDurationMs)) * 32
    }

    func start() throws {
        try capture.start { [weak self] buffer, _, _ in self?.append(buffer) }
        let stop = DispatchWorkItem { [weak self] in self?.capture.stop() }
        deadline = stop
        DispatchQueue.main.asyncAfter(deadline: .now() + Double(maximumBytes) / 32_000, execute: stop)
    }

    private func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        defer { lock.unlock() }
        guard !closed, pcm.count < maximumBytes else { return }
        if converter == nil { converter = AVAudioConverter(from: buffer.format, to: output) }
        guard let converter else { conversionFailed = true; return }
        let capacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * 16_000 / buffer.format.sampleRate) + 64)
        guard let converted = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: capacity) else { conversionFailed = true; return }
        var supplied = false
        var error: NSError?
        converter.convert(to: converted, error: &error) { _, status in
            if supplied { status.pointee = .noDataNow; return nil }
            supplied = true
            status.pointee = .haveData
            return buffer
        }
        if error != nil { conversionFailed = true; return }
        appendConverted(converted)
    }

    private func appendConverted(_ buffer: AVAudioPCMBuffer) {
        guard let samples = buffer.int16ChannelData?[0] else { return }
        let count = min(Int(buffer.frameLength) * 2, maximumBytes - pcm.count)
        if count > 0 { pcm.append(UnsafeBufferPointer(start: UnsafeRawPointer(samples).assumingMemoryBound(to: UInt8.self), count: count)) }
    }

    func finish() throws -> [String: Any] {
        deadline?.cancel()
        capture.stop()
        lock.lock()
        defer { lock.unlock() }
        guard !closed else { throw NSError(domain: "OneCommandCapture", code: 1) }
        closed = true
        // Drain the converter after the final tap, preserving its resampling tail.
        if let converter, let tail = AVAudioPCMBuffer(pcmFormat: output, frameCapacity: 128) {
            var error: NSError?
            converter.convert(to: tail, error: &error) { _, status in status.pointee = .endOfStream; return nil }
            if error != nil { conversionFailed = true }
            appendConverted(tail)
        }
        guard !conversionFailed, !pcm.isEmpty else { pcm.removeAll(); throw NSError(domain: "OneCommandCapture", code: 2) }
        let byteCount = pcm.count
        var wav = Data()
        func word<T: FixedWidthInteger>(_ value: T) { var little = value.littleEndian; withUnsafeBytes(of: &little) { wav.append(contentsOf: $0) } }
        wav.append(contentsOf: "RIFF".utf8); word(UInt32(36 + byteCount)); wav.append(contentsOf: "WAVEfmt ".utf8)
        word(UInt32(16)); word(UInt16(1)); word(UInt16(1)); word(UInt32(16_000)); word(UInt32(32_000))
        word(UInt16(2)); word(UInt16(16)); wav.append(contentsOf: "data".utf8); word(UInt32(byteCount)); wav.append(pcm)
        pcm.removeAll(keepingCapacity: false)
        return ["sessionId": sessionID, "audioBase64": wav.base64EncodedString(), "mimeType": "audio/wav",
                "sampleRate": 16_000, "channels": 1, "durationMs": Double(byteCount) / 32]
    }

    func cancel() {
        deadline?.cancel()
        capture.stop()
        lock.lock(); closed = true; pcm.removeAll(keepingCapacity: false); converter = nil; lock.unlock()
    }

    deinit { cancel() }
}
