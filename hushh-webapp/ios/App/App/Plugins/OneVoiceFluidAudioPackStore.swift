import CryptoKit
import Foundation
@preconcurrency import Network
import UIKit
import ZIPFoundation

/// Public metadata supplied by the private agent runtime for one short-lived
/// model-pack download. The signed URL is intentionally used only for the
/// active transfer and is never written to disk.
struct OneVoiceFluidAudioPackRequest {
    let packID: String
    let version: String
    let sizeBytes: Int
    let checksum: String
    let artifactURL: URL
    let entrypoint: String
    let licenseNoticeID: String
    let licenseApproved: Bool

    init?(
        packID: String,
        version: String,
        sizeBytes: Int,
        checksum: String,
        artifactURL: String,
        entrypoint: String,
        licenseNoticeID: String,
        licenseApproved: Bool
    ) {
        let normalizedID = packID.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedVersion = version.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedChecksum = checksum.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let normalizedEntrypoint = entrypoint.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedNoticeID = licenseNoticeID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard
            normalizedID == OneVoiceFluidAudioPolicy.requiredPackID,
            OneVoiceFluidAudioPackRequest.isSafeIdentifier(normalizedVersion),
            sizeBytes > 0,
            sizeBytes <= OneVoiceFluidAudioPolicy.maximumArchiveBytes,
            normalizedChecksum.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil,
            let url = URL(string: artifactURL),
            OneVoiceFluidAudioPolicy.allowsArtifactURL(url),
            normalizedEntrypoint == OneVoiceFluidAudioPolicy.requiredEntrypoint,
            normalizedNoticeID == OneVoiceFluidAudioPolicy.requiredNoticeID
        else {
            return nil
        }
        self.packID = normalizedID
        self.version = normalizedVersion
        self.sizeBytes = sizeBytes
        self.checksum = normalizedChecksum
        self.artifactURL = url
        self.entrypoint = normalizedEntrypoint
        self.licenseNoticeID = normalizedNoticeID
        self.licenseApproved = licenseApproved
    }

    static func isSafeIdentifier(_ value: String) -> Bool {
        value.range(of: "^[A-Za-z0-9._-]{1,120}$", options: .regularExpression) != nil
    }
}

/// Encodes the release boundary for the NVIDIA-licensed model separately from
/// the Apache-licensed FluidAudio SDK. A server assertion alone cannot enable
/// the model: the native release switch and local notice must agree too.
enum OneVoiceFluidAudioPolicy {
    static let requiredPackID = "fluid-audio-parakeet-eou-120m-coreml-v1"
    static let requiredEntrypoint = "one_voice_fluid_audio_parakeet_eou_120m_v1"
    static let requiredNoticeID = "fluid-audio-parakeet-eou-120m-coreml-v1"
    static let minimumPhysicalMemoryBytes = UInt64(4 * 1024 * 1024 * 1024)
    static let maximumArchiveBytes = 3 * 1024 * 1024 * 1024
    static let unpackingReserveBytes = Int64(64 * 1024 * 1024)

    private static let signatureQueryKeys: Set<String> = [
        "signature",
        "x-amz-signature",
        "x-goog-signature",
        "sig",
    ]
    private static let expiryQueryKeys: Set<String> = [
        "expires",
        "x-amz-expires",
        "x-goog-expires",
        "se",
    ]

    private final class NetworkPathProbe: @unchecked Sendable {
        private let lock = NSLock()
        private var resolved = false
        private let continuation: CheckedContinuation<Bool, Never>

        init(_ continuation: CheckedContinuation<Bool, Never>) {
            self.continuation = continuation
        }

        func resolve(_ available: Bool) -> Bool {
            lock.lock()
            defer { lock.unlock() }
            guard !resolved else { return false }
            resolved = true
            continuation.resume(returning: available)
            return true
        }
    }

    private struct Notices: Decodable {
        struct Artifact: Decodable {
            let noticeID: String
            let approvalState: String?
            let releaseEnabled: Bool?

            enum CodingKeys: String, CodingKey {
                case noticeID = "notice_id"
                case approvalState = "approval_state"
                case releaseEnabled = "release_enabled"
            }
        }

        let artifacts: [Artifact]
    }

