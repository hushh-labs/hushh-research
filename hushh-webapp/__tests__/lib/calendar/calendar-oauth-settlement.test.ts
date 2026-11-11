import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ status: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/services/google-calendar-service", () => ({ GoogleCalendarService: { status: mocks.status } }));
vi.mock("@/lib/morphy-ux/morphy", () => ({ morphyToast: { success: mocks.success, error: mocks.error } }));
vi.mock("@/lib/observability/client", () => ({ trackEvent: vi.fn() }));

import { pollCalendarMeetingGrant } from "@/lib/calendar/calendar-oauth-settlement";

const SCOPES = "https://www.googleapis.com/auth/meetings.space.readonly https://www.googleapis.com/auth/drive.meet.readonly https://www.googleapis.com/auth/drive.metadata.readonly";
const status = (generation: string, scope = SCOPES) => ({
  configured: true, connected: true, status: "connected", scope_csv: "",
  accounts: [{ account_id: "default", connected: true, status: "connected", access_level: "read",
    provider_subject_sha256: "a".repeat(64), grant_generation: generation, scope_csv: scope }],
});
const input = (overrides: Partial<Parameters<typeof pollCalendarMeetingGrant>[0]> = {}) => ({
  ownerId: "owner", targetAccountId: "default", expectedSubjectSha256: "a".repeat(64), priorGrantGeneration: "old",
  getUser: () => ({ getIdToken: async () => "token" }), isCurrent: () => true, onVerified: vi.fn(), onSettled: vi.fn(),
  ...overrides,
});

describe("pollCalendarMeetingGrant", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.resetAllMocks(); });
  afterEach(() => { vi.useRealTimers(); });

  it("applies the verified grant before it reports the attempt settled", async () => {
    mocks.status.mockResolvedValue(status("new"));
    const order: string[] = [];
    const args = input({ onVerified: () => order.push("verified"), onSettled: () => order.push("settled") });
    await pollCalendarMeetingGrant(args);
    expect(order).toEqual(["verified", "settled"]);
    expect(mocks.success).toHaveBeenCalledOnce();
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("keeps polling while the grant is not new, then settles with the honest failure", async () => {
    mocks.status.mockResolvedValue(status("old"));
    const args = input();
    const run = pollCalendarMeetingGrant(args);
    await vi.advanceTimersByTimeAsync(1_500 * 5);
    await run;
    expect(mocks.status).toHaveBeenCalledTimes(5);
    expect(args.onVerified).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith("Recording and notes access could not be verified. Refresh before trying again.");
    expect(args.onSettled).toHaveBeenCalledOnce();
  });

  it("verifies a grant that appears on a later read", async () => {
    mocks.status.mockResolvedValueOnce(status("old")).mockResolvedValueOnce(status("old")).mockResolvedValue(status("new"));
    const args = input();
    const run = pollCalendarMeetingGrant(args);
    await vi.advanceTimersByTimeAsync(3_000);
    await run;
    expect(args.onVerified).toHaveBeenCalledOnce();
    expect(args.onSettled).toHaveBeenCalledOnce();
  });

  it("does not settle for a context that is no longer current", async () => {
    let current = true;
    mocks.status.mockImplementation(async () => { current = false; return status("new"); });
    const args = input({ isCurrent: () => current });
    await pollCalendarMeetingGrant(args);
    expect(args.onVerified).not.toHaveBeenCalled();
    expect(args.onSettled).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("does not verify a grant for another selected account or missing scopes", async () => {
    mocks.status.mockResolvedValue(status("new", "https://www.googleapis.com/auth/drive.meet.readonly"));
    const args = input();
    const run = pollCalendarMeetingGrant(args);
    await vi.advanceTimersByTimeAsync(1_500 * 5);
    await run;
    expect(args.onVerified).not.toHaveBeenCalled();
    expect(args.onSettled).toHaveBeenCalledOnce();
  });
});
