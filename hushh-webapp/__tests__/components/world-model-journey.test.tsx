/**
 * The owner's journey through the Personal World Model pane, on the real pane
 * tree (ProfilePage in pane mode beside the app-level WorldModelProvider) with
 * the network mocked at fetch: research starts on its own, streams what it is
 * doing, ends in a report the owner reviews with Yes and No, and the owner is
 * never left on a blank status line.
 */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PwmClaim, PwmMemory } from "@/lib/services/world-model-decision-service";
import type { PwmProgress } from "@/lib/services/world-model-research-service";

const nav = vi.hoisted(() => ({
  query: "profile_pane=1&profile_panel=world-model",
  router: {
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
    refresh: vi.fn(),
    forward: vi.fn(),
  },
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/one",
  useRouter: () => nav.router,
  useSearchParams: () => new URLSearchParams(nav.query),
}));
// The signed-in account, with the name and verified contacts research pivots on.
const auth = vi.hoisted(() => ({
  user: {
    uid: "owner-a",
    displayName: "Alice Example",
    email: "alice.example@example.com",
    emailVerified: true,
    providerData: [],
    getIdToken: async () => "id-token",
  },
  loading: false,
  sessionVerificationRequired: false,
  phoneNumber: "+14155550123",
  signOut: async () => undefined,
  startPhoneVerification: async () => undefined,
  confirmPhoneVerification: async () => undefined,
  startPhoneReplacement: async () => undefined,
  confirmPhoneReplacement: async () => undefined,
}));
vi.mock("@/lib/firebase/auth-context", () => ({ useAuth: () => auth }));
// A real-shaped vault key: the chat key the requests carry is derived from it.
const vault = vi.hoisted(() => ({
  vaultKey: "ab".repeat(32),
  vaultOwnerToken: "token-a",
  getVaultOwnerToken: () => vault.vaultOwnerToken,
  isVaultUnlocked: true,
  tokenExpiresAt: null,
}));
vi.mock("@/lib/vault/vault-context", () => ({ useVault: () => vault }));
vi.mock("@/lib/persona/persona-context", () => ({
  usePersonaState: () => ({ personaState: null, refresh: async () => undefined }),
}));
vi.mock("@/lib/agent/agent-pkm-capture-runtime", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/agent/agent-pkm-capture-runtime")
  >()),
  createAgentPkmCaptureGuard: ({
    signal,
    isEnabled,
  }: {
    signal: AbortSignal;
    isEnabled: () => boolean;
  }) => ({
    isCurrent: () => !signal.aborted && isEnabled(),
    assertCurrent: async () => {
      if (signal.aborted || !isEnabled()) throw new Error("stale");
    },
  }),
}));

import { ProfilePage } from "@/components/profile/profile-workspace-page";
import { WorldModelProvider } from "@/components/profile/world-model-provider";
import { WorldModelInvitations } from "@/components/profile/world-model-invitations";
import { WorldModelInvitationsService } from "@/lib/services/world-model-invitations-service";
import {
  WorldModelDecisionService,
  pwmClaimKey,
} from "@/lib/services/world-model-decision-service";
import { VaultService } from "@/lib/services/vault-service";

