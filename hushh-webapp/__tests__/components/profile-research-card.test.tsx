import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishValidatedAuthSessionOwner } from "@/lib/auth/session-owner";

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  prepare: vi.fn(),
  addToPKM: vi.fn(),
  receipts: vi.fn(),
  clear: vi.fn(),
  candidates: vi.fn(),
  businessTarget: vi.fn(),
  readRequired: vi.fn(),
}));
vi.mock("@/lib/services/api-service", () => ({
  ApiService: { apiFetch: mocks.apiFetch },
}));
vi.mock("@/lib/services/personal-knowledge-model-service", () => ({
  PersonalKnowledgeModelService: { lookupMutationCommits: mocks.receipts },
}));
vi.mock("@/lib/services/secure-resource-cache-service", async (original) => ({
  ...(await original<
    typeof import("@/lib/services/secure-resource-cache-service")
  >()),
  SecureResourceCacheService: { readRequired: mocks.readRequired },
}));
vi.mock("@/lib/vault/one-chat-key", () => ({
  oneChatKeyHeaders: async () => ({ "X-Hussh-Chat-Key": "fixture" }),
}));
vi.mock("@/lib/pkm/pkm-natural-language-ingestion", async (original) => ({
  ...(await original<
    typeof import("@/lib/pkm/pkm-natural-language-ingestion")
  >()),
  prepareNaturalLanguagePkm: mocks.prepare,
}));
vi.mock("@/lib/agent/agent-pkm-memory", async (original) => ({
  ...(await original<typeof import("@/lib/agent/agent-pkm-memory")>()),
  addToPKM: mocks.addToPKM,
  clearAgentPkmContext: mocks.clear,
  resolveCardTargetDomain: (card: { target_domain?: string }) =>
    card.target_domain || "professional",
  isReservedPkmCard: (card: { write_mode?: string }) =>
    card.write_mode === "do_not_save",
}));
vi.mock("@/lib/profile/pkm-agent-lab-capture", () => ({
  loadPkmAgentLabContext: async () => ({
    metadata: { domains: [] },
    manifests: {},
  }),
}));
vi.mock("@/lib/profile/pkm-agent-lab-preview", () => ({
  isDegradedPreviewCard: () => false,
}));
vi.mock("@/lib/agent/agent-pkm-context-store", () => ({
  AgentPkmContextStore: {
    load: async () => null,
    findLocalDuplicate: () => ({ kind: "none" }),
    findProfileReconciliationCandidates: mocks.candidates,
    profileBusinessTarget: mocks.businessTarget,
    captureProfileReviewInventory: () => ({
      findLocalDuplicate: () => null,
      findReconciliationCandidates: mocks.candidates,
      businessTarget: mocks.businessTarget,
    }),
  },
}));

import { ProfileResearchCard } from "@/components/agent/profile-research-card";
import { profileResearchResultSchema } from "@/lib/services/profile-research-service";
import { BusinessProfileSuggestion } from "@/components/agent/business-profile-suggestion";
import { useOneConversationSession } from "@/lib/agent/one-conversation-session";
import { unwindBackLayer } from "@/lib/navigation/back-layers";
import {
  prepareProfileReview,
  assertExactProfileSelection,
  saveProfileReview,
} from "@/lib/agent/profile-research-review";

