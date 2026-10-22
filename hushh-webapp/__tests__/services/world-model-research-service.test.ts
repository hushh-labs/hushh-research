import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => vi.fn());
const streamFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/native-sse-fetch", () => ({
  nativeStreamFetch: streamFetch,
}));
vi.mock("@/lib/services/api-client", () => ({
  apiJson: api,
  ApiError: class extends Error {
    constructor(
      message = "unavailable",
      public status = 503,
      public payload?: unknown,
    ) {
      super(message);
    }
  },
}));
vi.mock("@/lib/vault/one-chat-key", () => ({
  oneChatKeyHeaders: vi.fn(async () => ({ "X-Hussh-Chat-Key": "synthetic" })),
}));
import { ApiError } from "@/lib/services/api-client";
import {
  WorldModelResearchService,
  pwmReportSchema,
  pwmResultSchema,
  type PwmProgress,
} from "@/lib/services/world-model-research-service";
import { WorldModelInvitationsService } from "@/lib/services/world-model-invitations-service";
vi.mock("@/lib/share/app-origin", () => ({
  resolveShareableAppOrigin: () => "https://example.test",
}));
import { WorldModelSourceService } from "@/lib/services/world-model-source-service";

it("accepts only matching display-only research provenance", () => {
  const result = {
    status: "offered",
    pkm_written: false,
    draft_id: "00000000-0000-4000-8000-000000000001",
    report: {
      match_status: "no_match",
      name: "Alex Example",
      summary: "No supported match was found.",
      sections: [],
    },
    grounded_answers: [],
    search_suggestions: [],
    research: {
      identity: {
        state: "no_match",
        reason: "No public contact match.",
        probability: null,
        selected_candidate_id: null,
        supporting_anchor_ids: [],
        next_step: "finish",
      },
      coverage: [
        "business", "career", "education", "personal", "projects", "publications",
        "achievements", "community", "interests", "preferences", "dislikes", "style",
        "food", "travel", "entertainment", "shopping", "communication",
        "digital_presence", "public_records", "security",
      ].map((topic) => ({
        topic,
        status: "not_attempted",
        attempt_ids: [],
        explanation: "No search for this topic.",
      })),
      gaps: [],
      checked_topics: [],
      searches_used: 0,
      candidates: [],
      source_use: "google_grounded_display_only",
      provider: "vertex_google_search",
    },
  };
  expect(pwmResultSchema.safeParse(result).success).toBe(true);
  const azure = {
    ...result,
    research: {
      ...result.research,
      source_use: "azure_web_grounded_display_only",
      provider: "azure_openai_web_search",
    },
  };
  expect(pwmResultSchema.safeParse(azure).success).toBe(true);
  const answer = "Alex 🧭 appears on a public page.";
  const citation = {
    start_index: answer.indexOf("public page"),
    end_index: answer.indexOf("public page") + "public page".length,
    title: "Original Bing citation",
    url: "https://example.test/source?ref=bing",
  };
  const citedAzure = {
    ...azure,
    grounded_answers: [{ answer, sources: [], citations: [citation], search_suggestions: [] }],
  };
  expect(pwmResultSchema.safeParse(citedAzure).success).toBe(true);
  const untitledAnswer = {
    answer,
    sources: [],
    citations: [{ ...citation, title: "" }],
    search_suggestions: [],
  };
  const untitledResult = pwmResultSchema.parse({
    ...citedAzure,
    grounded_answers: [untitledAnswer],
  });
  expect(untitledResult.status === "offered" && untitledResult.grounded_answers[0]).toEqual(untitledAnswer);
  expect(pwmResultSchema.safeParse({
    ...citedAzure,
    grounded_answers: [{ answer, sources: [], search_suggestions: [] }],
  }).success).toBe(false);
  expect(pwmResultSchema.safeParse({
    ...citedAzure,
    grounded_answers: [{ answer, sources: [], citations: [{ ...citation, url: "javascript:alert(1)" }], search_suggestions: [] }],
  }).success).toBe(false);
  expect(pwmResultSchema.safeParse({
    ...citedAzure,
    grounded_answers: [{ answer, sources: [], citations: [citation, citation], search_suggestions: [] }],
  }).success).toBe(false);
  expect(pwmResultSchema.safeParse({
    ...azure,
    research: { ...azure.research, provider: "vertex_google_search" },
  }).success).toBe(false);
});

