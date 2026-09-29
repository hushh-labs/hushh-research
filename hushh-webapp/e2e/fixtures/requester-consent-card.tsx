import { createRoot } from "react-dom/client";
import { AgentStructuredExperienceView } from "../../components/agent/agent-structured-experience";
import { ConsentCardPhaseContext, type RequesterCardPhase } from "../../components/agent/consent/requester-consent-card";
import { SharedDetailsList } from "../../components/agent/consent/shared-details";
import type { InformationRequestReviewExperience, ScopeDiscoveryExperience } from "../../lib/agent/agui-structured-experiences";

const PERSON = "1234567890abcdef";

/** One card per state; the spec answers `/api/one/information-requests/{id}` for each. */
const STATES: Array<{ state: string; bundleId: string; phase: RequesterCardPhase | null }> = [
  { state: "waiting", bundleId: "bundle_waiting01", phase: null },
  { state: "reading", bundleId: "bundle_reading01", phase: "reading" },
  { state: "answered", bundleId: "bundle_answered1", phase: "answered" },
  { state: "partial", bundleId: "bundle_partial01", phase: null },
  { state: "declined", bundleId: "bundle_declined1", phase: "answered" },
  { state: "access-ended", bundleId: "bundle_revoked01", phase: null },
  { state: "no-progress", bundleId: "bundle_legacy001", phase: null },
];

function review(bundleId: string): InformationRequestReviewExperience {
  return {
    type: "one.information_request_review.v1", personName: "Kushal Trivedi",
    purpose: "Picking a place for our dinner together", durationLabel: "7 days",
    direction: "outgoing", phase: "submitted", subjectRef: PERSON, bundleId, requestId: null, status: "pending",
    fields: [{ label: "Food preferences", domain: "Lifestyle", sensitivity: "standard", requestId: `${bundleId}_r1` }],
  };
}

const discovery: ScopeDiscoveryExperience = {
  type: "one.scope_discovery.v1",
  person: { personRef: PERSON, displayName: "Kushal Trivedi", profilePath: `/people/${PERSON}`, relationship: "connected" },
  domainFilter: null, scopes: [],
  proposal: {
    proposed: [{ scopeRef: "scope-food", label: "Food preferences", why: "You asked where to take Kushal for dinner." }],
    durationHours: 168, reasonSuggestion: "To plan dinner together",
  },
};

/**
 * "Request all of Kushal's food and dining information" (localhost run 4, A2):
 * the broad item and one it covers, neither on the viewer's first catalog
 * page, so the card finds their place by searching.
 */
const broadAsk: ScopeDiscoveryExperience = {
  ...discovery,
  proposal: {
    proposed: [
      { scopeRef: "scope-food-all", label: "Food & dining information", why: "Matches what you asked for" },
      { scopeRef: "scope-food-prefs", label: "Food preferences", why: null },
    ],
    durationHours: 168, reasonSuggestion: "To view food and dining details",
  },
};

const SHARED = {
  preferences: { entities: {
    food_preferences: { kind: "preference", status: "active",
      summary: "My favorite cuisine is Neapolitan pizza and I prefer vegetarian toppings.",
      observations: ["My favorite cuisine is Neapolitan pizza and I prefer vegetarian toppings."] },
    mem_65725402299c: { kind: "preference", status: "active", summary: "Favorite restaurant is Nopa in San Francisco." },
    dining_notes: { summary: "Prefers a quiet table away from the kitchen, books ahead on weekends, and is happy to share small plates. Likes places with a good natural wine list and a vegetarian tasting menu when it is on offer." },
    _entities: [{ kind: "preference", observations: { _items: ["Books ahead on weekends."] }, observation_count: 1 }],
  } },
  // The owner's export envelope (lib/consent/export-builder.ts): never shown.
  __export_metadata: {
    scope: "attr.food.preferences.*", source_domain: "food", manifest_version: 2,
    approved_paths: ["preferences.entities._entities.kind", "preferences.entities._entities.observations._items"],
    approved_segment_ids: ["preferences"], export_timestamp: "2026-09-29T00:21:40.000Z",
  },
};

const phases = new Map(STATES.map((entry) => [entry.bundleId, entry.phase]));

function Fixture() {
  return (
    <main className="min-h-dvh bg-background px-4 py-6 text-foreground">
      <div className="mx-auto flex max-w-3xl flex-col gap-8">
        <section data-state="ask" aria-label="ask"><AgentStructuredExperienceView experience={discovery} /></section>
        <section data-state="broad-ask" aria-label="broad-ask"><AgentStructuredExperienceView experience={broadAsk} /></section>
        <ConsentCardPhaseContext.Provider value={(id) => phases.get(id) ?? null}>
          {STATES.map(({ state, bundleId }) => (
            <section key={state} data-state={state} aria-label={state}>
              <AgentStructuredExperienceView experience={review(bundleId)} />
            </section>
          ))}
        </ConsentCardPhaseContext.Provider>
        <section data-state="shared-details" aria-label="shared-details">
          <SharedDetailsList values={[{ requestId: "r1", label: "Food preferences", data: SHARED }]} />
        </section>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