const DRAFT_ID = "00000000-0000-4000-8000-000000000001";
const TOPICS = [
  "business", "career", "education", "personal", "projects", "publications",
  "achievements", "community", "interests", "preferences", "dislikes", "style",
  "food", "travel", "entertainment", "shopping", "communication",
  "digital_presence", "public_records", "security",
];
const team = { title: "Acme Corp – Team", url: "https://acme.example/team" };
const alumni = { title: "Example Uni – Alumni", url: "https://uni.example/alumni" };
const DESIGNER = "Works at Acme as a product designer";
const SPEAKER = "Spoke at a design conference";
const STUDIED = "Studied at Example Uni";
const pending = { status: "pending", pkm_written: false, restart_required: false };
const preferences = {
  enabled: true,
  email_enabled: true,
  consent_version: "pwm-native-v1",
  research_provider: "vertex_google_search",
};
/** Two sections, three statements; one with doubtful evidence. */
const offered = {
  status: "offered",
  pkm_written: false,
  draft_id: DRAFT_ID,
  report: {
    match_status: "matched",
    name: "Alice Example",
    summary: "Alice works on private agents.",
    sections: [
      {
        kind: "career",
        facts: [
          { statement: DESIGNER, confidence: "supported", sources: [team] },
          { statement: SPEAKER, confidence: "uncertain", sources: [team] },
        ],
      },
      {
        kind: "education",
        facts: [{ statement: STUDIED, confidence: "supported", sources: [alumni] }],
      },
    ],
  },
  grounded_answers: [],
  search_suggestions: [],
  research: {
    identity: {
      state: "owner_linked",
      reason: "Same verified email on the team page.",
      probability: null,
      selected_candidate_id: "c1",
      supporting_anchor_ids: ["a1"],
      next_step: "finish",
    },
    coverage: TOPICS.map((topic) => ({
      topic,
      status: topic === "career" || topic === "education" ? "findings" : "not_attempted",
      attempt_ids: topic === "career" ? [1] : topic === "education" ? [2] : [],
      explanation: "Public pages",
    })),
    gaps: [],
    checked_topics: ["career", "education"],
    searches_used: 5,
    candidates: [
      { id: "c1", label: "Alice Example", anchor_ids: ["a1"], blocking_conflicts: [] },
    ],
    source_use: "google_grounded_display_only",
    provider: "vertex_google_search",
  },
};
const progress = (over: Partial<PwmProgress> = {}): PwmProgress => ({
  stage: "identity",
  searches_used: 1,
  searches_total: 32,
  model_calls_used: 2,
  model_calls_total: 128,
  topics_checked: ["career"],
  sources_found: 0,
  recent_sources: [],
  identity_state: null,
  candidates: 0,
  started_at: "2026-10-15T10:00:00Z",
  last_activity_at: "2026-10-15T10:00:05Z",
  slice: 1,
  ...over,
});

function memoryOf(saved: PwmClaim[] = [], decided: string[] = []): PwmMemory {
  return {
    claims: Object.fromEntries(saved.map((claim) => [claim.key, claim])),
    saved,
    decidedKeys: new Set([...saved.map((claim) => claim.key), ...decided]),
  };
}