const FACT = "I work in engineering.";
const UNSURE = "I may have studied mathematics.";
const props = {
  ownerId: "owner",
  vaultKey: "key",
  vaultOwnerToken: "owner-token",
  enabled: true,
  pathname: "/",
};
function offer(match_status = "matched") {
  return {
    status: "offered",
    pkm_written: false,
    search_suggestions: [],
    report: {
      match_status,
      name: "Alex Example",
      summary: "A public professional profile.",
      sections: [
        {
          kind: "career",
          facts: [
            {
              statement: FACT,
              confidence: "supported",
              sources: [{ title: "Team", url: "https://example.test/team" }],
            },
            {
              statement: UNSURE,
              confidence: "uncertain",
              sources: [
                { title: "School", url: "https://example.test/school" },
              ],
            },
          ],
        },
      ],
    },
  };
}
function respond(value: unknown) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
function preview(message: string, recipients = 0) {
  return {
    sourceCoverage: [],
    cards: [
      {
        card_id: "career1",
        source_text: message,
        write_mode: "confirm_first",
        target_domain: "professional",
        target_entity_scope: "career",
        target_entity_id: "alex",
        merge_decision: {
          merge_mode: "create_entity",
          target_entity_path: "career.entities.alex",
        },
        candidate_payload: {
          career: { entities: { alex: { summary: FACT } } },
        },
        ...(recipients
          ? { sharing_impact: { active_recipient_count: recipients } }
          : {}),
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  publishValidatedAuthSessionOwner("owner");
  useOneConversationSession.getState().clearSession();
  mocks.apiFetch.mockImplementation((path: string) =>
    Promise.resolve(
      respond(path.endsWith("/complete") ? { saved: true } : offer()),
    ),
  );
  mocks.prepare.mockImplementation(async ({ message }: { message: string }) =>
    preview(message),
  );
  mocks.addToPKM.mockResolvedValue({
    attempted: 1,
    saved: 1,
    failed: 0,
    results: [{ success: true, result: { dataVersion: 2 } }],
  });
  mocks.receipts.mockResolvedValue([{ exists: false, dataVersion: null }]);
  mocks.candidates.mockReturnValue([]);
  mocks.businessTarget.mockReturnValue(null);
  mocks.readRequired.mockResolvedValue(null);
});
afterEach(() => {
  cleanup();
  delete window.__HUSHH_NATIVE_TEST__;
  vi.useRealTimers();
  publishValidatedAuthSessionOwner(null);
  useOneConversationSession.getState().clearSession();
});

describe("onboarding profile draft and owner confirmation", () => {
  it("suppresses ambient research for read-only review while preserving authorized owner research", async () => {
    window.__HUSHH_NATIVE_TEST__ = {
      enabled: true,
      autoReviewerLogin: true,
      reviewerMutationPolicy: "read_only",
    };
    const view = render(<ProfileResearchCard {...props} />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(screen.queryByTestId("profile-research-card")).toBeNull();

    window.__HUSHH_NATIVE_TEST__.reviewerMutationPolicy = "mutation_authorized";
    view.rerender(<ProfileResearchCard {...props} />);
    expect(await screen.findByTestId("profile-research-card")).toBeTruthy();
    await waitFor(() => expect(mocks.apiFetch.mock.calls.filter(([path]) => path === "/api/one/profile-research/jobs")).toHaveLength(1));
  });

  it("keeps cited choices without the duplicate summary or provider chips", async () => {
    const html =
      '<style>.container { padding: 8px; }</style><div class="container"><a href="https://www.google.com/search?q=Example">Example</a></div>';
    mocks.apiFetch.mockResolvedValue(
      respond({
        ...offer(),
        search_suggestions: [html],
        verification: {
          method: "model_assessment",
          identity_score: 60,
          facts: [
            { ref: "c1:0:0", score: 60 },
            { ref: "c1:0:1", score: 60 },
          ],
          attempts: 1,
        },
      }),
    );
    render(<ProfileResearchCard {...props} embedded />);
    await screen.findByText("Alex Example");
    expect(screen.queryByText(/Match confidence:/)).toBeNull();
    expect(screen.queryByText("A public professional profile.")).toBeNull();
    expect(
      screen.getByRole("checkbox", { name: `Keep ${FACT}` }),
    ).toBeChecked();
    expect(screen.queryByLabelText("Google Search suggestions")).toBeNull();
    expect(screen.queryByTitle("Google Search suggestions 1")).toBeNull();
    expect(screen.getByRole("link", { name: "Team" })).toHaveAttribute(
      "href",
      "https://example.test/team",
    );
    expect(screen.getByRole("link", { name: "School" })).toHaveAttribute(
      "href",
      "https://example.test/school",
    );
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.addToPKM).not.toHaveBeenCalled();
  });

  it("resumes a cancelled effect with the same authority and discards its late response", async () => {
    const reads: Array<(value: Response) => void> = [];
    mocks.apiFetch.mockImplementation(
      () => new Promise<Response>((resolve) => reads.push(resolve)),
    );
    const root = render(<ProfileResearchCard {...props} />);
    try {
      await waitFor(() => expect(reads).toHaveLength(1));
      // A refreshed callback/effect must not inherit a stale "attempted" latch
      // after cleanup aborts polling. The server owns dispatch coalescing.
      root.rerender(<ProfileResearchCard {...props} enabled={false} />);
      root.rerender(<ProfileResearchCard {...props} />);
      await waitFor(() => expect(reads).toHaveLength(2));
      await act(async () => reads[0](respond(offer())));
      expect(screen.queryByText("Alex Example")).toBeNull();
      await act(async () => reads[1](respond(offer())));
      expect(screen.getByText("Alex Example")).toBeVisible();
      expect(mocks.prepare).not.toHaveBeenCalled();
      expect(mocks.addToPKM).not.toHaveBeenCalled();
    } finally {
      root.unmount();
    }
  });

  it("does not repeat explicit research when its review is temporarily hidden", async () => {
    useOneConversationSession.getState().clearSession();
    const root = render(
      <StrictMode>
        <ProfileResearchCard {...props} />
      </StrictMode>,
    );
    await screen.findByText("Alex Example");
    root.rerender(
      <StrictMode>
        <ProfileResearchCard {...props} present={false} />
      </StrictMode>,
    );
    root.rerender(
      <StrictMode>
        <ProfileResearchCard {...props} />
      </StrictMode>,
    );
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() => expect(screen.queryByTestId("profile-research-card")).toBeNull());
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
  });

  it("waits for resolved onboarding and hides a saved owner's offer on a fresh chat", async () => {
    useOneConversationSession.getState().clearSession();
    mocks.apiFetch.mockResolvedValue(
      respond({ status: "saved", pkm_written: false }),
    );
    const root = render(<ProfileResearchCard {...props} enabled={false} />);
    await act(async () => {
      await new Promise((done) => setTimeout(done, 5));
    });
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    root.rerender(<ProfileResearchCard {...props} />);
    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId("profile-research-card")).toBeNull());
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.addToPKM).not.toHaveBeenCalled();
  });

  it("does not include optional business facts in a personal review unless selected", async () => {
    const result = offer();
    result.report.sections.push({
      kind: "business",
      facts: [
        {
          statement: "I founded Example.",
          confidence: "supported",
          sources: [{ title: "Company", url: "https://example.test/company" }],
        },
      ],
    });
    mocks.apiFetch.mockImplementation((path: string) =>
      Promise.resolve(
        respond(path.endsWith("/complete") ? { saved: true } : result),
      ),
    );
    render(<ProfileResearchCard {...props} />);
    await screen.findByText("Alex Example");
    fireEvent.click(screen.getByRole("button", { name: /Business/ }));
    expect(
      screen.getByRole("checkbox", { name: "Keep I founded Example." }),
    ).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Your Personal World Model details are saved.");
    expect(mocks.prepare.mock.calls[0][0].message).not.toContain(
      "I founded Example.",
    );
    expect(mocks.addToPKM).toHaveBeenCalledTimes(1);
  });

  it.each(["no_match"])(
    "never prepares or saves %s; empty research can be skipped",
    async (status) => {
      const result =
        status === "no_match"
          ? {
              ...offer(),
              report: {
                ...offer().report,
                match_status: "no_match",
                summary: "No reliable match.",
                sections: [],
              },
            }
          : { status: "unavailable", pkm_written: false };
      mocks.apiFetch.mockResolvedValueOnce(respond(result));
      render(<ProfileResearchCard {...props} />);
      if (status === "no_match") {
        await screen.findByText(/Couldn’t connect these pages to you/);
        expect(
          screen.getByRole("button", { name: "Save" }),
        ).toBeDisabled();
        expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
      }
      fireEvent.click(screen.getByRole("button", { name: "Skip" }));
      expect(mocks.prepare).not.toHaveBeenCalled();
      expect(mocks.addToPKM).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.queryByTestId("profile-research-card")).toBeNull());
    },
  );

  it("never reports the previous owner's visible Business card under a new owner", async () => {
    mocks.apiFetch
      .mockResolvedValueOnce(
        respond({
          contract_version: "b2b-profile-suggestion.v2",
          scope: "b2b",
          status: "suggestion_available",
          pkm_written: false,
          candidates: [
            {
              business_uid: `urn:hushh:business:directory:business:${"a".repeat(64)}`,
              synthetic: false,
              source_identity: {
                source: "directory",
                source_key: "real-company",
                vertical: "business",
              },
              match_evidence: [
                { kind: "verified_email_domain", domain: "example.test" },
              ],
              draft: {
                name: "Owner business",
                website: "https://example.test",
              },
              ownership_verified: false,
              claim_created: false,
              verification_required: ["business_authority"],
            },
          ],
        }),
      )
      .mockResolvedValue(
        respond({
          contract_version: "b2b-profile-suggestion.v2",
          scope: "b2b",
          status: "disabled",
          candidates: [],
          pkm_written: false,
        }),
      );
    const visibility = vi.fn();
    const expires = Date.now() + 60_000;
    const root = render(
      <BusinessProfileSuggestion
        {...props}
        tokenExpiresAt={expires}
        onVisibleChange={visibility}
      />,
    );
    await waitFor(() => expect(visibility).toHaveBeenCalledWith(true));
    visibility.mockClear();
    publishValidatedAuthSessionOwner("other");
    root.rerender(
      <BusinessProfileSuggestion
        {...props}
        ownerId="other"
        vaultOwnerToken="other-token"
        tokenExpiresAt={expires}
        onVisibleChange={visibility}
      />,
    );
    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(2));
    expect(visibility).not.toHaveBeenCalledWith(true);
    expect(screen.queryByText("Owner business")).toBeNull();
  });

  it("uses current-owner transport, dispatches once under StrictMode, and saves checked inline edits with one click", async () => {
    mocks.prepare.mockImplementation(
      async ({ message }: { message: string }) => {
        const prepared = preview(message);
        prepared.cards[0].candidate_payload.career.entities.alex.summary =
          "I lead an engineering team.";
        return prepared;
      },
    );
    render(
      <StrictMode>
        <ProfileResearchCard {...props} />
      </StrictMode>,
    );
    await screen.findByText("Alex Example");
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    expect(mocks.apiFetch.mock.calls[0][0]).toBe(
      "/api/one/profile-research/jobs",
    );
    expect(mocks.apiFetch.mock.calls[0][1]).toMatchObject({
      method: "POST",
      cache: "no-store",
      headers: { Authorization: "Bearer owner-token" },
    });
    expect(mocks.apiFetch.mock.calls[0][1].body).toBeUndefined();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.addToPKM).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Career/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(
      screen.getByRole("checkbox", { name: `Keep ${UNSURE}` }),
    ).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: `Edit ${FACT}` }), {
      target: { value: "I lead an engineering team." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Your Personal World Model details are saved.");
    const message = mocks.prepare.mock.calls[0][0].message;
    expect(message).toContain("I lead an engineering team.");
    expect(message).not.toContain(UNSURE);
    expect(message).not.toContain(FACT);
    expect(
      screen.queryByRole("button", { name: "Confirm and save" }),
    ).toBeNull();
    expect(screen.queryByTestId("agent-pkm-review-save")).toBeNull();
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    expect(mocks.addToPKM.mock.calls[0][0]).toMatchObject({
      source: "profile_research_review",
      sourceMessage: message,
      confirmation: { confirmedByUser: true, surface: "chat" },
    });
  });

  it("leaves an uncertain identity unchecked; Skip discards without memory preparation", async () => {
    mocks.apiFetch.mockResolvedValue(respond(offer("uncertain")));
    render(<ProfileResearchCard {...props} />);
    await screen.findByText("Alex Example");
    expect(
      screen.getByRole("button", { name: "Save" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.addToPKM).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId("profile-research-card")).toBeNull());
  });

  it("unwinds inline Edit without preparing or saving", async () => {
    render(<ProfileResearchCard {...props} />);
    await screen.findByText("Alex Example");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await act(async () => {
      expect(unwindBackLayer("/")).toBe(true);
    });
    expect(screen.getByRole("button", { name: "Edit" })).toBeEnabled();
    expect(screen.queryByTestId("agent-pkm-review-save")).toBeNull();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.addToPKM).not.toHaveBeenCalled();
  });

  it("keeps embedded review Back scoped to its Profile panel", async () => {
    const backQuery = { profile_pane: "1", profile_panel: "world-model" };
    render(<ProfileResearchCard {...props} embedded backQuery={backQuery} />);
    await screen.findByText("Alex Example");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(unwindBackLayer("/", new URLSearchParams("profile_pane=1&profile_panel=my-data"))).toBe(false);
    await act(async () => {
      expect(unwindBackLayer("/", new URLSearchParams(backQuery), { profile_pane: "1" })).toBe(true);
    });
    expect(screen.getByRole("button", { name: "Edit" })).toBeEnabled();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.addToPKM).not.toHaveBeenCalled();
  });

  it("keeps the reviewed cards through shared-data acknowledgement", async () => {
    mocks.prepare.mockImplementation(async ({ message }: { message: string }) =>
      preview(message, 2),
    );
    render(<ProfileResearchCard {...props} />);
    await screen.findByText("Alex Example");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("alertdialog");
    expect(mocks.addToPKM).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getAllByRole("button", { name: "Confirm and save" }).at(-1)!,
    );
    await screen.findByText("Your Personal World Model details are saved.");
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    expect(
      mocks.addToPKM.mock.calls[0][0].confirmation.sharingImpactAcknowledged,
    ).toBe(true);
  });

  it("accepts exact citation values regardless of JSON key order, but rejects sibling entities", () => {
    const message = `${FACT} Sources: Team (https://example.test/team)`;
    const prepared = {
      message,
      cards: preview(message).cards,
      origins: new Map(),
      scopes: new Map(),
      committed: new Set<string>(),
    };
    Object.assign(prepared.cards[0].candidate_payload.career.entities.alex, {
      sources: [{ url: "https://example.test/team", title: "Team" }],
    });
    const details = [
      {
        statement: FACT,
        sources: [{ title: "Team", url: "https://example.test/team" }],
      },
    ];
    expect(() => assertExactProfileSelection(prepared, details)).not.toThrow();
    Object.assign(prepared.cards[0].candidate_payload.career.entities, {
      hidden: { summary: "An unselected detail." },
    });
    expect(() => assertExactProfileSelection(prepared, details)).toThrow();
  });

  it.each(["rewritten", "extra"])(
    "rejects %s payload facts before the one-click save",
    async (kind) => {
      mocks.prepare.mockImplementation(
        async ({ message }: { message: string }) => {
          const prepared = preview(message);
          const row = prepared.cards[0].candidate_payload.career.entities.alex;
          if (kind === "rewritten") row.summary = UNSURE;
          else Object.assign(row, { is_founder: true });
          return prepared;
        },
      );
      render(<ProfileResearchCard {...props} />);
      await screen.findByText("Alex Example");
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(mocks.prepare).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Save" }),
        ).toBeEnabled(),
      );
      expect(mocks.addToPKM).not.toHaveBeenCalled();
      expect(
        mocks.apiFetch.mock.calls.some(([path]) => path.endsWith("/complete")),
      ).toBe(false);
      expect(screen.queryByTestId("agent-pkm-review-save")).toBeNull();
    },
  );

  it("retries an unconfirmed save with the pinned payload and scope, without another preparation", async () => {
    mocks.addToPKM.mockResolvedValueOnce({
      attempted: 1,
      saved: 0,
      failed: 1,
      results: [],
    });
    const view = render(<ProfileResearchCard {...props} />);
    await screen.findByText("Alex Example");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("button", { name: "Retry save" });
    // A source refresh must not throw away the exact review/scopes needed
    // to reconcile a write whose response was lost.
    const replacement = { ...offer(), report: { ...offer().report, name: "Replacement report" } };
    view.rerender(<ProfileResearchCard {...props} initialResult={profileResearchResultSchema.parse(replacement)} />);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    expect(screen.queryByText("Replacement report")).toBeNull();
    view.rerender(<ProfileResearchCard {...props} initialResult={{ status: "unavailable", pkm_written: false }} />);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
    await screen.findByText("Your Personal World Model details are saved.");
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    expect(mocks.addToPKM).toHaveBeenCalledTimes(2);
    const [first, retry] = mocks.addToPKM.mock.calls.map(([input]) => input);
    expect(retry.cards).toEqual(first.cards);
    expect(retry.idempotencyScopes).toEqual(first.idempotencyScopes);
  });

  it("keeps a written selection pinned when completion fails, then recovers from its receipt", async () => {
    let completionCalls = 0;
    mocks.apiFetch.mockImplementation((path: string) =>
      Promise.resolve(
        path.endsWith("/complete")
          ? ++completionCalls === 1
            ? new Response("Unavailable", { status: 503 })
            : respond({ saved: true })
          : respond(offer()),
      ),
    );
    render(<ProfileResearchCard {...props} />);
    await screen.findByText("Alex Example");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("button", { name: "Retry save" });
    expect(
      screen.getByRole("checkbox", { name: `Keep ${FACT}` }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
    mocks.receipts.mockResolvedValue([{ exists: true, dataVersion: 2 }]);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Retry save" }));
    await screen.findByText("Your Personal World Model details are saved.");
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    expect(mocks.addToPKM).toHaveBeenCalledTimes(1);
    expect(completionCalls).toBe(2);
  });

  it("rejects late preparation after unmount and late research after owner changes", async () => {
    let finish!: (value: ReturnType<typeof preview>) => void;
    mocks.prepare.mockReturnValue(
      new Promise((done) => {
        finish = done;
      }),
    );
    const root = render(<ProfileResearchCard {...props} />);
    await screen.findByText("Alex Example");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.prepare).toHaveBeenCalledTimes(1));
    root.unmount();
    await act(async () => {
      finish(preview(FACT));
    });
    expect(mocks.addToPKM).not.toHaveBeenCalled();
    let research!: (value: Response) => void;
    mocks.apiFetch.mockReturnValue(
      new Promise((done) => {
        research = done;
      }),
    );
    const next = render(<ProfileResearchCard {...props} />);
    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(2));
    publishValidatedAuthSessionOwner("other");
    next.rerender(<ProfileResearchCard {...props} ownerId="other" />);
    await act(async () => {
      research(respond(offer()));
    });
    expect(screen.queryByText("Alex Example")).toBeNull();
  });
});

