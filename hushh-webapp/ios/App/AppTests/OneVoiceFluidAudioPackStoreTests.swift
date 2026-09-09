import Foundation
import XCTest
@testable import App

final class OneVoiceFluidAudioPackStoreTests: XCTestCase {
    func testPackRequestRejectsUnsafeOrUnsignedMetadata() {
        XCTAssertNil(
            makeRequest(
                packID: "../outside",
                artifactURL: validArtifactURL
            )
        )
        XCTAssertNil(
            makeRequest(
                packID: OneVoiceFluidAudioPolicy.requiredPackID,
                artifactURL: "http://storage.googleapis.com/hushh-pda-uat-one-voice-model-packs/pack.zip?X-Goog-Signature=short-lived&X-Goog-Expires=900"
            )
        )
        XCTAssertNil(
            makeRequest(
                packID: OneVoiceFluidAudioPolicy.requiredPackID,
                artifactURL: "https://storage.googleapis.com/hushh-pda-uat-one-voice-model-packs/pack.zip"
            )
        )
        XCTAssertNil(
            makeRequest(
                packID: OneVoiceFluidAudioPolicy.requiredPackID,
                artifactURL: validArtifactURL,
                entrypoint: "other_provider"
            )
        )
    }

    func testShippingConfigurationFailsClosedBeforeAnyModelDownload() async throws {
        let request = try XCTUnwrap(
            makeRequest(
                packID: OneVoiceFluidAudioPolicy.requiredPackID,
                artifactURL: validArtifactURL
            )
        )
        XCTAssertFalse(OneVoiceFluidAudioPolicy.runtimeIsEnabled())
        XCTAssertFalse(OneVoiceFluidAudioPolicy.allows(request))

        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("OneVoiceFluidAudioPackStoreTests-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let store = OneVoiceFluidAudioPackStore(rootDirectory: root)

        do {
            _ = try await store.installAndActivate(request)
            XCTFail("A disabled or unapproved FluidAudio model must not download.")
        } catch OneVoiceFluidAudioPackStoreError.policyRejected {
            // Expected: no request URL or model bytes can be persisted before
            // legal notice, feature switches, and benchmark eligibility agree.
        } catch {
            XCTFail("Expected policy rejection, received \(error).")
        }

        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path))
    }

    private func makeRequest(
        packID: String,
        artifactURL: String,
        entrypoint: String = OneVoiceFluidAudioPolicy.requiredEntrypoint
    ) -> OneVoiceFluidAudioPackRequest? {
        OneVoiceFluidAudioPackRequest(
            packID: packID,
            version: "v1",
            sizeBytes: 1,
            checksum: String(repeating: "a", count: 64),
            artifactURL: artifactURL,
            entrypoint: entrypoint,
            licenseNoticeID: OneVoiceFluidAudioPolicy.requiredNoticeID,
            licenseApproved: true
        )
    }

    private var validArtifactURL: String {
        "https://storage.googleapis.com/hushh-pda-uat-one-voice-model-packs/one-voice/model-pack.zip?X-Goog-Signature=short-lived&X-Goog-Expires=900"
    }
}
