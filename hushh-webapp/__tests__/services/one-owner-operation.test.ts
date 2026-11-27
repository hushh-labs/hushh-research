// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ epoch: 1, track: vi.fn() }));
vi.mock("@/lib/observability/client", () => ({ trackEvent: state.track }));
vi.mock("@/lib/vault/session-epoch", () => ({
  snapshotVaultSessionEpoch: () => state.epoch,
  isVaultSessionEpochCurrent: (epoch: number) => epoch === state.epoch,
}));
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { observeCareerOperation, observeDocumentRequestOperation } from "@/lib/observability/one-owner-operation";

beforeEach(() => { vi.clearAllMocks(); state.epoch = 1; publishValidatedAuthSessionOwner("owner-a"); });

it("reports one terminal result without owner or document data", () => {
  const observe = observeDocumentRequestOperation("file_request_send", "owner-a");
  observe("error");
  observe("success");
  expect(state.track).toHaveBeenCalledExactlyOnceWith("one_document_request_action", { action: "file_request_send", result: "error" });
});

it("does not admit an absent, different or retired owner", () => {
  publishValidatedAuthSessionOwner(null);
  const absent = observeCareerOperation("owner-a", "resume_save");
  publishValidatedAuthSessionOwner("owner-a");
  absent("success");
  observeCareerOperation("owner-b", "resume_save")("success");
  const retired = observeCareerOperation("owner-a", "application_send");
  publishValidatedAuthSessionOwner(null);
  publishValidatedAuthSessionOwner("owner-a");
  retired("success");
  expect(state.track).not.toHaveBeenCalled();
});

it("drops the result after a vault epoch change", () => {
  const observe = observeDocumentRequestOperation("review_request");
  state.epoch++;
  observe("error");
  expect(state.track).not.toHaveBeenCalled();
});
