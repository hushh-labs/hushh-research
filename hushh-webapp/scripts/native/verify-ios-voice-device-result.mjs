#!/usr/bin/env node

/**
 * Reject a false-green physical-device result. The benchmark itself writes
 * only this aggregate evidence; this verifier intentionally never accepts
 * logs, screenshots, audio, transcripts, or device identifiers as proof.
 */

import fs from "node:fs";

const resultPath = process.argv[2] || "";
const expectedSha = (process.env.IOS_EXPECTED_SOURCE_SHA || "").trim().toLowerCase();
const threshold = Number(process.env.IOS_VOICE_CAPTURE_P95_MS || "300");

function fail(message) {
  console.error("ios-voice-device-result: " + message);
  process.exitCode = 1;
}

if (!resultPath || !fs.existsSync(resultPath)) {
  fail("required aggregate benchmark result is missing.");
} else {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(resultPath, "utf8"));
  } catch {
    fail("benchmark result is not valid JSON.");
  }

  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const allowedKeys = new Set([
      "schema_version",
      "source_sha",
      "device_tier",
      "ios_major_version",
      "repetitions",
      "p95_time_to_capture_ms",
      "first_frame_count",
      "lost_initial_frame_count",
    ]);
    for (const key of Object.keys(payload)) {
      if (!allowedKeys.has(key)) fail("result contains a disallowed field: " + key);
    }
    if (payload.schema_version !== "one-voice-hardware-capture-v1") {
      fail("benchmark result has an unsupported schema.");
    }
    if (
      typeof payload.source_sha !== "string" ||
      !/^[0-9a-f]{7,64}$/i.test(payload.source_sha) ||
      (expectedSha && payload.source_sha.toLowerCase() !== expectedSha)
    ) {
      fail("benchmark result does not prove the expected source SHA.");
    }
    if (
      typeof payload.device_tier !== "string" ||
      !/^[A-Za-z0-9_-]{1,32}$/.test(payload.device_tier)
    ) {
      fail("benchmark result has no approved redacted device tier.");
    }
    if (!Number.isInteger(payload.ios_major_version) || payload.ios_major_version < 17) {
      fail("benchmark device must run iOS 17 or later.");
    }
    if (!Number.isInteger(payload.repetitions) || payload.repetitions < 30) {
      fail("benchmark needs at least 30 repetitions.");
    }
    if (payload.first_frame_count !== payload.repetitions) {
      fail("benchmark lost a first-frame observation.");
    }
    if (payload.lost_initial_frame_count !== 0) {
      fail("benchmark recorded lost initial frames.");
    }
    if (
      typeof payload.p95_time_to_capture_ms !== "number" ||
      !Number.isFinite(payload.p95_time_to_capture_ms) ||
      payload.p95_time_to_capture_ms >= threshold
    ) {
      fail("benchmark p95 must be below " + threshold + " ms.");
    }

    const serialized = JSON.stringify(payload).toLowerCase();
    for (const forbidden of ["audio", "transcript", "contact", "vault", "coordinate"]) {
      if (serialized.includes(forbidden)) {
        fail("benchmark result contains forbidden protected-data marker: " + forbidden);
      }
    }
  } else {
    fail("benchmark result must be an object.");
  }
}

if (!process.exitCode) {
  console.log("iOS physical-device aggregate timing evidence passed.");
}
