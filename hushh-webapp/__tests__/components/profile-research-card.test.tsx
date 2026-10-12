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
  },
}));

import { ProfileResearchCard } from "@/components/agent/profile-research-card";
import { BusinessProfileSuggestion } from "@/components/agent/business-profile-suggestion";
import { OneBackgroundCards } from "@/components/agent/one-background-cards";
import { useOneConversationSession } from "@/lib/agent/one-conversation-session";
import { unwindBackLayer } from "@/lib/navigation/back-layers";
import {
  prepareProfileReview,
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
  useOneConversationSession.getState().queueProfileResearch("owner");
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
    expect(mocks.apiFetch.mock.calls.filter(([path]) => path === "/api/one/profile-research")).toHaveLength(1);
  });

  it("keeps the whole Magic offer hidden for a saved owner even when Business has a candidate", async () => {
    useOneConversationSession.getState().clearSession();
    const businessUid = `urn:hushh:business:directory:business:${"a".repeat(64)}`;
    let finishRecovery!: (value: null) => void;
    mocks.readRequired.mockImplementationOnce(
      () => new Promise<null>((resolve) => { finishRecovery = resolve; }),
    );
    mocks.apiFetch.mockImplementation((path: string) =>
      Promise.resolve(
        respond(
          path === "/api/one/profile-research"
            ? { status: "saved", pkm_written: false }
            : {
                contract_version: "b2b-profile-suggestion.v2",
                scope: "b2b",
                status: "suggestion_available",
                pkm_written: false,
                candidates: [
                  {
                    business_uid: businessUid,
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
                      name: "Example Business",
                      website: "https://example.test",
                    },
                    ownership_verified: false,
                    claim_created: false,
                    verification_required: ["business_authority"],
                  },
                ],
              },
        ),
      ),
    );
    const visible = vi.fn();
    render(
      <OneBackgroundCards
        {...props}
        tokenExpiresAt={Date.now() + 60_000}
        onVisibleChange={visible}
        renderMessage={(_id, _text, card) => card}
      />,
    );
    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mocks.readRequired).toHaveBeenCalledWith({
      userId: "owner",
      vaultKey: "key",
      resourceKey: `business_profile_review:uat:v1:${encodeURIComponent(businessUid)}`,
    }));
    await act(async () => { finishRecovery(null); });
    await waitFor(() => expect(visible).toHaveBeenLastCalledWith(false));
    expect(screen.getByTestId("magic-intelligence-card")).not.toBeVisible();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("offers an already-onboarded owner without a setup marker and consumes markers without repeating research", async () => {
    useOneConversationSession.getState().clearSession();
    const root = render(
      <StrictMode>
        <ProfileResearchCard {...props} />
      </StrictMode>,
    );
    await screen.findByText("Alex Example");
    act(() =>
      useOneConversationSession.getState().queueProfileResearch("owner"),
    );
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
    expect(screen.queryByTestId("profile-research-card")).toBeNull();
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
    expect(screen.queryByTestId("profile-research-card")).toBeNull();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.addToPKM).not.toHaveBeenCalled();
  });
  it("discards late discoveries and collapses details when the Magic owner changes", async () => {
    const pending: Array<{ path: string; resolve: (value: Response) => void }> =
      [];
    mocks.apiFetch.mockImplementation(
      (path: string) =>
        new Promise<Response>((resolve) => {
          pending.push({ path, resolve });
        }),
    );
    const root = render(
      <OneBackgroundCards
        {...props}
        tokenExpiresAt={Date.now() + 60_000}
        renderMessage={(_id, _text, card) => card}
      />,
    );
    await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(2));
    const oldRequests = pending.slice();
    publishValidatedAuthSessionOwner("other");
    root.rerender(
      <OneBackgroundCards
        {...props}
        ownerId="other"
        vaultOwnerToken="other-token"
        tokenExpiresAt={Date.now() + 60_000}
        renderMessage={(_id, _text, card) => card}
      />,
    );
    await act(async () => {
      for (const request of oldRequests)
        request.resolve(
          respond(
            request.path === "/api/one/profile-research"
              ? offer()
              : {
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
                        source_key: "old-owner-business",
                        vertical: "business",
                      },
                      match_evidence: [
                        {
                          kind: "verified_email_domain",
                          domain: "example.test",
                        },
                      ],
                      draft: {
                        name: "Old owner business",
                        website: "https://example.test",
                      },
                      ownership_verified: false,
                      claim_created: false,
                      verification_required: ["business_authority"],
                    },
                  ],
                },
          ),
        );
    });
    expect(screen.queryByText("Alex Example")).toBeNull();
    expect(screen.queryByText("Old owner business")).toBeNull();
    expect(screen.getByTestId("magic-intelligence-card")).not.toBeVisible();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.addToPKM).not.toHaveBeenCalled();
  });
  it.each(["disabled", "unavailable", "rejected", "pending"])(
    "researches and saves personal-only Magic Intelligence when Business Intelligence is %s",
    async (businessStatus) => {
      mocks.apiFetch.mockImplementation((path: string) => {
        if (path === "/api/one/business/suggestion") {
          if (businessStatus === "pending") return new Promise(() => {});
          if (businessStatus === "rejected")
            return Promise.reject(new Error("Business lookup failed"));
          return Promise.resolve(
            respond({
              contract_version: "b2b-profile-suggestion.v2",
              scope: "b2b",
              status: businessStatus,
              candidates: [],
              pkm_written: false,
            }),
          );
        }
        if (path === "/api/one/profile-research")
          return Promise.resolve(respond(offer()));
        if (path === "/api/one/profile-research/complete")
          return Promise.resolve(respond({ saved: true }));
        throw new Error(`Unexpected request: ${path}`);
      });
      render(
        <OneBackgroundCards
          {...props}
          tokenExpiresAt={Date.now() + 60_000}
          renderMessage={(id, text, card) => (
            <article key={id} aria-label={text}>
              {card}
            </article>
          )}
        />,
      );
      await screen.findByRole("button", {
        name: "Review details",
        exact: true,
      });
      expect(
        screen.getByText(
          "One found more information about you. Review it before saving to Memory.",
        ),
      ).toBeVisible();
      expect(screen.getByText("Magic Intelligence")).toBeVisible();
      expect(screen.queryByText("Alex Example")).toBeNull();
      expect(screen.queryByText("A public professional profile.")).toBeNull();
      expect(screen.queryByTestId("profile-research-card")).toBeNull();
      fireEvent.click(
        screen.getByRole("button", { name: "Review details", exact: true }),
      );
      await screen.findByText("Alex Example");
      expect(mocks.apiFetch.mock.calls.map(([path]) => path)).toEqual(
        expect.arrayContaining([
          "/api/one/business/suggestion",
          "/api/one/profile-research",
        ]),
      );
      expect(mocks.prepare).not.toHaveBeenCalled();
      expect(mocks.addToPKM).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Review and save" }));
      await screen.findByTestId("agent-pkm-review-save");
      expect(mocks.addToPKM).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Confirm and save" }));
      await waitFor(() =>
        expect(screen.getByTestId("magic-intelligence-card")).not.toBeVisible(),
      );
      expect(mocks.prepare).toHaveBeenCalledTimes(1);
      expect(mocks.addToPKM).toHaveBeenCalledTimes(1);
      expect(mocks.addToPKM.mock.calls[0][0]).toMatchObject({
        source: "profile_research_review",
        confirmation: { confirmedByUser: true, surface: "chat" },
      });
      expect(mocks.addToPKM.mock.calls[0][0].businessOrigin).toBeUndefined();
      expect(
        mocks.addToPKM.mock.calls[0][0].cards[0].candidate_payload,
      ).toEqual({
        career: { entities: { alex: { summary: FACT } } },
      });
    },
  );

  it("Back unwinds personal review before collapsing Magic, and reopening retains the research without new preparation", async () => {
    mocks.apiFetch.mockImplementation((path: string) =>
      Promise.resolve(
        respond(
          path === "/api/one/profile-research"
            ? offer()
            : {
                contract_version: "b2b-profile-suggestion.v2",
                scope: "b2b",
                status: "no_match",
                candidates: [],
                pkm_written: false,
              },
        ),
      ),
    );
    render(
      <OneBackgroundCards
        {...props}
        tokenExpiresAt={Date.now() + 60_000}
        renderMessage={(_id, _text, card) => card}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Review details",
        exact: true,
      }),
    );
    expect(mocks.prepare).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Review and save" }));
    await screen.findByRole("button", { name: "Confirm and save" });
    act(() => {
      expect(unwindBackLayer("/")).toBe(true);
    });
    expect(
      screen.queryByRole("button", { name: "Confirm and save" }),
    ).toBeNull();
    expect(screen.getByText("Alex Example")).toBeVisible();
    act(() => {
      expect(unwindBackLayer("/")).toBe(true);
    });
    expect(screen.queryByText("Alex Example")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Review details", exact: true }),
    );
    expect(screen.getByText("Alex Example")).toBeVisible();
    expect(
      mocks.apiFetch.mock.calls.filter(
        ([path]) => path === "/api/one/profile-research",
      ),
    ).toHaveLength(1);
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
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
    mocks.apiFetch.mockResolvedValue(respond(result));
    render(<ProfileResearchCard {...props} />);
    await screen.findByText("Alex Example");
    fireEvent.click(screen.getByRole("button", { name: /Business/ }));
    expect(
      screen.getByRole("checkbox", { name: "Keep I founded Example." }),
    ).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Review and save" }));
    await screen.findByRole("button", { name: "Confirm and save" });
    expect(mocks.prepare.mock.calls[0][0].message).not.toContain(
      "I founded Example.",
    );
    expect(mocks.addToPKM).not.toHaveBeenCalled();
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
        await screen.findByText(/couldn’t find a reliable public profile/);
        expect(
          screen.getByRole("button", { name: "Review and save" }),
        ).toBeDisabled();
        expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
        expect(
          useOneConversationSession.getState().pendingProfileResearch,
        ).toBeNull();
      }
      fireEvent.click(screen.getByRole("button", { name: "Skip" }));
      expect(mocks.prepare).not.toHaveBeenCalled();
      expect(mocks.addToPKM).not.toHaveBeenCalled();
      expect(screen.queryByTestId("profile-research-card")).toBeNull();
    },
  );

  it.each(["disabled", "unavailable", "rejected", "malformed"])(
    "never reveals Magic during pending or %s initial research",
    async (status) => {
      let settle!: (value: Response) => void;
      let fail!: (error: Error) => void;
      mocks.apiFetch.mockImplementation((path: string) => {
        if (path === "/api/one/business/suggestion")
          return Promise.resolve(
            respond({
              contract_version: "b2b-profile-suggestion.v2",
              scope: "b2b",
              status: "disabled",
              candidates: [],
              pkm_written: false,
            }),
          );
        return new Promise<Response>((resolve, reject) => {
          settle = resolve;
          fail = reject;
        });
      });
      const visibility = vi.fn();
      render(
        <OneBackgroundCards
          {...props}
          tokenExpiresAt={Date.now() + 60_000}
          onVisibleChange={visibility}
          renderMessage={(_id, _text, card) => card}
        />,
      );
      await waitFor(() => expect(mocks.apiFetch).toHaveBeenCalledTimes(2));
      expect(screen.getByTestId("magic-intelligence-card")).not.toBeVisible();
      expect(visibility).not.toHaveBeenCalledWith(true);
      await act(async () => {
        if (status === "rejected") fail(new Error("Unavailable"));
        else
          settle(
            respond(
              status === "malformed"
                ? { status: "offered" }
                : { status, pkm_written: false },
            ),
          );
      });
      expect(screen.getByTestId("magic-intelligence-card")).not.toBeVisible();
      expect(visibility).not.toHaveBeenCalledWith(true);
      expect(mocks.prepare).not.toHaveBeenCalled();
      expect(mocks.addToPKM).not.toHaveBeenCalled();
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

  it("uses current-owner transport, dispatches once under StrictMode, and saves only after final confirmation", async () => {
    render(
      <StrictMode>
        <ProfileResearchCard {...props} />
      </StrictMode>,
    );
    await screen.findByText("Alex Example");
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    expect(mocks.apiFetch.mock.calls[0][0]).toBe("/api/one/profile-research");
    expect(mocks.apiFetch.mock.calls[0][1]).toMatchObject({
      method: "POST",
      cache: "no-store",
      headers: { Authorization: "Bearer owner-token" },
    });
    expect(mocks.apiFetch.mock.calls[0][1].body).toBeUndefined();
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.addToPKM).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Career/ }));
    expect(
      screen.getByRole("checkbox", { name: `Keep ${UNSURE}` }),
    ).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: `Edit ${FACT}` }), {
      target: { value: "I lead an engineering team." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review and save" }));
    await screen.findByTestId("agent-pkm-review-save");
    const message = mocks.prepare.mock.calls[0][0].message;
    expect(message).toContain("I lead an engineering team.");
    expect(message).not.toContain(UNSURE);
    expect(message).not.toContain(FACT);
    expect(mocks.addToPKM).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm and save" }));
    await screen.findByText("Your Magic Intelligence details are saved.");
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    expect(mocks.addToPKM.mock.calls[0][0]).toMatchObject({
      source: "profile_research_review",
      sourceMessage: message,
      confirmation: { confirmedByUser: true, surface: "chat" },
    });
    expect(
      useOneConversationSession.getState().pendingProfileResearch,
    ).toBeNull();
  });

  it("leaves an uncertain identity unchecked; Skip discards without memory preparation", async () => {
    mocks.apiFetch.mockResolvedValue(respond(offer("uncertain")));
    render(<ProfileResearchCard {...props} />);
    await screen.findByText("Alex Example");
    expect(
      screen.getByRole("button", { name: "Review and save" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.addToPKM).not.toHaveBeenCalled();
    expect(screen.queryByTestId("profile-research-card")).toBeNull();
  });

  it("unwinds Edit and Review before leaving the screen", async () => {
    render(<ProfileResearchCard {...props} />);
    await screen.findByText("Alex Example");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await act(async () => {
      expect(unwindBackLayer("/")).toBe(true);
    });
    expect(screen.getByRole("button", { name: "Edit" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Review and save" }));
    await screen.findByTestId("agent-pkm-review-save");
    await act(async () => {
      expect(unwindBackLayer("/")).toBe(true);
    });
    expect(screen.queryByTestId("agent-pkm-review-save")).toBeNull();
    expect(mocks.addToPKM).not.toHaveBeenCalled();
  });

  it("keeps the reviewed cards through shared-data acknowledgement", async () => {
    mocks.prepare.mockImplementation(async ({ message }: { message: string }) =>
      preview(message, 2),
    );
    render(<ProfileResearchCard {...props} />);
    await screen.findByText("Alex Example");
    fireEvent.click(screen.getByRole("button", { name: "Review and save" }));
    await screen.findByTestId("agent-pkm-review-save");
    fireEvent.click(screen.getByTestId("agent-pkm-review-save"));
    await screen.findByRole("alertdialog");
    expect(mocks.addToPKM).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getAllByRole("button", { name: "Confirm and save" }).at(-1)!,
    );
    await screen.findByText("Your Magic Intelligence details are saved.");
    expect(mocks.prepare).toHaveBeenCalledTimes(1);
    expect(
      mocks.addToPKM.mock.calls[0][0].confirmation.sharingImpactAcknowledged,
    ).toBe(true);
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
    fireEvent.click(screen.getByRole("button", { name: "Review and save" }));
    await waitFor(() => expect(mocks.prepare).toHaveBeenCalledTimes(1));
    root.unmount();
    await act(async () => {
      finish(preview(FACT));
    });
    expect(mocks.addToPKM).not.toHaveBeenCalled();
    let research!: (value: Response) => void;
    useOneConversationSession.getState().queueProfileResearch("owner");
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
