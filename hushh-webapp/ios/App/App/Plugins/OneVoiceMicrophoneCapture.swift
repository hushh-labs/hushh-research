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

    /// A transport-safe microphone frame. One Voice's online protocol uses
    /// 16 kHz, mono, signed little-endian PCM. This value is deliberately
    /// transient: callers must send it immediately and must not persist it.
    public struct PCM16Frame {
        public let data: Data
        public let sequence: Int
        public let sampleRate: Int
        public let channels: Int
        public let frameCount: Int
        /// A bounded RMS value for UI activity only. It is not speech
        /// recognition, a transcript, or a durable audio measurement.
        public let level: Double
    }

    public typealias PCM16FrameHandler = (_ frame: PCM16Frame) -> Void
    public typealias PCM16ErrorHandler = (_ error: CaptureError) -> Void

    public enum CaptureError: Error {
        case alreadyRunning
        case pcm16OutputFormatUnavailable
        case pcm16ConverterUnavailable
        case pcm16ConversionFailed

        public var safeCode: String {
            switch self {
            case .alreadyRunning:
                return "capture_already_running"
            case .pcm16OutputFormatUnavailable:
                return "pcm_output_format_unavailable"
            case .pcm16ConverterUnavailable:
                return "pcm_converter_unavailable"
            case .pcm16ConversionFailed:
                return "pcm_conversion_failed"
            }
        }
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
        try startCapture(
            bufferSize: bufferSize,
            onInputFormat: nil,
            onFrame: onFrame
        )
    }

    /// Starts the primary online-audio path. The microphone remains the
    /// single native owner, but frames are resampled before they cross the
    /// Capacitor boundary so web and iOS use the same One Voice PCM contract.
    public func startPCM16(
        bufferSize: AVAudioFrameCount = 1_024,
        sampleRate: Double = 16_000,
        onFrame: @escaping PCM16FrameHandler,
        onError: @escaping PCM16ErrorHandler
    ) throws {
        let encoderBox = PCM16EncoderBox()
        try startCapture(
            bufferSize: bufferSize,
            onInputFormat: { inputFormat in
                encoderBox.encoder = try PCM16FrameEncoder(
                    inputFormat: inputFormat,
                    sampleRate: sampleRate
                )
            },
            onFrame: { buffer, _, sequence in
                guard let encoder = encoderBox.encoder else {
                    encoderBox.reportOnce(.pcm16ConverterUnavailable, handler: onError)
                    return
                }
                do {
                    onFrame(try encoder.encode(buffer, sequence: sequence))
                } catch let error as CaptureError {
                    encoderBox.reportOnce(error, handler: onError)
                } catch {
                    encoderBox.reportOnce(.pcm16ConversionFailed, handler: onError)
                }
            }
        )
    }

    private func startCapture(
        bufferSize: AVAudioFrameCount,
        onInputFormat: ((AVAudioFormat) throws -> Void)?,
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

        // One Voice keeps capture running while Gemini's reply plays in the
        // WebView. `.record` removes the output route, so a valid streamed
        // reply was silent for the entire active speech session. This is a
        // streamed WebView conversation, not an audio measurement or a native
        // Voice I/O call: Apple documents both `.measurement` and a chat mode
        // without Voice I/O / AVAudioEngine voice processing as disabling
        // output dynamics and lowering playback level. Keep the standard
        // duplex mode so streamed spoken replies retain normal system volume
        // while capture remains active.
        try audioSession.setCategory(
            .playAndRecord,
            mode: .default,
            options: [.duckOthers, .defaultToSpeaker, .allowBluetooth]
        )
        try audioSession.setActive(true, options: .notifyOthersOnDeactivation)
        // Safe device diagnostics only: the route type identifies whether a
        // playback path exists without logging audio, a transcript, or a
        // personally named Bluetooth accessory.
        let outputPort = audioSession.currentRoute.outputs.first?.portType.rawValue ?? "none"
        print(
            "[VOICE_AUDIO_SESSION] category=\(audioSession.category.rawValue) " +
            "mode=\(audioSession.mode.rawValue) output=\(outputPort)"
        )

        let inputNode = audioEngine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        do {
            try onInputFormat?(format)
        } catch {
            try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
            throw error
        }
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

private final class PCM16EncoderBox {
    var encoder: PCM16FrameEncoder?
    private var reportedError = false
    private let lock = NSLock()

    func reportOnce(
        _ error: OneVoiceMicrophoneCapture.CaptureError,
        handler: OneVoiceMicrophoneCapture.PCM16ErrorHandler
    ) {
        lock.lock()
        let shouldReport = !reportedError
        reportedError = true
        lock.unlock()
        if shouldReport {
            handler(error)
        }
    }
}

private final class PCM16FrameEncoder {
    private let converter: AVAudioConverter
    private let outputFormat: AVAudioFormat

    init(inputFormat: AVAudioFormat, sampleRate: Double) throws {
        guard sampleRate == 16_000,
              let outputFormat = AVAudioFormat(
                  commonFormat: .pcmFormatInt16,
                  sampleRate: sampleRate,
                  channels: 1,
                  interleaved: true
              )
        else {
            throw OneVoiceMicrophoneCapture.CaptureError.pcm16OutputFormatUnavailable
        }
        guard let converter = AVAudioConverter(from: inputFormat, to: outputFormat) else {
            throw OneVoiceMicrophoneCapture.CaptureError.pcm16ConverterUnavailable
        }
        self.converter = converter
        self.outputFormat = outputFormat
    }

    func encode(
        _ input: AVAudioPCMBuffer,
        sequence: Int
    ) throws -> OneVoiceMicrophoneCapture.PCM16Frame {
        let ratio = outputFormat.sampleRate / max(input.format.sampleRate, 1)
        let capacity = AVAudioFrameCount(
            max(1, ceil(Double(input.frameLength) * ratio) + 32)
        )
        guard let output = AVAudioPCMBuffer(
            pcmFormat: outputFormat,
            frameCapacity: capacity
        ) else {
            throw OneVoiceMicrophoneCapture.CaptureError.pcm16ConversionFailed
        }

        var suppliedInput = false
        var conversionError: NSError?
        let status = converter.convert(to: output, error: &conversionError) { _, inputStatus in
            if suppliedInput {
                inputStatus.pointee = .noDataNow
                return nil
            }
            suppliedInput = true
            inputStatus.pointee = .haveData
            return input
        }
        guard status != .error,
              output.frameLength > 0,
              let samples = output.int16ChannelData?[0]
        else {
            _ = conversionError
            throw OneVoiceMicrophoneCapture.CaptureError.pcm16ConversionFailed
        }

        let frameCount = Int(output.frameLength)
        let byteCount = frameCount * MemoryLayout<Int16>.size
        let pcm = Data(bytes: samples, count: byteCount)
        var squared = 0.0
        for index in 0..<frameCount {
            let sample = Double(samples[index]) / 32_768.0
            squared += sample * sample
        }
        let level = min(1, sqrt(squared / Double(frameCount)))
        return OneVoiceMicrophoneCapture.PCM16Frame(
            data: pcm,
            sequence: sequence,
            sampleRate: Int(outputFormat.sampleRate),
            channels: Int(outputFormat.channelCount),
            frameCount: frameCount,
            level: level
        )
    }
}