it("accepts a deep PWM draft with scored evidence but rejects padded duplicates", () => {
  const sections = [
    "business", "career", "education", "projects", "publications", "achievements", "community",
  ].map((kind, group) => ({
    kind,
    facts: Array.from({ length: group === 6 ? 29 : 40 }, (_, index) => ({
      statement: `Supported detail ${group}-${index}.`,
      confidence: "supported",
      sources: [{ title: "Source", url: "https://example.test/source" }],
      evidence_score: 6,
      evidence_reason: "One cited public page; awaiting your review.",
    })),
  }));
  const report = {
    match_status: "matched",
    name: "Alex Example",
    summary: "Cited public details.",
    sections,
  };
  expect(pwmReportSchema.safeParse(report).success).toBe(true);
  expect(pwmReportSchema.safeParse({
    ...report,
    match_status: "uncertain",
    summary: "No new personal findings remain after review.",
    sections: [],
  }).success).toBe(true);
  expect(pwmReportSchema.safeParse({
    ...report,
    match_status: "no_match",
  }).success).toBe(false);
  expect(pwmReportSchema.safeParse({
    ...report,
    sections: sections.map((section, index) => index === 6
      ? { ...section, facts: [...section.facts, section.facts[0]] }
      : section),
  }).success).toBe(false);
});
const session = {
  vaultKey: "synthetic-key",
  vaultOwnerToken: "synthetic-token",
  isCurrent: () => true,
};
const progress = (searches: number): PwmProgress => ({
  stage: "coverage",
  searches_used: searches,
  searches_total: 32,
  model_calls_used: searches * 2,
  model_calls_total: 128,
  topics_checked: ["career"],
  sources_found: searches,
  recent_sources: [{ title: "Public page", url: "https://example.test/p" }],
  identity_state: "owner_linked",
  candidates: 1,
  started_at: "2026-10-15T00:00:00Z",
  last_activity_at: "2026-10-15T00:01:00Z",
  slice: 1,
});
const validatedFact = {
  id: "candidate-a:career:fact-1",
  topic: "career",
  statement: "Works at Acme Corp",
  confidence: "supported",
  sources: [{ title: "Acme team page", url: "https://acme.example/team" }],
  identity_state: "owner_linked",
};
const frame = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
/** A live response whose frames arrive in the given pieces. */
const eventStream = (...pieces: string[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of pieces)
          controller.enqueue(new TextEncoder().encode(piece));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
describe("PWM service authority and request recovery", () => {
  beforeEach(() => {
    api.mockReset();
    streamFetch.mockReset();
    // Without a live connection the driver reads, as it always did.
    streamFetch.mockRejectedValue(new Error("no stream"));
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());
  it.each([
    ["azure_openai_web_search", "pwm-azure-bing-v1"],
    ["vertex_google_search", "pwm-native-v1"],
  ] as const)("sends the %s consent marker for preference updates", async (research_provider, consent_version) => {
    const response = { enabled: true, email_enabled: false, consent_version: "pwm-native-v1", research_provider };
    api.mockResolvedValue(response);

    await expect(WorldModelResearchService.updatePreferences(session, {
      enabled: true,
      email_enabled: false,
      research_provider,
    })).resolves.toEqual(response);

    expect(api).toHaveBeenCalledTimes(1);
    expect(api.mock.calls[0][0]).toBe("/api/one/world-model/preferences");
    expect(api.mock.calls[0][1].method).toBe("PUT");
    expect(JSON.parse(api.mock.calls[0][1].body)).toEqual({
      enabled: true,
      email_enabled: false,
      consent_version,
    });
  });
  it("automatically ensures once, then reads the existing job", async () => {
    api
      .mockResolvedValueOnce({
        status: "pending",
        pkm_written: false,
        restart_required: false,
      })
      .mockResolvedValueOnce({ status: "saved", pkm_written: false });
    const onResult = vi.fn();
    const run = WorldModelResearchService.observe({
      ...session,
      signal: new AbortController().signal,
      onResult,
    });
    await vi.runAllTimersAsync();
    await run;
    expect(api.mock.calls.map(([path, init]) => [path, init.method])).toEqual([
      ["/api/one/world-model/ensure", "POST"],
      ["/api/one/world-model/jobs", "GET"],
    ]);
    expect(onResult).toHaveBeenCalledTimes(2);
  });
  it("reads after an uncertain POST response, without starting duplicate work", async () => {
    api
      .mockRejectedValueOnce(new Error("lost response"))
      .mockResolvedValueOnce({ status: "saved", pkm_written: false });
    const run = WorldModelResearchService.observe({
      ...session,
      signal: new AbortController().signal,
      onResult: vi.fn(),
    });
    await vi.runAllTimersAsync();
    await run;
    expect(api.mock.calls[1][1].method).toBe("GET");
  });
  it("requires fresh authority before dispatch", async () => {
    const check = vi.fn().mockRejectedValue(new Error("owner changed"));
    await expect(
      WorldModelResearchService.preferences({
        ...session,
        assertCurrent: check,
      }),
    ).rejects.toThrow();
    expect(api).not.toHaveBeenCalled();
  });
  it("separates explicit refresh from automatic ensure", async () => {
    api.mockResolvedValue({ status: "saved", pkm_written: false });
    await WorldModelResearchService.observe({
      ...session,
      signal: new AbortController().signal,
      refresh: true,
      onResult: vi.fn(),
    });
    expect(api.mock.calls[0][0]).toBe("/api/one/world-model/jobs");
    expect(api.mock.calls[0][1].method).toBe("POST");
    expect(JSON.parse(api.mock.calls[0][1].body)).toEqual({ refresh: true });
  });
  it("sends explicitly selected public profiles only to a jobs refresh", async () => {
    api.mockResolvedValue({ status: "saved", pkm_written: false });
    const publicProfileUrls = ["https://github.com/public-example"];
    for (const refresh of [true, false]) await WorldModelResearchService.observe({
      ...session, signal: new AbortController().signal, refresh, publicProfileUrls, onResult: vi.fn(),
    });
    expect(JSON.parse(api.mock.calls[0][1].body)).toEqual({ refresh: true, public_profiles: {
      urls: publicProfileUrls, permitted_public_sources: true,
    } });
    expect(api.mock.calls[1][0]).toBe("/api/one/world-model/ensure");
    expect(api.mock.calls[1][1].body).toBeUndefined();
  });
  it("sends owner decisions only when starting research", async () => {
    const ownerDecisions = { confirmed: ["Saved."], rejected: ["Declined."] };
    api
      .mockResolvedValueOnce({
        status: "pending",
        pkm_written: false,
        restart_required: false,
      })
      .mockResolvedValueOnce({ status: "saved", pkm_written: false })
      .mockResolvedValueOnce({ status: "saved", pkm_written: false })
      .mockResolvedValueOnce({ status: "saved", pkm_written: false });
    const signal = new AbortController().signal;
    const run = WorldModelResearchService.observe({
      ...session,
      signal,
      onResult: vi.fn(),
      ownerDecisions,
    });
    await vi.runAllTimersAsync();
    await run;
    await WorldModelResearchService.observe({
      ...session,
      signal,
      onResult: vi.fn(),
      refresh: true,
      ownerDecisions,
    });
    await WorldModelResearchService.observe({
      ...session,
      signal,
      onResult: vi.fn(),
    });
    expect(
      api.mock.calls.map(([path, init]) => [
        path,
        init.method,
        init.body === undefined ? undefined : JSON.parse(init.body),
      ]),
    ).toEqual([
      [
        "/api/one/world-model/ensure",
        "POST",
        { owner_decisions: ownerDecisions },
      ],
      ["/api/one/world-model/jobs", "GET", undefined],
      [
        "/api/one/world-model/jobs",
        "POST",
        { owner_decisions: ownerDecisions, refresh: true },
      ],
      ["/api/one/world-model/ensure", "POST", undefined],
    ]);
  });
  it("does not spend the polling deadline while the tab is hidden", async () => {
    let hidden = false;
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => hidden,
    });
    try {
      api.mockResolvedValue({
        status: "pending",
        pkm_written: false,
        restart_required: false,
      });
      const onResult = vi.fn();
      const controller = new AbortController();
      const run = WorldModelResearchService.observe({
        ...session,
        signal: controller.signal,
        onResult,
      });
      run.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(api).toHaveBeenCalledTimes(1);
      hidden = true;
      // Two hours away: no polling, and the hour-long budget is not spent.
      await vi.advanceTimersByTimeAsync(5_000 + 7_200_000);
      expect(api).toHaveBeenCalledTimes(1);
      hidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
      expect(api).toHaveBeenCalledTimes(2);
      expect(onResult).not.toHaveBeenCalledWith(
        expect.objectContaining({ status: "paused" }),
      );
      controller.abort();
      await expect(run).rejects.toThrow();
    } finally {
      delete (document as { hidden?: boolean }).hidden;
    }
  });
  it("rejects extra private fields in a status payload", () => {
    expect(
      pwmResultSchema.safeParse({
        status: "saved",
        pkm_written: false,
        secret: "unexpected",
      }).success,
    ).toBe(false);
  });
  it("accepts cited provisional facts and a terminal checkpoint, but rejects uncited facts", () => {
    expect(pwmResultSchema.safeParse({
      status: "pending", pkm_written: false, restart_required: false,
      validated_facts: [validatedFact],
    }).success).toBe(true);
    expect(pwmResultSchema.safeParse({
      status: "unavailable", pkm_written: false,
      progress: progress(9), validated_facts: [validatedFact],
    }).success).toBe(true);
    expect(pwmResultSchema.safeParse({
      status: "pending", pkm_written: false, restart_required: false,
      validated_facts: [{ ...validatedFact, sources: [] }],
    }).success).toBe(false);
  });
  it("forwards provisional facts from a polled unavailable result", async () => {
    api.mockResolvedValueOnce({
      status: "unavailable", pkm_written: false,
      progress: progress(9), validated_facts: [validatedFact],
    });
    const onPartial = vi.fn();
    const onProgress = vi.fn();
    await WorldModelResearchService.observe({
      ...session,
      signal: new AbortController().signal,
      onResult: vi.fn(), onPartial, onProgress,
    });
    expect(onPartial).toHaveBeenCalledWith([validatedFact]);
    expect(onProgress).toHaveBeenCalledWith(progress(9));
  });
  it("delivers an unavailable result with a reason and retry window, then stops", async () => {
    api.mockResolvedValueOnce({
      status: "unavailable",
      pkm_written: false,
      reason: "provider_unavailable",
      retry_after_s: 900,
    });
    const onResult = vi.fn();
    const run = WorldModelResearchService.observe({
      ...session,
      signal: new AbortController().signal,
      onResult,
    });
    await vi.runAllTimersAsync();
    await run;
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith({
      status: "unavailable",
      pkm_written: false,
      reason: "provider_unavailable",
      retry_after_s: 900,
    });
    // Terminal for this run: the one ensure, no re-POST, no further reads.
    expect(api).toHaveBeenCalledTimes(1);
    expect(api.mock.calls[0][1].method).toBe("POST");
  });
  it("does not mistake an older draft for a failed preparation", async () => {
    api
      .mockRejectedValueOnce(new Error("request lost"))
      .mockResolvedValue({ status: "offered", draft_id: "old-alice" });
    await expect(
      WorldModelSourceService.prepare(session, {
        name: "Bob",
        urls: ["https://example.test/bob"],
        purpose: "invitation",
        permitted_public_sources: true,
      }),
    ).rejects.toThrow("request lost");
    expect(api).toHaveBeenCalledTimes(1);
  });
  it("puts invitation capability in a fragment, never in the query string", async () => {
    const token = "a".repeat(43);
    api.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000001",
      token,
      expires_at: "2030-01-01",
    });
    const result = await WorldModelInvitationsService.create(
      session,
      "recipient@example.test",
      {
        preview_draft_id: "00000000-0000-4000-8000-000000000002",
        selected_fact_ids: ["career:0"],
        introduction: "Hello",
      },
    );
    const url = new URL(result.url);
    expect(url.pathname).toBe("/world-model/invite");
    expect(url.search).toBe("");
    expect(url.hash).toBe(`#claim=${token}`);
    expect(JSON.parse(api.mock.calls[0][1].body).selected_fact_ids).toEqual([
      "career:0",
    ]);
  });
  it("accepts only the generic valid response for a previewless invitation", async () => {
    const token = "a".repeat(43);
    api.mockResolvedValueOnce({ has_preview: false });
    await expect(WorldModelInvitationsService.preview(token)).resolves.toEqual({
      has_preview: false,
    });
    expect(api.mock.calls[0][0]).toBe(
      "/api/one/world-model/invitation-preview",
    );
    expect(JSON.parse(api.mock.calls[0][1].body)).toEqual({ token });
    api.mockResolvedValueOnce({ has_preview: false, introduction: "invented" });
    await expect(WorldModelInvitationsService.preview(token)).rejects.toThrow();
  });
});

