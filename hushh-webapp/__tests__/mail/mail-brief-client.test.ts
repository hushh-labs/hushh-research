/**
 * The brief's two reads. A 200 that does not describe the brief is a failure,
 * never an empty brief, and the browser only ever asks with the mailbox it is
 * showing: no user, no message id, no query.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchMailBrief,
  fetchMailCompleted,
  parseMailBrief,
  parseMailCompleted,
} from "@/lib/mail/mail-brief-client";
import { MailOverviewError, mailOverviewReason } from "@/lib/mail/mail-overview-client";
import { ApiService } from "@/lib/services/api-service";

vi.mock("@/lib/services/api-service", () => ({
  ApiService: { apiFetch: vi.fn(), getAuthHeaders: vi.fn((token?: string) => ({ Authorization: `Bearer ${token}` })) },
}));

const id = (name: string) => `ms1.${name.padEnd(24, "x")}`;

const evidence = (over: Record<string, unknown> = {}) => ({
  source_id: id("promise"),
  from: "Maya Rao",
  on: "2026-11-19",
  direction: "received",
  quote: "I will send the final brand assets by 21 Nov",
  ...over,
});

const attention = (over: Record<string, unknown> = {}) => ({
  id: "att_1",
  kind: "follow_up",
  title: "Get the final brand assets",
  reason: "Maya said she would send them by 21 Nov.",
  context: null,
  person: "Maya Rao",
  due: { date: "2026-11-21", role: "promised", label: "Promised 21 November" },
  term: null,
  action: { kind: "draft_followup", source_id: id("promise"), draft: null },
  evidence: [evidence()],
  ...over,
});

const update = (over: Record<string, unknown> = {}) => ({
  id: "upd_1",
  kind: "approval",
  title: "Proposal approved",
  line: "Scope and Rs 2.4 lakh budget confirmed.",
  person: "Priya Nair",
  on: "2026-11-22",
  action: { kind: "thank", source_id: id("yes"), draft: "Thank you, Priya." },
  evidence: [evidence({ direction: "sent", from: "You" }), evidence({ source_id: id("yes") })],
  ...over,
});

const brief = (over: Record<string, unknown> = {}) => ({
  account: "google-sub-1",
  generated_at: "2026-11-26T09:00:00+00:00",
  coverage: { messages: 12, window_days: 21, may_be_partial: false },
  attention: [attention()],
  updates: [update()],
  ...over,
});

function respond(body: unknown, status = 200) {
  vi.mocked(ApiService.apiFetch).mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
}

beforeEach(() => vi.mocked(ApiService.apiFetch).mockReset());

describe("what the browser asks", () => {
  it("sends only the mailbox it is showing, with the vault owner token, and waits for a model", async () => {
    respond(brief());

    await fetchMailBrief({ vaultOwnerToken: "HCT:token", expectedAccount: "google-sub-1" });

    const [path, init] = vi.mocked(ApiService.apiFetch).mock.calls[0] ?? [];
    expect(path).toBe("/api/one/mail/overview/brief");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ expected_account: "google-sub-1" });
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe("Bearer HCT:token");
    // The brief waits on a model: longer than a plain read, still bounded.
    expect((init as { timeoutMs: number }).timeoutMs).toBe(60_000);
  });

  it("asks for confirmed sends with the same minimal body and the ordinary timeout", async () => {
    respond({ account: "google-sub-1", items: [] });

    await fetchMailCompleted({ vaultOwnerToken: "HCT:token", expectedAccount: null });

    const [path, init] = vi.mocked(ApiService.apiFetch).mock.calls[0] ?? [];
    expect(path).toBe("/api/one/mail/overview/completed");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({});
    expect((init as { timeoutMs: number }).timeoutMs).toBe(30_000);
  });

  it("refuses to ask without a vault owner token", async () => {
    await expect(fetchMailBrief({ vaultOwnerToken: "  " })).rejects.toMatchObject({ reason: "auth_missing" });
    expect(ApiService.apiFetch).not.toHaveBeenCalled();
  });
});

describe("what comes back", () => {
  it("reads a valid brief into plain, typed items", () => {
    const parsed = parseMailBrief(brief());
    expect(parsed.account).toBe("google-sub-1");
    expect(parsed.coverage).toEqual({ messages: 12, windowDays: 21, mayBePartial: false });
    expect(parsed.attention[0]).toMatchObject({
      kind: "follow_up",
      person: "Maya Rao",
      due: { date: "2026-11-21", label: "Promised 21 November" },
      action: { kind: "draft_followup", sourceId: id("promise"), draft: null },
    });
    expect(parsed.updates[0]?.action).toEqual({ kind: "thank", sourceId: id("yes"), draft: "Thank you, Priya." });
  });

  it("treats an answer that does not describe the brief as a failure, never as an empty brief", () => {
    const bad: unknown[] = [
      null,
      {},
      brief({ account: "" }),
      brief({ generated_at: "not a time" }),
      brief({ coverage: null }),
      brief({ attention: "none" }),
      brief({ attention: [attention({ kind: "urgent" })] }),
      brief({ attention: [attention({ action: { kind: "draft_reply", source_id: "18c2f0a9b3", draft: null } })] }),
      brief({ attention: [attention({ evidence: [] })] }),
      brief({ attention: [attention({ evidence: [evidence({ on: "yesterday" })] })] }),
      brief({ attention: [attention({ evidence: [evidence({ direction: "forwarded" })] })] }),
      brief({ attention: [attention({ due: { date: "21 Nov", role: "promised", label: "x" } })] }),
      brief({ updates: [update({ action: { kind: "send", source_id: id("x"), draft: null } })] }),
      brief({ updates: [update({ kind: "rumour" })] }),
    ];
    for (const body of bad) {
      expect(() => parseMailBrief(body)).toThrow(MailOverviewError);
    }
  });

  it("shows one item once, however many times the server repeats it", () => {
    const parsed = parseMailBrief(brief({ attention: [attention(), attention()], updates: [update(), update()] }));
    expect(parsed.attention).toHaveLength(1);
    expect(parsed.updates).toHaveLength(1);
  });

  it("reads confirmed sends, and never an item without an openable message id", () => {
    const item = {
      id: "done_1",
      title: "Pricing sheet sent to Priya",
      line: "Attached: pricing.pdf",
      sent_at: "2026-11-22T09:38:00+00:00",
      to: "Priya Nair",
      source_id: id("sent"),
    };
    expect(parseMailCompleted({ account: "a", items: [item] }).items[0]).toMatchObject({
      title: "Pricing sheet sent to Priya",
      line: "Attached: pricing.pdf",
      sourceId: id("sent"),
    });
    for (const broken of [{ ...item, source_id: "g-real" }, { ...item, sent_at: "" }, { ...item, title: "" }]) {
      expect(() => parseMailCompleted({ account: "a", items: [broken] })).toThrow(MailOverviewError);
    }
  });
});

describe("how failures read", () => {
  it.each([
    ["BRIEF_UNAVAILABLE", 503, "brief_unavailable"],
    ["BRIEF_TIMEOUT", 504, "brief_unavailable"],
    ["BRIEF_INVALID", 502, "brief_unavailable"],
    ["BRIEF_BUSY", 429, "brief_busy"],
    ["ACCOUNT_CHANGED", 409, "account_changed"],
    ["RECONNECT_REQUIRED", 409, "reconnect_required"],
    ["MAIL_READS_UNAVAILABLE", 403, "unavailable"],
  ])("%s becomes %s", async (code, status, reason) => {
    expect(mailOverviewReason(Number(status), code)).toBe(reason);
    respond({ detail: { code, message: "Authored." } }, Number(status));
    await expect(fetchMailBrief({ vaultOwnerToken: "t" })).rejects.toMatchObject({ reason });
  });

  it("tells a dropped connection from a refusal", async () => {
    vi.mocked(ApiService.apiFetch).mockImplementationOnce(() => Promise.reject(new Error("offline")));
    const failure = await fetchMailBrief({ vaultOwnerToken: "t" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MailOverviewError);
    expect((failure as MailOverviewError).reason).toBe("network");
  });
});