    static func allows(
        _ request: OneVoiceFluidAudioPackRequest,
        bundle: Bundle = .main
    ) -> Bool {
        guard
            request.licenseApproved,
            runtimeIsEnabled(bundle: bundle),
            let noticesURL = bundle.url(forResource: "OneVoiceModelNotices", withExtension: "json"),
            let data = try? Data(contentsOf: noticesURL),
            let notices = try? JSONDecoder().decode(Notices.self, from: data),
            let artifact = notices.artifacts.first(where: { $0.noticeID == request.licenseNoticeID })
        else {
            return false
        }
        return artifact.approvalState == "approved" && artifact.releaseEnabled == true
    }

    static func runtimeIsEnabled(bundle: Bundle = .main) -> Bool {
        bundle.object(forInfoDictionaryKey: "OneVoiceFluidAudioEnabled") as? Bool == true
            && bundle.object(forInfoDictionaryKey: "OneVoiceFluidAudioBenchmarkEligible") as? Bool == true
    }

    /// The bridge receives an ephemeral URL, never a reusable object identity.
    /// Accept only the UAT model bucket compiled into this UAT-backed binary;
    /// an injected WebView caller cannot use the native pack store to install a
    /// different signed HTTPS payload.
    static func allowsArtifactURL(_ url: URL, bundle: Bundle = .main) -> Bool {
        guard
            url.scheme?.lowercased() == "https",
            url.host?.lowercased() == "storage.googleapis.com",
            let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else {
            return false
        }
        let queryNames = Set((components.queryItems ?? []).map { $0.name.lowercased() })
        guard
            !signatureQueryKeys.isDisjoint(with: queryNames),
            !expiryQueryKeys.isDisjoint(with: queryNames)
        else {
            return false
        }
        let pathParts = url.path.split(separator: "/", omittingEmptySubsequences: true)
        guard let bucket = pathParts.first else { return false }
        let allowedBuckets = bundle.object(
            forInfoDictionaryKey: "OneVoiceModelPackAllowedBuckets"
        ) as? [String] ?? []
        return allowedBuckets.contains(String(bucket))
    }

    /// The native path owns the device checks for its large optional pack.
    /// These checks do not decide whether a feature is permitted; they only
    /// prevent a qualifying pack from exhausting a device before its verified
    /// transfer begins.
    static func hasSufficientResources(
        request: OneVoiceFluidAudioPackRequest,
        storageDirectory: URL
    ) -> Bool {
        guard ProcessInfo.processInfo.physicalMemory >= minimumPhysicalMemoryBytes else {
            return false
        }
        guard let values = try? storageDirectory.resourceValues(forKeys: [
            .volumeAvailableCapacityForImportantUsageKey,
            .volumeAvailableCapacityKey,
        ]) else {
            return false
        }
        let capacity: Int64?
        if let importantCapacity = values.volumeAvailableCapacityForImportantUsage {
            capacity = importantCapacity
        } else if let availableCapacity = values.volumeAvailableCapacity {
            capacity = Int64(availableCapacity)
        } else {
            capacity = nil
        }
        guard let capacity else { return false }
        // Keep space for the verified archive, extracted Core ML bundles, and
        // atomic activation rather than trusting a server-side size alone.
        let required = Int64(request.sizeBytes) * 2 + unpackingReserveBytes
        return Int64(capacity) >= required
    }

    static func hasSufficientBattery() async -> Bool {
        await MainActor.run {
            let device = UIDevice.current
            let previousMonitoringState = device.isBatteryMonitoringEnabled
            device.isBatteryMonitoringEnabled = true
            defer { device.isBatteryMonitoringEnabled = previousMonitoringState }

            switch device.batteryState {
            case .charging, .full:
                return true
            case .unplugged:
                // A transient unknown level is not a reason to deny an
                // explicit user-initiated on-demand install. A known low level
                // is. Background warm-up obeys the same conservative rule.
                return device.batteryLevel < 0 || device.batteryLevel >= 0.20
            case .unknown:
                return true
            @unknown default:
                return false
            }
        }
    }

    static func hasNetworkPath() async -> Bool {
        await withCheckedContinuation { continuation in
            let monitor = NWPathMonitor()
            let queue = DispatchQueue(label: "ai.hushh.one.fluid-audio.network")
            let probe = NetworkPathProbe(continuation)
            monitor.pathUpdateHandler = { path in
                if probe.resolve(path.status == .satisfied) {
                    monitor.cancel()
                }
            }
            monitor.start(queue: queue)
            queue.asyncAfter(deadline: .now() + 3) {
                if probe.resolve(false) {
                    monitor.cancel()
                }
            }
        }
    }
}