describe("PWM research driver never storms the server", () => {
  const restart = {
    status: "pending",
    pkm_written: false,
    restart_required: true,
  };
  type Call = { at: number; method: string; path: string; tab: string };
  let calls: Call[];
  const record = (path: string, init: RequestInit) => {
    const call = {
      at: Date.now(),
      method: String(init.method),
      path: path.replace("/api/one/world-model/", ""),
      tab: String(
        (init.headers as Record<string, string>).Authorization,
      ).replace("Bearer ", ""),
    };
    calls.push(call);
    return call;
  };
  const posts = (tab?: string) =>
    calls.filter(
      (call) => call.method === "POST" && (!tab || call.tab === tab),
    );
  const gaps = (rows: Call[]) =>
    rows.slice(1).map((row, index) => row.at - rows[index].at);
  beforeEach(() => {
    api.mockReset();
    streamFetch.mockReset();
    streamFetch.mockRejectedValue(new Error("no stream"));
    calls = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (navigator as { locks?: unknown }).locks;
  });

  it("keeps explicit read-only observation on status reads even when a restart is needed", async () => {
    const requestLock = vi.fn(async (_name: string, _options: { ifAvailable?: boolean }, callback: (lock: unknown) => Promise<unknown>) => callback({}));
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request: requestLock } });
    api.mockImplementation(async (path: string, init: RequestInit) => {
      record(path, init);
      return restart;
    });
    const controller = new AbortController();
    const onResult = vi.fn();
    const run = WorldModelResearchService.observe({
      ...session, ownerId: "read-only-owner", readOnly: true, refresh: true,
      signal: controller.signal, onResult,
    });
    run.catch(() => undefined);
    try {
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(posts()).toEqual([]);
      expect(calls.length).toBeGreaterThan(1);
      expect(calls.every(call => call.method === "GET" && call.path === "jobs")).toBe(true);
      expect(onResult).toHaveBeenCalledWith(restart);
      expect(requestLock).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      await run.catch(() => undefined);
    }
  });

  it("backs off after 429 on ensure, keeps reading, and never gives up", async () => {
    api.mockImplementation(async (path: string, init: RequestInit) => {
      const call = record(path, init);
      if (call.method === "POST" && posts().length > 1)
        throw new ApiError("Too many requests", 429);
      return restart;
    });
    const controller = new AbortController();
    const run = WorldModelResearchService.observe({
      ...session,
      signal: controller.signal,
      onResult: vi.fn(),
    });
    let settled = false;
    run.then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    // Old loop: ensure, 429, read, ensure ... every ~11 s (about 160 POSTs).
    expect(posts().length).toBeLessThanOrEqual(4);
    expect(Math.min(...gaps(posts()))).toBeGreaterThanOrEqual(60_000);
    expect(calls.filter((call) => call.method === "GET").length).toBeGreaterThan(
      20,
    );
    expect(settled).toBe(false);
    controller.abort();
    await expect(run).rejects.toThrow();
  });

  it("stops after failed ensure is followed only by bare pending reads", async () => {
    api.mockImplementation(async (path: string, init: RequestInit) => {
      const call = record(path, init);
      if (call.method === "POST")
        throw new ApiError("Research unavailable", 503);
      return restart;
    });
    const onResult = vi.fn();
    const run = WorldModelResearchService.observe({
      ...session,
      signal: new AbortController().signal,
      onResult,
    });
    const outcome = run.then(() => "completed", () => "failed");
    await vi.advanceTimersByTimeAsync(130_000);
    expect(await outcome).toBe("failed");
    expect(posts().length).toBeGreaterThanOrEqual(2);
    expect(Math.min(...gaps(posts()))).toBeGreaterThanOrEqual(60_000);
    expect(onResult).toHaveBeenCalledWith(restart);
  });

  it("checks status after a hidden spell instead of spending the failed-start wait", async () => {
    let hidden = false;
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => hidden,
    });
    try {
      api.mockImplementation(async (path: string, init: RequestInit) => {
        const call = record(path, init);
        if (call.method === "POST") throw new ApiError("Research unavailable", 503);
        return restart;
      });
      const controller = new AbortController();
      const run = WorldModelResearchService.observe({
        ...session,
        signal: controller.signal,
        onResult: vi.fn(),
      });
      let settled = false;
      run.finally(() => { settled = true; }).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      hidden = true;
      await vi.advanceTimersByTimeAsync(6_000 + 600_000);
      expect(calls).toHaveLength(1);
      hidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
      expect(calls.some((call) => call.method === "GET")).toBe(true);
      expect(settled).toBe(false);
      controller.abort();
      await expect(run).rejects.toThrow();
    } finally {
      delete (document as { hidden?: boolean }).hidden;
    }
  });

  it("continues when a failed ensure is followed by a real checkpoint", async () => {
    api.mockImplementation(async (path: string, init: RequestInit) => {
      const call = record(path, init);
      if (call.method === "POST")
        throw new ApiError("Research unavailable", 503);
      return {
        ...restart,
        progress: {
          stage: "starting", searches_used: 0, searches_total: 8,
          model_calls_used: 0, model_calls_total: 16,
          topics_checked: [], sources_found: 0, recent_sources: [],
          identity_state: null, candidates: 0, started_at: null,
          last_activity_at: null, slice: 1,
        },
      };
    });
    const controller = new AbortController();
    const onProgress = vi.fn();
    const run = WorldModelResearchService.observe({
      ...session,
      signal: controller.signal,
      onResult: vi.fn(),
      onProgress,
    });
    run.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(150_000);
    expect(onProgress).toHaveBeenCalled();
    controller.abort();
    await expect(run).rejects.toThrow();
  });

  it("does not end a rate-limited retry on the previous run's unavailable status", async () => {
    api.mockImplementation(async (path: string, init: RequestInit) => {
      const call = record(path, init);
      if (call.method === "POST" && posts().length === 1)
        throw new ApiError("Too many requests", 429);
      return call.method === "POST"
        ? { status: "saved", pkm_written: false }
        : { status: "unavailable", pkm_written: false, reason: "provider_unavailable" };
    });
    const onResult = vi.fn();
    const run = WorldModelResearchService.observe({
      ...session,
      signal: new AbortController().signal,
      onResult,
    });
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
    expect(posts()).toHaveLength(1);
    expect(calls.some((call) => call.method === "GET")).toBe(true);
    expect(onResult).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(posts()).toHaveLength(2);
    expect(onResult).toHaveBeenCalledWith({ status: "saved", pkm_written: false });
  });

  it("accepts a completed run from another tab while the rate-limited POST waits", async () => {
    api.mockRejectedValueOnce(new ApiError("Too many requests", 429))
      .mockResolvedValueOnce({ status: "saved", pkm_written: false });
    const onResult = vi.fn();
    const run = WorldModelResearchService.observe({
      ...session,
      signal: new AbortController().signal,
      onResult,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await run;
    expect(api.mock.calls.map(([, init]) => init.method)).toEqual(["POST", "GET"]);
    expect(onResult).toHaveBeenCalledWith({ status: "saved", pkm_written: false });
  });

  it("posts at most once a minute while the server keeps asking to restart", async () => {
    api.mockImplementation(async (path: string, init: RequestInit) => {
      record(path, init);
      return restart;
    });
    const controller = new AbortController();
    const run = WorldModelResearchService.observe({
      ...session,
      ownerId: "owner-without-web-locks",
      signal: controller.signal,
      onResult: vi.fn(),
    });
    run.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(posts().length).toBeGreaterThanOrEqual(2);
    expect(posts().length).toBeLessThanOrEqual(6);
    expect(Math.min(...gaps(posts()))).toBeGreaterThanOrEqual(60_000);
    controller.abort();
    await expect(run).rejects.toThrow();
  });

  it("lets one tab drive per owner; another tab only reads, then takes over", async () => {
    const held = new Set<string>();
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        async request(
          name: string,
          options: { ifAvailable?: boolean },
          callback: (lock: unknown) => Promise<unknown>,
        ) {
          expect(options).toEqual({ ifAvailable: true });
          if (held.has(name)) return callback(null);
          held.add(name);
          try {
            return await callback({ name });
          } finally {
            held.delete(name);
          }
        },
      },
    });
    api.mockImplementation(async (path: string, init: RequestInit) => {
      record(path, init);
      return restart;
    });
    const first = new AbortController();
    const second = new AbortController();
    const observe = (tab: string, signal: AbortSignal) =>
      WorldModelResearchService.observe({
        vaultKey: "synthetic-key",
        vaultOwnerToken: tab,
        ownerId: "owner-1",
        signal,
        onResult: vi.fn(),
      });
    const runs = [observe("tab-a", first.signal), observe("tab-b", second.signal)];
    runs.forEach((run) => run.catch(() => undefined));
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(held).toEqual(new Set(["pwm-research:owner-1"]));
    expect(posts("tab-a").length).toBeGreaterThan(0);
    expect(posts("tab-b")).toEqual([]);
    const reads = calls.filter((call) => call.tab === "tab-b");
    expect(reads.length).toBeGreaterThan(0);
    expect(Math.min(...gaps(reads))).toBeGreaterThanOrEqual(15_000);
    // The driving tab closes: the reader becomes the only driver.
    first.abort();
    await expect(runs[0]).rejects.toThrow();
    const handover = Date.now();
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(posts("tab-a").every((call) => call.at <= handover)).toBe(true);
    expect(posts("tab-b").length).toBeGreaterThan(0);
    expect(Math.min(...gaps(posts("tab-b")))).toBeGreaterThanOrEqual(60_000);
    second.abort();
    await expect(runs[1]).rejects.toThrow();
  });
});

