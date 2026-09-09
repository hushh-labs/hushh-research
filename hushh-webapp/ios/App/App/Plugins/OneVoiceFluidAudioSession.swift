@preconcurrency import AVFoundation
@preconcurrency import CoreML
import FluidAudio
import Foundation

/// One optional transcript provider inside the existing One Voice session.
///
/// It has no direct route, action, consent, or backend capability. Its only
/// output is the same transcript event lifecycle used by Apple Speech and the
/// web adapters. The owning plugin keeps microphone ownership singular.
@MainActor
final class OneVoiceFluidAudioSession {
    struct Transcript {
        let sessionID: String
        let sequence: Int
        let kind: String
        let text: String
        let errorCode: String?
    }

    private let manager: StreamingEouAsrManager
    private let sessionID: String
    private let onTranscript: (Transcript) -> Void
    private var sequence = 0
    private var stopped = false

    init(
        sessionID: String,
        modelsDirectory: URL,
        onTranscript: @escaping (Transcript) -> Void
    ) {
        let configuration = MLModelConfiguration()
        configuration.computeUnits = .all
        self.manager = StreamingEouAsrManager(
            configuration: configuration,
            chunkSize: .ms160,
            eouDebounceMs: 1_280,
            debugFeatures: false
        )
        self.sessionID = sessionID
        self.onTranscript = onTranscript
        self.modelsDirectory = modelsDirectory
    }

    private let modelsDirectory: URL

    func start() async throws {
        await manager.setPartialTranscriptCallback { [weak self] text in
            guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return
            }
            Task { @MainActor in
                self?.emit(kind: "partial", text: text)
            }
        }
        try await manager.loadModels(from: modelsDirectory)
    }

    /// Frames are handed off immediately; this adapter does not create a
    /// second PCM store. FluidAudio processes completed chunks as they arrive.
    func append(_ buffer: AVAudioPCMBuffer) {
        guard !stopped else { return }
        let manager = manager
        Task { [weak self] in
            guard let self, !self.stopped else { return }
            do {
                try await manager.appendAudio(buffer)
                try await manager.processBufferedAudio()
            } catch {
                self.emit(kind: "error", text: "", errorCode: "speech_provider_error")
            }
        }
    }

    func stop(emitEnd: Bool) async {
        guard !stopped else { return }
        stopped = true
        do {
            let finalText = try await manager.finish()
            if !finalText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                emit(kind: "final", text: finalText)
            }
        } catch {
            emit(kind: "error", text: "", errorCode: "speech_provider_error")
        }
        await manager.cleanup()
        if emitEnd {
            emit(kind: "end", text: "")
        }
    }

    private func emit(kind: String, text: String, errorCode: String? = nil) {
        sequence += 1
        onTranscript(
            Transcript(
                sessionID: sessionID,
                sequence: sequence,
                kind: kind,
                text: String(text.prefix(8_000)),
                errorCode: errorCode
            )
        )
    }
}
