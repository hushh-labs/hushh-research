import XCTest
@testable import App

final class CallingContractTests: XCTestCase {
    func testCanonicalAccountAdmissionRejectsMalformedOrRetiredIdentityBindings() throws {
        let owner = "acct_" + String(repeating: "a", count: 32)
        let admitted: [String: Any] = ["active": true, "firebase_uid": "firebase-alice",
                                      "owner_id": owner, "account_generation": 1]
        XCTAssertEqual(try CallingWire.accountPrincipal(admitted, firebaseUid: "firebase-alice"),
                       CallingAccountPrincipal(firebaseUid: "firebase-alice", ownerId: owner, accountGeneration: 1))
        XCTAssertThrowsError(try CallingWire.accountPrincipal(admitted, firebaseUid: "firebase-bob"))
        let invalid: [(String, Any)] = [("active", 1), ("active", false), ("active", "true"),
            ("owner_id", " " + owner), ("owner_id", "firebase-alice"),
            ("account_generation", true), ("account_generation", -1),
            ("account_generation", 1.5), ("account_generation", 9_007_199_254_740_992.0)]
        for (key, value) in invalid {
            var payload = admitted; payload[key] = value
            XCTAssertThrowsError(try CallingWire.accountPrincipal(payload, firebaseUid: "firebase-alice"), key)
        }
        let legacy: [String: Any] = ["active": true, "firebase_uid": "firebase-alice",
                                    "owner_id": "firebase-alice", "account_generation": 0]
        XCTAssertEqual(try CallingWire.accountPrincipal(legacy, firebaseUid: "firebase-alice").ownerId, "firebase-alice")
    }
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
