import AVFoundation
import Foundation
import XCTest
@testable import App

/// Real-device-only capture gate for the One Voice latency SLO.
///
/// The test records no audio and emits only a redacted aggregate timing JSON
/// marker. The device workflow extracts that marker on the macOS runner and
/// validates it independently, so an omitted test, missing permission,
/// simulator run, or skipped measurement cannot turn the physical-device gate
/// green. A test executing on an iPhone must not try to write into a macOS
/// runner path.
final class OneVoiceHardwareBenchmarkTests: XCTestCase {
    private let enabledEnvironmentKey = "HUSHH_ENABLE_IOS_VOICE_DEVICE_BENCHMARK"

    func testHardwareCaptureP95Under300Milliseconds() throws {
        // General simulator/unit runs include this target. They do not produce
        // hardware evidence; the CI harness requires the output file when it
        // enables this test, preventing a silent pass from being accepted.
        guard ProcessInfo.processInfo.environment[enabledEnvironmentKey] == "true" else {
            return
        }
#if targetEnvironment(simulator)
        if ProcessInfo.processInfo.environment[enabledEnvironmentKey] == "true" {
            XCTFail("The One Voice hardware capture gate must run on a physical iPhone.")
            return
        }
#endif

        let environment = ProcessInfo.processInfo.environment
        let repetitions = Int(environment["IOS_VOICE_BENCHMARK_REPETITIONS"] ?? "") ?? 0
        let threshold = Double(environment["IOS_VOICE_CAPTURE_P95_MS"] ?? "") ?? 0
        let sourceSHA = environment["IOS_EXPECTED_SOURCE_SHA"] ?? ""
        let deviceTier = environment["IOS_VOICE_DEVICE_TIER"] ?? ""

        XCTAssertGreaterThanOrEqual(repetitions, 30, "Hardware evidence requires at least 30 runs.")
        XCTAssertGreaterThan(threshold, 0, "Hardware capture threshold must be a positive number.")
        XCTAssertTrue(isSafeSourceSHA(sourceSHA), "Hardware evidence requires the exact source SHA.")
        XCTAssertTrue(isSafeDeviceTier(deviceTier), "Hardware evidence requires a configured device tier.")
        guard repetitions >= 30,
              threshold > 0,
              isSafeSourceSHA(sourceSHA),
              isSafeDeviceTier(deviceTier)
        else {
            return
        }

        guard AVAudioSession.sharedInstance().recordPermission == .granted else {
            XCTFail("Microphone permission was not granted by the automated bootstrap.")
            return
        }

        var measurements: [CaptureMeasurement] = []
        measurements.reserveCapacity(repetitions)
        for _ in 0..<repetitions {
            measurements.append(try measureFirstInputBuffer())
        }

        XCTAssertEqual(measurements.count, repetitions, "Every run must observe a first input frame.")
        let sorted = measurements.map(\.elapsedMilliseconds).sorted()
        let p95Index = min(sorted.count - 1, Int(ceil(Double(sorted.count) * 0.95)) - 1)
        let p95 = sorted[p95Index]
        let lostInitialFrames = measurements.reduce(into: 0) { total, measurement in
            total += max(0, measurement.firstFrameSequence - 1)
        }
        let evidence = try makeAggregateEvidence(
            sourceSHA: sourceSHA,
            deviceTier: deviceTier,
            repetitions: repetitions,
            p95: p95,
            lostInitialFrames: lostInitialFrames
        )
        XCTAssertEqual(lostInitialFrames, 0, "The production microphone path lost initial frames.")
        XCTAssertLessThan(p95, threshold, "One Voice hardware capture p95 exceeded the configured SLO.")
        print("ONE_VOICE_HARDWARE_CAPTURE_JSON=\(evidence)")
    }

    private func measureFirstInputBuffer() throws -> CaptureMeasurement {
        let microphoneCapture = OneVoiceMicrophoneCapture()
        let expectation = XCTestExpectation(description: "first audio input buffer")
        let lock = NSLock()
        let startedAt = CFAbsoluteTimeGetCurrent()
        var measurement: CaptureMeasurement?

        try microphoneCapture.start(bufferSize: 1_024) { _, _, sequence in
            lock.lock()
            let isFirstFrame = measurement == nil
            if isFirstFrame {
                measurement = CaptureMeasurement(
                    elapsedMilliseconds: (CFAbsoluteTimeGetCurrent() - startedAt) * 1_000,
                    firstFrameSequence: sequence
                )
            }
            lock.unlock()
            if isFirstFrame {
                expectation.fulfill()
            }
        }
        defer {
            microphoneCapture.stop()
        }

        let waitResult = XCTWaiter().wait(for: [expectation], timeout: 2)
        guard waitResult == .completed else {
            throw NSError(domain: "OneVoiceHardwareBenchmark", code: 1)
        }
        lock.lock()
        defer { lock.unlock() }
        guard let measurement else {
            throw NSError(domain: "OneVoiceHardwareBenchmark", code: 2)
        }
        return measurement
    }

    private func makeAggregateEvidence(
        sourceSHA: String,
        deviceTier: String,
        repetitions: Int,
        p95: Double,
        lostInitialFrames: Int
    ) throws -> String {
        let payload: [String: Any] = [
            "schema_version": "one-voice-hardware-capture-v1",
            "source_sha": sourceSHA.lowercased(),
            "device_tier": deviceTier,
            "ios_major_version": Int(UIDevice.current.systemVersion.split(separator: ".").first ?? "0") ?? 0,
            "repetitions": repetitions,
            "p95_time_to_capture_ms": Double(String(format: "%.2f", p95)) ?? p95,
            "first_frame_count": repetitions,
            "lost_initial_frame_count": lostInitialFrames,
        ]
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        guard let encoded = String(data: data, encoding: .utf8) else {
            throw NSError(domain: "OneVoiceHardwareBenchmark", code: 3)
        }
        return encoded
    }

    private func isSafeSourceSHA(_ value: String) -> Bool {
        let allowed = CharacterSet(charactersIn: "0123456789abcdefABCDEF")
        return (7...64).contains(value.count)
            && value.unicodeScalars.allSatisfy { allowed.contains($0) }
    }

    private func isSafeDeviceTier(_ value: String) -> Bool {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "_-"))
        return (1...32).contains(value.count)
            && value.unicodeScalars.allSatisfy { allowed.contains($0) }
    }

    private struct CaptureMeasurement {
        let elapsedMilliseconds: Double
        let firstFrameSequence: Int
    }
}
