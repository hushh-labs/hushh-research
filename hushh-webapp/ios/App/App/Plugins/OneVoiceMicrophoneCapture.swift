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
