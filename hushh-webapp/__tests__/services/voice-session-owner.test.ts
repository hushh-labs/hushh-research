import { afterEach, expect, it } from "vitest";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import {
  currentVoiceContinuationHandle,
  isVoiceSessionOwnerCurrent,
  snapshotVoiceSessionOwner,
} from "@/lib/voice/voice-session-owner";

afterEach(() => publishValidatedAuthSessionOwner(null));

it("rejects a queued retry and provider continuation after account replacement", () => {
  publishValidatedAuthSessionOwner("owner-a");
  const retryOwner = snapshotVoiceSessionOwner("owner-a");
  const continuation = { owner: retryOwner, handle: "synthetic-session-a" };
  expect(currentVoiceContinuationHandle(continuation)).toBe(
    "synthetic-session-a",
  );
  publishValidatedAuthSessionOwner("owner-b");
  expect(isVoiceSessionOwnerCurrent(retryOwner)).toBe(false);
  expect(currentVoiceContinuationHandle(continuation)).toBeNull();
  publishValidatedAuthSessionOwner("owner-a");
  expect(isVoiceSessionOwnerCurrent(retryOwner)).toBe(false);
  expect(currentVoiceContinuationHandle(continuation)).toBeNull();
});

it("refuses signed identity while verification is unresolved", () => {
  publishValidatedAuthSessionOwner(null);
  expect(isVoiceSessionOwnerCurrent(snapshotVoiceSessionOwner("owner-a"))).toBe(
    false,
  );
});

it("retains anonymous continuation only while still anonymous", () => {
  publishValidatedAuthSessionOwner(null);
  const owner = snapshotVoiceSessionOwner(null);
  expect(isVoiceSessionOwnerCurrent(owner)).toBe(true);
  publishValidatedAuthSessionOwner("owner-b");
  expect(isVoiceSessionOwnerCurrent(owner)).toBe(false);
  expect(
    currentVoiceContinuationHandle({ owner, handle: "synthetic-guest" }),
  ).toBeNull();
});

it("rejects anonymous retries and continuations after a signed-in round trip", () => {
  publishValidatedAuthSessionOwner(null);
  const owner = snapshotVoiceSessionOwner(null);
  publishValidatedAuthSessionOwner("owner-a");
  publishValidatedAuthSessionOwner(null);
  expect(isVoiceSessionOwnerCurrent(owner)).toBe(false);
  expect(currentVoiceContinuationHandle({ owner, handle: "synthetic-guest" })).toBeNull();
});