/// Stores only verified model bytes and non-sensitive provenance in
/// Application Support. It never stores a signed download URL, transcript,
/// audio, contact, vault, location, or provider credential.
final class OneVoiceFluidAudioPackStore {
    static let shared = OneVoiceFluidAudioPackStore()

    private struct InstalledMetadata: Codable {
        let packID: String
        let version: String
        let checksum: String
        let sizeBytes: Int
        let entrypoint: String
        let licenseNoticeID: String
    }

    private struct ExtractedPackManifest: Decodable {
        let protocolVersion: String
        let packID: String
        let version: String
        let runtime: String
        let entrypoint: String
        let licenseNoticeID: String

        enum CodingKeys: String, CodingKey {
            case protocolVersion = "protocol_version"
            case packID = "pack_id"
            case version
            case runtime
            case entrypoint
            case licenseNoticeID = "license_notice_id"
        }
    }

    private let fileManager: FileManager
    private let rootDirectory: URL

    init(
        fileManager: FileManager = .default,
        rootDirectory: URL? = nil
    ) {
        self.fileManager = fileManager
        self.rootDirectory = rootDirectory ?? fileManager.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        )[0].appendingPathComponent("HushhOneVoice/FluidAudioPacks", isDirectory: true)
    }

    /// Downloads, verifies, extracts, and atomically activates the pack. A
    /// partial archive may be resumed only against a newly issued signed URL.
    func installAndActivate(_ request: OneVoiceFluidAudioPackRequest) async throws -> URL {
        guard OneVoiceFluidAudioPolicy.allows(request) else {
            throw OneVoiceFluidAudioPackStoreError.policyRejected
        }
        try prepareDirectories()

        let destination = packDirectory(for: request)
        if try isValidInstalledPack(at: destination, request: request) {
            try activate(request)
            return destination
        }

        guard OneVoiceFluidAudioPolicy.hasSufficientResources(
            request: request,
            storageDirectory: rootDirectory
        ) else {
            throw OneVoiceFluidAudioPackStoreError.insufficientResources
        }
        guard await OneVoiceFluidAudioPolicy.hasSufficientBattery() else {
            throw OneVoiceFluidAudioPackStoreError.lowBattery
        }
        guard await OneVoiceFluidAudioPolicy.hasNetworkPath() else {
            throw OneVoiceFluidAudioPackStoreError.networkUnavailable
        }

        let archive = try await downloadArchive(for: request)
        defer { try? fileManager.removeItem(at: archive) }
        try verifyArchive(archive, request: request)

        let staging = stagingDirectory(for: request)
        try? fileManager.removeItem(at: staging)
        try fileManager.createDirectory(at: staging, withIntermediateDirectories: true)
        do {
            try fileManager.unzipItem(at: archive, to: staging)
            try verifyExtractedModels(at: staging, expected: metadata(for: request))
            try writeInstalledMetadata(request, to: staging)
            try replaceVerifiedPack(at: destination, with: staging)
            try activate(request)
            return destination
        } catch {
            try? fileManager.removeItem(at: staging)
            throw error
        }
    }

    func activeModelsDirectory() -> URL? {
        guard
            let metadata = readMetadata(at: activePointerURL()),
            let directory = existingPackDirectory(
                packID: metadata.packID,
                version: metadata.version
            ),
            verifyExtractedModelsQuietly(at: directory, expected: metadata)
        else {
            return nil
        }
        return directory
    }

    func rollback() throws -> URL? {
        let previousURL = previousPointerURL()
        guard
            let previous = readMetadata(at: previousURL),
            let directory = existingPackDirectory(
                packID: previous.packID,
                version: previous.version
            ),
            verifyExtractedModelsQuietly(at: directory, expected: previous)
        else {
            return nil
        }
        try writeAtomically(previous, to: activePointerURL())
        return directory
    }

    private func prepareDirectories() throws {
        try fileManager.createDirectory(at: packsRoot, withIntermediateDirectories: true)
        try fileManager.createDirectory(at: stagingRoot, withIntermediateDirectories: true)
        try fileManager.createDirectory(at: pointersRoot, withIntermediateDirectories: true)
    }

    private var packsRoot: URL {
        rootDirectory.appendingPathComponent("packs", isDirectory: true)
    }

    private var stagingRoot: URL {
        rootDirectory.appendingPathComponent("staging", isDirectory: true)
    }

    private var pointersRoot: URL {
        rootDirectory.appendingPathComponent("pointers", isDirectory: true)
    }

    private func packDirectory(for request: OneVoiceFluidAudioPackRequest) -> URL {
        packsRoot
            .appendingPathComponent(request.packID, isDirectory: true)
            .appendingPathComponent(request.version, isDirectory: true)
    }

    private func stagingDirectory(for request: OneVoiceFluidAudioPackRequest) -> URL {
        stagingRoot.appendingPathComponent(
            "\(request.packID)-\(request.version)-\(UUID().uuidString)",
            isDirectory: true
        )
    }

    private func partialArchiveURL(for request: OneVoiceFluidAudioPackRequest) -> URL {
        stagingRoot.appendingPathComponent(
            "\(request.packID)-\(request.version).partial",
            isDirectory: false
        )
    }

    private func activePointerURL() -> URL {
        pointersRoot.appendingPathComponent("active.json", isDirectory: false)
    }

    private func previousPointerURL() -> URL {
        pointersRoot.appendingPathComponent("previous.json", isDirectory: false)
    }

    private func installedMetadataURL(_ directory: URL) -> URL {
        directory.appendingPathComponent("one-voice-pack.json", isDirectory: false)
    }

    private func downloadArchive(for request: OneVoiceFluidAudioPackRequest) async throws -> URL {
        let partial = partialArchiveURL(for: request)
        let existingSize = (try? partial.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        var urlRequest = URLRequest(url: request.artifactURL)
        urlRequest.cachePolicy = .reloadIgnoringLocalCacheData
        if existingSize > 0 {
            urlRequest.setValue("bytes=\(existingSize)-", forHTTPHeaderField: "Range")
        }

        let (temporaryURL, response) = try await URLSession.shared.download(for: urlRequest)
        defer { try? fileManager.removeItem(at: temporaryURL) }
        guard let httpResponse = response as? HTTPURLResponse else {
            throw OneVoiceFluidAudioPackStoreError.invalidResponse
        }

        let expectedRangePrefix = "bytes \(existingSize)-"
        let contentRange = httpResponse.value(forHTTPHeaderField: "Content-Range") ?? ""
        if existingSize > 0, httpResponse.statusCode == 206 {
            guard contentRange.lowercased().hasPrefix(expectedRangePrefix) else {
                try? fileManager.removeItem(at: partial)
                throw OneVoiceFluidAudioPackStoreError.invalidResponse
            }
            try append(temporaryURL, to: partial)
        } else if httpResponse.statusCode == 200 {
            // A server that does not honor Range restarts safely from a fresh
            // complete response instead of appending ambiguous bytes.
            try replaceFile(at: partial, with: temporaryURL)
        } else {
            throw OneVoiceFluidAudioPackStoreError.downloadFailed
        }

        return partial
    }

    private func append(_ source: URL, to destination: URL) throws {
        if !fileManager.fileExists(atPath: destination.path) {
            try replaceFile(at: destination, with: source)
            return
        }
        let output = try FileHandle(forWritingTo: destination)
        defer { try? output.close() }
        try output.seekToEnd()
        let input = try FileHandle(forReadingFrom: source)
        defer { try? input.close() }
        while true {
            let chunk = try input.read(upToCount: 1_048_576) ?? Data()
            if chunk.isEmpty { break }
            try output.write(contentsOf: chunk)
        }
        try? fileManager.removeItem(at: source)
    }

    private func replaceFile(at destination: URL, with source: URL) throws {
        try? fileManager.removeItem(at: destination)
        try fileManager.moveItem(at: source, to: destination)
    }

    private func verifyArchive(_ archive: URL, request: OneVoiceFluidAudioPackRequest) throws {
        let size = try archive.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size == request.sizeBytes else {
            throw OneVoiceFluidAudioPackStoreError.sizeMismatch
        }
        guard try sha256(of: archive) == request.checksum else {
            try? fileManager.removeItem(at: archive)
            throw OneVoiceFluidAudioPackStoreError.checksumMismatch
        }
    }

    private func sha256(of url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var digest = SHA256()
        while true {
            let chunk = try handle.read(upToCount: 1_048_576) ?? Data()
            if chunk.isEmpty { break }
            digest.update(data: chunk)
        }
        return digest.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private func verifyExtractedModels(
        at directory: URL,
        expected: InstalledMetadata
    ) throws {
        for name in [
            "streaming_encoder.mlmodelc",
            "decoder.mlmodelc",
            "joint_decision.mlmodelc",
            "vocab.json",
        ] {
            guard fileManager.fileExists(atPath: directory.appendingPathComponent(name).path) else {
                throw OneVoiceFluidAudioPackStoreError.missingModelFile
            }
        }
        let manifestURL = directory.appendingPathComponent(
            "one-voice-fluid-audio-manifest.json",
            isDirectory: false
        )
        guard
            let data = try? Data(contentsOf: manifestURL),
            let manifest = try? JSONDecoder().decode(ExtractedPackManifest.self, from: data),
            manifest.protocolVersion == "one.voice.fluid-audio-pack.v1",
            manifest.packID == expected.packID,
            manifest.version == expected.version,
            manifest.runtime == "fluid_audio",
            manifest.entrypoint == expected.entrypoint,
            manifest.licenseNoticeID == expected.licenseNoticeID
        else {
            throw OneVoiceFluidAudioPackStoreError.invalidPackManifest
        }
    }

    private func verifyExtractedModelsQuietly(
        at directory: URL,
        expected: InstalledMetadata
    ) -> Bool {
        (try? verifyExtractedModels(at: directory, expected: expected)) != nil
    }

    private func writeInstalledMetadata(
        _ request: OneVoiceFluidAudioPackRequest,
        to directory: URL
    ) throws {
        try writeAtomically(metadata(for: request), to: installedMetadataURL(directory))
    }

    private func replaceVerifiedPack(at destination: URL, with staging: URL) throws {
        let parent = destination.deletingLastPathComponent()
        try fileManager.createDirectory(at: parent, withIntermediateDirectories: true)
        if fileManager.fileExists(atPath: destination.path) {
            try fileManager.removeItem(at: destination)
        }
        try fileManager.moveItem(at: staging, to: destination)
    }

    private func activate(_ request: OneVoiceFluidAudioPackRequest) throws {
        let metadata = metadata(for: request)
        if let active = readMetadata(at: activePointerURL()),
           active.packID != metadata.packID || active.version != metadata.version
        {
            try writeAtomically(active, to: previousPointerURL())
        }
        try writeAtomically(metadata, to: activePointerURL())
    }

    private func readMetadata(at url: URL) -> InstalledMetadata? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(InstalledMetadata.self, from: data)
    }

    private func existingPackDirectory(packID: String, version: String) -> URL? {
        guard
            OneVoiceFluidAudioPackRequest.isSafeIdentifier(packID),
            OneVoiceFluidAudioPackRequest.isSafeIdentifier(version)
        else {
            return nil
        }
        let directory = packsRoot
            .appendingPathComponent(packID, isDirectory: true)
            .appendingPathComponent(version, isDirectory: true)
        return fileManager.fileExists(atPath: directory.path) ? directory : nil
    }

    private func isValidInstalledPack(
        at directory: URL,
        request: OneVoiceFluidAudioPackRequest
    ) throws -> Bool {
        guard
            let metadata = readMetadata(at: installedMetadataURL(directory)),
            metadata.packID == request.packID,
            metadata.version == request.version,
            metadata.checksum == request.checksum,
            metadata.sizeBytes == request.sizeBytes,
            metadata.entrypoint == request.entrypoint,
            metadata.licenseNoticeID == request.licenseNoticeID
        else {
            return false
        }
        try verifyExtractedModels(at: directory, expected: metadata)
        return true
    }

    private func metadata(for request: OneVoiceFluidAudioPackRequest) -> InstalledMetadata {
        InstalledMetadata(
            packID: request.packID,
            version: request.version,
            checksum: request.checksum,
            sizeBytes: request.sizeBytes,
            entrypoint: request.entrypoint,
            licenseNoticeID: request.licenseNoticeID
        )
    }

    private func writeAtomically<T: Encodable>(_ value: T, to destination: URL) throws {
        let data = try JSONEncoder().encode(value)
        let temporary = destination.appendingPathExtension(UUID().uuidString)
        try data.write(to: temporary, options: .atomic)
        if fileManager.fileExists(atPath: destination.path) {
            _ = try fileManager.replaceItemAt(destination, withItemAt: temporary)
        } else {
            try fileManager.moveItem(at: temporary, to: destination)
        }
    }
}

enum OneVoiceFluidAudioPackStoreError: Error {
    case policyRejected
    case invalidResponse
    case downloadFailed
    case sizeMismatch
    case checksumMismatch
    case missingModelFile
    case invalidPackManifest
    case insufficientResources
    case lowBattery
    case networkUnavailable
}