describe("PWM live progress", () => {
  const pending = {
    status: "pending",
    pkm_written: false,
    restart_required: false,
  };
  beforeEach(() => {
    api.mockReset();
    streamFetch.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    delete (navigator as { locks?: unknown }).locks;
  });

  it("parses stream frames into progress, then the result, and refuses a failed open", async () => {
    const saved = { status: "saved", pkm_written: false };
    const frames =
      frame("progress", progress(3)) +
      frame("ping", {}) +
      frame("partial", { validated_facts: [validatedFact] }) +
      frame("partial", { validated_facts: [] }) +
      frame("progress", progress(4)) +
      frame("result", saved);
    // Frames split mid-line, as a network delivers them.
    streamFetch.mockResolvedValueOnce(
      eventStream(frames.slice(0, 40), frames.slice(40, 300), frames.slice(300)),
    );
    const onProgress = vi.fn();
    const onPartial = vi.fn();
    const onResult = vi.fn();
    await WorldModelResearchService.stream({
      ...session,
      signal: new AbortController().signal,
      onProgress,
      onPartial,
      onResult,
    });
    const [path, init] = streamFetch.mock.calls[0];
    expect(path).toBe("/api/one/world-model/jobs/stream");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer synthetic-token",
      Accept: "text/event-stream",
      "X-Hussh-Chat-Key": "synthetic",
    });
    expect(onProgress.mock.calls.map(([value]) => value.searches_used)).toEqual(
      [3, 4],
    );
    expect(onPartial.mock.calls.map(([facts]) => facts)).toEqual([[validatedFact], []]);
    expect(onResult).toHaveBeenCalledWith(saved);
    streamFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ detail: "down" }), { status: 503 }),
    );
    await expect(
      WorldModelResearchService.stream({
        ...session,
        signal: new AbortController().signal,
        onProgress,
        onResult,
      }),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("drives running research over the stream, then polls after two failed streams", async () => {
    api.mockResolvedValue(pending);
    let opened = 0;
    streamFetch.mockImplementation(async () => {
      opened += 1;
      // Three streams the server closes at its time limit, each with the
      // live status as its last frame, then a broken link.
      if (opened > 3) throw new Error("connection lost");
      return eventStream(
        frame("progress", progress(opened)) + frame("result", pending),
      );
    });
    const onProgress = vi.fn();
    const controller = new AbortController();
    const run = WorldModelResearchService.observe({
      ...session,
      signal: controller.signal,
      onResult: vi.fn(),
      onProgress,
    });
    run.catch(() => undefined);
    // A stream that ends with the live status reopens at once; the first
    // broken one is followed by a read a second later.
    await vi.advanceTimersByTimeAsync(500);
    // While the stream carries progress, nothing is polled.
    expect(api.mock.calls.map(([path]) => path)).toEqual([
      "/api/one/world-model/ensure",
    ]);
    expect(onProgress.mock.calls.map(([value]) => value.searches_used)).toEqual(
      [1, 2, 3],
    );
    expect(opened).toBe(4);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(opened).toBe(5);
    const reads = api.mock.calls.filter(([, init]) => init.method === "GET");
    expect(reads.length).toBeGreaterThanOrEqual(10);
    controller.abort();
    await expect(run).rejects.toThrow();
  });

  it("treats a stream that closed without a result as failed: a read after each, polling after two", async () => {
    api.mockResolvedValue(pending);
    const log: string[] = [];
    api.mockImplementation(async (path: string, init: RequestInit) => {
      log.push(`${init.method} ${path.replace("/api/one/world-model/", "")}`);
      return pending;
    });
    // An intermediary that drops idle responses: a clean close, no frames.
    streamFetch.mockImplementation(async () => {
      log.push("stream");
      return eventStream("");
    });
    const onInterrupted = vi.fn();
    const controller = new AbortController();
    const run = WorldModelResearchService.observe({
      ...session,
      signal: controller.signal,
      onResult: vi.fn(),
      onInterrupted,
    });
    run.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(30_000);
    // Old loop: a fresh stream every second and never a read.
    expect(log.slice(0, 5)).toEqual([
      "POST ensure",
      "stream",
      "GET jobs",
      "stream",
      "GET jobs",
    ]);
    expect(log.filter((entry) => entry === "stream")).toHaveLength(2);
    expect(onInterrupted).toHaveBeenCalledTimes(2);
    expect(log.filter((entry) => entry === "GET jobs").length).toBeGreaterThanOrEqual(5);
    controller.abort();
    await expect(run).rejects.toThrow();
  });

  it("a reading tab polls every 15 s and surfaces the polled progress", async () => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: {
        // Another tab holds the owner's lock for good.
        request: async (
          _name: string,
          _options: unknown,
          callback: (lock: unknown) => Promise<unknown>,
        ) => callback(null),
      },
    });
    const at: number[] = [];
    api.mockImplementation(async () => {
      at.push(Date.now());
      return { ...pending, progress: progress(at.length) };
    });
    const onProgress = vi.fn();
    const controller = new AbortController();
    const run = WorldModelResearchService.observe({
      ...session,
      ownerId: "owner-1",
      signal: controller.signal,
      onResult: vi.fn(),
      onProgress,
    });
    run.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(streamFetch).not.toHaveBeenCalled();
    expect(api.mock.calls.every(([, init]) => init.method === "GET")).toBe(true);
    expect(at.length).toBeGreaterThanOrEqual(4);
    expect(Math.min(...at.slice(1).map((t, i) => t - at[i]))).toBe(15_000);
    expect(onProgress).toHaveBeenCalledTimes(at.length);
    expect(onProgress.mock.calls.at(-1)?.[0].searches_used).toBe(at.length);
    controller.abort();
    await expect(run).rejects.toThrow();
  });
});