async function claim(text: string, topic: PwmClaim["topic"] = "career"): Promise<PwmClaim> {
  return {
    key: await pwmClaimKey(text),
    decision: "accepted",
    text,
    topic,
    decided_at: "2026-10-15T10:00:00.000Z",
    basis: "owner_declaration",
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** One live event-stream response whose frames the test sends when it likes. */
class LiveStream {
  controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  response() {
    return new Response(
      new ReadableStream<Uint8Array>({
        start: (controller) => {
          this.controller = controller;
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }
  send(event: string, data: unknown) {
    this.controller!.enqueue(
      new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    );
  }
  close() {
    this.controller!.close();
  }
}

type Call = { method: string; path: string };
/**
 * The network, at the seam every service shares. Profile's own background
 * reads answer "not found"; only the world-model routes are scripted.
 */
function mockNetwork(routes: {
  stream: () => Response | Promise<Response>;
  jobs: () => unknown;
}) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const path = new URL(url, "http://localhost/").pathname;
    calls.push({ method, path });
    if (!path.includes("/world-model/")) return json({}, 404);
    if (method === "POST" && path.endsWith("/world-model/ensure")) return json(pending);
    if (path.endsWith("/world-model/jobs/stream")) return routes.stream();
    if (method === "GET" && path.endsWith("/world-model/jobs")) return json(routes.jobs());
    if (method === "GET" && path.endsWith("/world-model/preferences"))
      return json(preferences);
    return json({}, 404);
  });
  return calls;
}

function activeScreen() {
  return document.querySelector<HTMLElement>('[data-profile-stack-active="true"]')!;
}
const statusRow = () => screen.getByTestId("pwm-status-row");
/** The one live line under the status title. */
const statusLine = () => within(statusRow()).getByRole("status");

/**
 * Records every moment the status row's live line was blank: the owner
 * must never be left wondering what is happening.
 */
function watchForIdle() {
  const blanks: string[] = [];
  const check = () => {
    const line = document.querySelector("[data-testid='pwm-status-row'] [role='status']");
    if (line && (line.textContent ?? "").trim() === "")
      blanks.push(statusRow().textContent ?? "");
  };
  const observer = new MutationObserver(check);
  observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  return { blanks, stop: () => observer.disconnect() };
}

function renderPane() {
  // As in app/providers.tsx: the pane is a sibling of the provider's tree.
  return render(
    <>
      <WorldModelProvider>
        <main />
      </WorldModelProvider>
      <ProfilePage
        presentation="pane"
        paneLocation={{ panel: "world-model", detail: null }}
      />
    </>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  nav.query = "profile_pane=1&profile_panel=world-model";
  window.history.replaceState(null, "", `/one?${nav.query}`);
  vi.spyOn(VaultService, "checkVault").mockResolvedValue(true);
  vi.spyOn(WorldModelDecisionService, "load").mockResolvedValue(memoryOf());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Personal World Model owner journey", () => {
  it("creates a contact-bound invitation without asking for a public source URL", async () => {
    vi.spyOn(WorldModelInvitationsService, "list").mockResolvedValue([]);
    const create = vi.spyOn(WorldModelInvitationsService, "create").mockResolvedValue({
      id: DRAFT_ID,
      token: "a".repeat(43),
      expires_at: "2026-10-23T00:00:00Z",
      url: "https://example.test/world-model/invite#claim=synthetic",
    });
    render(
      <WorldModelInvitations
        ownerId="owner-a"
        vaultKey={vault.vaultKey}
        vaultOwnerToken={vault.vaultOwnerToken}
      />,
    );
    expect(screen.queryByLabelText("Public profile link")).toBeNull();
    fireEvent.change(screen.getByLabelText("Their name"), { target: { value: "Sam Example" } });
    fireEvent.change(screen.getByLabelText("Their email"), { target: { value: "sam@example.test" } });
    fireEvent.change(screen.getByLabelText("Their phone with country code"), {
      target: { value: "+14155550111" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create invitation" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith(
      { vaultKey: vault.vaultKey, vaultOwnerToken: vault.vaultOwnerToken, isCurrent: expect.any(Function), signal: expect.any(AbortSignal) },
      "sam@example.test",
      { subject_name: "Sam Example", secondary_contact: "+14155550111" },
    ));
  });

  it("streams every step while research runs, then lets the owner review the draft", async () => {
    const live = new LiveStream();
    const calls = mockNetwork({ stream: () => live.response(), jobs: () => pending });
    const designer = await claim(DESIGNER);
    const speakerKey = await pwmClaimKey(SPEAKER);
    const confirm = vi
      .spyOn(WorldModelDecisionService, "confirm")
      .mockResolvedValue(memoryOf([designer]));
    const reject = vi
      .spyOn(WorldModelDecisionService, "reject")
      .mockResolvedValue(memoryOf([designer], [speakerKey]));
    const idle = watchForIdle();
    renderPane();

    // Research started on its own; before the first frame the owner is told so.
    const title = await screen.findByText("Preparing your model");
    expect(activeScreen()).toContainElement(title);
    expect(statusLine()).toHaveTextContent("Starting…");
    expect(screen.getByTestId("pwm-progress-row")).toHaveTextContent("Searching public pages");
    // What research looks for is visible, with contacts masked.
    expect(screen.getByTestId("pwm-identity-name")).toHaveTextContent("Alice Example");
    const email = screen.getByTestId("pwm-identity-email");
    expect(email).toHaveTextContent("a•••@example.com");
    expect(email).not.toHaveTextContent("alice.example@");
    const phone = screen.getByTestId("pwm-identity-phone");
    expect(phone).toHaveTextContent("0123");
    expect(phone).not.toHaveTextContent("5550123");
    expect(screen.queryByText("Invite someone")).toBeNull();
    await waitFor(() => expect(live.controller).not.toBeNull());

    act(() => live.send("progress", progress()));
    await waitFor(() =>
      expect(statusLine()).toHaveTextContent("Step 1 of 3 · Checking it’s you"),
    );
    expect(screen.getByTestId("pwm-progress-row")).toHaveTextContent("1 of 32 searches");
    expect(screen.getByTestId("pwm-freshness")).toHaveTextContent("Last activity just now");

    act(() =>
      live.send(
        "progress",
        progress({
          stage: "coverage",
          searches_used: 5,
          model_calls_used: 11,
          topics_checked: ["career", "education"],
          sources_found: 2,
          recent_sources: [team, alumni],
          identity_state: "owner_linked",
          candidates: 1,
        }),
      ),
    );
    await waitFor(() =>
      expect(statusLine()).toHaveTextContent("Step 2 of 3 · Searching public pages"),
    );
    // The topic count sits beside the live line, never inside it.
    expect(statusRow()).toHaveTextContent(
      "Step 2 of 3 · Searching public pages · 2 of 20 topics",
    );
    const counters = screen.getByTestId("pwm-progress-row");
    expect(counters).toHaveTextContent("5 of 32 searches");
    expect(counters).toHaveTextContent("2 sources found · 2 topics checked");
    const sources = screen.getByTestId("pwm-sources-row");
    expect(sources).toHaveTextContent("Acme Corp – Team · Example Uni – Alumni");
    expect(within(sources).queryByRole("link")).toBeNull();

    act(() =>
      live.send(
        "progress",
        progress({
          stage: "report",
          searches_used: 5,
          model_calls_used: 14,
          topics_checked: ["career", "education"],
          sources_found: 2,
          recent_sources: [team, alumni],
          identity_state: "owner_linked",
          candidates: 1,
        }),
      ),
    );
    await waitFor(() =>
      expect(statusLine()).toHaveTextContent("Step 3 of 3 · Writing up what it found"),
    );

    act(() => {
      live.send("result", offered);
      live.close();
    });
    expect(await screen.findByText("Ready to review")).toBeInTheDocument();
    expect(statusLine()).toHaveTextContent("3 details to confirm.");
    expect(screen.queryByTestId("pwm-progress-row")).toBeNull();
    const review = screen.getByText("To review").closest("[data-testid='settings-group']")!;
    for (const statement of [DESIGNER, SPEAKER, STUDIED]) {
      expect(within(review as HTMLElement).getByText(statement)).toBeInTheDocument();
    }
    // Only the statement with doubtful evidence is tagged, and it is never blank.
    const doubtful = screen.getByText(SPEAKER).closest("[data-testid='pwm-fact-row']")!;
    expect(within(doubtful as HTMLElement).getByText("Possible match")).toBeInTheDocument();
    expect(screen.getAllByText("Possible match")).toHaveLength(1);
    expect(doubtful).toHaveTextContent(team.title);
    // The switches were read once the result landed; nothing was ever polled.
    expect(await screen.findByText("Research and email")).toBeInTheDocument();
    expect(calls.filter((call) => call.path.endsWith("/world-model/jobs"))).toEqual([]);
    expect(calls.filter((call) => call.path.endsWith("/world-model/ensure"))).toHaveLength(1);
    expect(calls.filter((call) => call.path.endsWith("/jobs/stream"))).toHaveLength(1);

    // Yes: shown as confirmed only after the encrypted write resolves.
    fireEvent.click(screen.getByRole("button", { name: `Yes, this is right: ${DESIGNER}` }));
    await waitFor(() => expect(screen.getByText(DESIGNER).closest("[data-testid='pwm-fact-row']")).toHaveTextContent("Confirmed by you"));
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "owner-a",
        vaultKey: vault.vaultKey,
        statement: DESIGNER,
        topic: "career",
      }),
    );
    const confirmed = screen.getByText(DESIGNER).closest("[data-testid='pwm-fact-row']")!;
    expect(within(confirmed as HTMLElement).getByText("Confirmed by you")).toBeInTheDocument();
    expect(
      within(confirmed as HTMLElement).queryByRole("button", { name: /Yes, this is right/ }),
    ).toBeNull();
    expect(statusLine()).toHaveTextContent("2 details to confirm.");
    // A saved detail makes the model worth sharing.
    expect(screen.getByText("Invite someone")).toBeInTheDocument();

    // No: the statement leaves the list and nothing opposite is saved.
    fireEvent.click(screen.getByRole("button", { name: `No, this isn’t right: ${SPEAKER}` }));
    await waitFor(() => expect(screen.queryByText(SPEAKER)).toBeNull());
    expect(reject).toHaveBeenCalledWith(
      expect.objectContaining({ statement: SPEAKER, topic: "career" }),
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(statusLine()).toHaveTextContent("1 detail to confirm.");
    expect(screen.getByText(STUDIED)).toBeInTheDocument();

    idle.stop();
    expect(idle.blanks).toEqual([]);
  }, 20_000);

  it("falls back to polling after two failed streams and still shows live progress", async () => {
    let streams = 0;
    let reads = 0;
    const calls = mockNetwork({
      stream: () => {
        streams += 1;
        throw new TypeError("connection lost");
      },
      jobs: () => {
        reads += 1;
        return {
          ...pending,
          progress: progress({
            stage: "coverage",
            searches_used: reads,
            topics_checked: ["career"],
            sources_found: 1,
            recent_sources: [team],
            identity_state: "owner_linked",
            candidates: 1,
          }),
        };
      },
    });
    const idle = watchForIdle();
    renderPane();

    await screen.findByText("Preparing your model");
    // A dropped feed says so instead of going quiet.
    await waitFor(() => expect(statusLine()).toHaveTextContent("Reconnecting…"));
    expect(screen.getByTestId("pwm-freshness")).toHaveTextContent(
      "Couldn’t get an update. Retrying…",
    );
    // The plain read that follows a failed stream carries progress.
    await waitFor(
      () => expect(screen.getByTestId("pwm-progress-row")).toHaveTextContent("1 of 32 searches"),
      { timeout: 4_000 },
    );
    expect(statusLine()).toHaveTextContent("Step 2 of 3 · Searching public pages");
    expect(statusRow()).toHaveTextContent("Step 2 of 3 · Searching public pages · 1 of 20 topics");
    expect(screen.getByTestId("pwm-sources-row")).toHaveTextContent(team.title);
    // The second failed stream keeps the counters, and the next read moves them.
    await waitFor(
      () => expect(screen.getByTestId("pwm-progress-row")).toHaveTextContent("2 of 32 searches"),
      { timeout: 4_000 },
    );
    expect(streams).toBe(2);
    expect(statusLine()).toHaveTextContent("Step 2 of 3 · Searching public pages");
    expect(statusRow()).toHaveTextContent("Step 2 of 3 · Searching public pages · 1 of 20 topics");
    expect(screen.getByTestId("pwm-freshness")).toHaveTextContent("Last activity just now");
    expect(calls.filter((call) => call.path.endsWith("/world-model/ensure"))).toHaveLength(1);
    expect(
      calls.filter((call) => call.method === "GET" && call.path.endsWith("/world-model/jobs")),
    ).toHaveLength(reads);
    expect(reads).toBeGreaterThanOrEqual(2);

    idle.stop();
    expect(idle.blanks).toEqual([]);
  }, 20_000);
});