const session = {
  userId: "owner",
  vaultKey: "key",
  vaultOwnerToken: "owner-token",
  assertCurrent: async () => undefined,
  isCurrent: () => true,
};
it("retains confirmed scopes after a lost completion response and retries without replaying Memory writes", async () => {
  const reviewed = await prepareProfileReview(session, FACT);
  mocks.apiFetch.mockRejectedValueOnce(new Error("completion response lost"));
  await expect(
    saveProfileReview(session, reviewed, new Set(["career1"]), false),
  ).rejects.toThrow();
  expect(mocks.addToPKM).toHaveBeenCalledTimes(1);
  expect(reviewed.committed.has("career1")).toBe(true);
  mocks.receipts.mockResolvedValue([{ exists: true, dataVersion: 2 }]);
  await saveProfileReview(session, reviewed, new Set(["career1"]), false);
  expect(mocks.addToPKM).toHaveBeenCalledTimes(1);
  const calls = mocks.apiFetch.mock.calls.filter(([path]) =>
    path.endsWith("/complete"),
  );
  expect(calls).toHaveLength(2);
  expect(calls[0][1].body).toBe(calls[1][1].body);
});

it("waits for partial-save recovery and completes with every accumulated receipt", async () => {
  const first = preview(FACT).cards[0];
  mocks.prepare.mockResolvedValue({
    sourceCoverage: [],
    cards: [first, { ...first, card_id: "career2" }],
  });
  const reviewed = await prepareProfileReview(session, FACT);
  mocks.addToPKM.mockResolvedValueOnce({
    saved: 1,
    failed: 0,
    results: [{ success: true, result: { dataVersion: 2 } }],
  });
  mocks.addToPKM.mockRejectedValueOnce(new Error("second write unavailable"));
  const partial = await saveProfileReview(
    session,
    reviewed,
    new Set(["career1", "career2"]),
    false,
  );
  expect([...partial.committed]).toEqual(["career1"]);
  expect(mocks.apiFetch).not.toHaveBeenCalled();
  await saveProfileReview(session, reviewed, new Set(["career2"]), false);
  const commits = JSON.parse(mocks.apiFetch.mock.calls[0][1].body).commits;
  expect(commits).toHaveLength(2);
  expect(commits[0].plan_id).not.toBe(commits[1].plan_id);
});

