import XCTest
@testable import App

final class CallingContractTests: XCTestCase {
    func testColdRecoveryEndsOnlyTheInstallationThatLostItsTransport() {
        let caller: [String: Any] = ["state": "active", "isCaller": true, "callerDeviceId": "local", "calleeDeviceId": "peer"]
        XCTAssertTrue(CallingRecovery.ownsOrphan(caller, device: "local"))
        XCTAssertFalse(CallingRecovery.ownsOrphan(caller, device: "peer"))
        XCTAssertTrue(CallingRecovery.ownsOrphan(["state": "connecting", "isCaller": false, "calleeDeviceId": "local"], device: "local"))
        XCTAssertFalse(CallingRecovery.ownsOrphan(["state": "ringing", "isCaller": false, "calleeDeviceId": NSNull()], device: "local"))
        XCTAssertFalse(CallingRecovery.ownsOrphan(["state": "ended", "isCaller": true, "callerDeviceId": "local"], device: "local"))
    }
    func testNewCallDropsPriorMuteAndRequiresFreshActivationAndVerification() {
        var gate = CallingAudioGate(activated: true, verified: true, muted: true)
        XCTAssertTrue(gate.enabled)
        XCTAssertFalse(gate.microphoneEnabled)
        gate = CallingAudioGate()
        XCTAssertFalse(gate.enabled)
        gate.verified = true
        XCTAssertFalse(gate.enabled)
        gate.activated = true
        XCTAssertTrue(gate.microphoneEnabled)
        gate.activated = false
        XCTAssertFalse(gate.microphoneEnabled)
    }
    func testAudioOwnersCannotDeactivateAnotherCapture() {
        let voice = NSObject(), call = NSObject()
        XCTAssertTrue(NativeAudioOwnership.claim(voice))
        XCTAssertFalse(NativeAudioOwnership.claim(call))
        NativeAudioOwnership.release(call)
        XCTAssertFalse(NativeAudioOwnership.claim(call))
        NativeAudioOwnership.release(voice)
        XCTAssertTrue(NativeAudioOwnership.claim(call))
        NativeAudioOwnership.release(call)
    }
    func testRejectsHostCandidatesAndWrongDescriptionKinds() throws {
        let fingerprint = Array(repeating: "AB", count: 32).joined(separator: ":")
        let base = "v=0\r\na=fingerprint:sha-256 \(fingerprint)\r\n"
        XCTAssertThrowsError(try CallingWire.validateDescription(["type": "offer", "sdp": base + "a=candidate:1 1 udp 1 192.0.2.1 5 typ host\r\n"], kind: "offer"))
        XCTAssertThrowsError(try CallingWire.validateDescription(["type": "answer", "sdp": base], kind: "offer"))
        XCTAssertThrowsError(try CallingWire.validateDescription(["type": "offer", "sdp": "v=0"], kind: "offer"))
    }
    func testSecurityCodeChangesForEitherEndpointKey() throws {
        let local = ["userId": "alice", "deviceId": "a", "keyId": "1", "publicKey": "local", "signingKey": "signing-a"]
        var peer = ["userId": "bob", "deviceId": "b", "keyId": "2", "publicKey": "peer", "signingKey": "signing-b"]
        let original = try CallingWire.pairFingerprint(local, peer)
        XCTAssertEqual(original, try CallingWire.pairFingerprint(peer, local))
        peer["publicKey"] = "replacement"
        XCTAssertNotEqual(original, try CallingWire.pairFingerprint(local, peer))
        peer["publicKey"] = "peer"; peer["signingKey"] = "replacement"
        XCTAssertNotEqual(original, try CallingWire.pairFingerprint(local, peer))
    }
}