it("recovers a committed lost response by receipt, and does not replay a card lacking an acknowledged revision", async () => {
  const reviewed = await prepareProfileReview(session, FACT);
  mocks.addToPKM.mockRejectedValueOnce(new Error("response lost"));
  mocks.receipts
    .mockResolvedValueOnce([{ exists: false, dataVersion: null }])
    .mockResolvedValueOnce([{ exists: true, dataVersion: 3 }]);
  expect(
    (await saveProfileReview(session, reviewed, new Set(["career1"]), false))
      .saved,
  ).toBe(1);
  mocks.receipts.mockResolvedValue([{ exists: true, dataVersion: 3 }]);
  expect(
    (await saveProfileReview(session, reviewed, new Set(["career1"]), false))
      .saved,
  ).toBe(1);
  expect(mocks.addToPKM).toHaveBeenCalledTimes(1);
  mocks.receipts.mockResolvedValue([{ exists: true, dataVersion: null }]);
  mocks.addToPKM.mockResolvedValue({
    saved: 1,
    failed: 0,
    results: [{ success: true, result: {} }],
  });
  expect(
    (await saveProfileReview(session, reviewed, new Set(["career1"]), false))
      .saved,
  ).toBe(0);
});

it("preserves an existing business UID and refuses a model-minted origin", async () => {
  const card = {
    ...preview(FACT).cards[0],
    target_entity_scope: "businesses",
    target_entity_id: "known",
    merge_decision: {
      merge_mode: "extend_entity",
      target_entity_path: "businesses.entities.known",
    },
    candidate_payload: {
      businesses: { entities: { known: { summary: FACT } } },
    },
  };
  mocks.prepare.mockResolvedValue({ sourceCoverage: [], cards: [card] });
  mocks.businessTarget.mockReturnValue({
    businessUid: "business-A",
    metadata: { business_uid: "business-A" },
  });
  const reviewed = await prepareProfileReview(session, FACT);
  expect(reviewed.origins.get("career1")).toEqual({
    businessUid: "business-A",
  });
  expect(reviewed.cards[0].candidate_payload).toEqual({
    businesses: {
      entities: {
        known: {
          summary: FACT,
          _business_origin: { business_uid: "business-A" },
        },
      },
    },
  });
  mocks.prepare.mockResolvedValue({
    sourceCoverage: [],
    cards: [
      {
        ...card,
        candidate_payload: {
          notes: { entities: { known: { summary: FACT } } },
        },
      },
    ],
  });
  expect(
    (await prepareProfileReview(session, FACT)).origins.get("career1"),
  ).toEqual({ businessUid: "business-A" });
  mocks.prepare.mockResolvedValue({
    sourceCoverage: [],
    cards: [
      {
        ...card,
        candidate_payload: {
          businesses: {
            entities: {
              known: { _business_origin: { business_uid: "business-B" } },
            },
          },
        },
      },
    ],
  });
  await expect(prepareProfileReview(session, FACT)).rejects.toThrow(
    "fresh review",
  );
});

it("allows reviewed new business facts without minting directory identity or ownership", async () => {
  const card = {
    ...preview(FACT).cards[0],
    target_entity_scope: "businesses",
    target_entity_id: "new-company",
    merge_decision: {
      merge_mode: "create_entity",
      target_entity_path: "businesses.entities.new-company",
    },
    candidate_payload: {
      businesses: {
        entities: { "new-company": { summary: "I work at Example Company." } },
      },
    },
  };
  mocks.prepare.mockResolvedValue({ sourceCoverage: [], cards: [card] });
  const reviewed = await prepareProfileReview(
    session,
    "I work at Example Company.",
  );
  expect(reviewed.origins.size).toBe(0);
  expect(reviewed.cards[0].candidate_payload).toEqual(card.candidate_payload);
  expect(mocks.addToPKM).not.toHaveBeenCalled();
});
