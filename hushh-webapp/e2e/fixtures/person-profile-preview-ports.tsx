import { AppPageShell } from "@/components/app-ui/app-page-shell";
import { PersonProfileHero } from "@/components/connections/person-profile-hero";
import { useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { PersonNetworkSummary } from "@/components/connections/person-network-summary";
import { dispatchConnectionGraphChanged } from "@/lib/connections/connection-graph-events";
export { useAuth } from "./person-profile-request-ports";
export const usePathname = () => window.location.pathname;
export const useSearchParams = () => new URLSearchParams(window.location.search);
const PEOPLE = [
  { publicPersonRef: "11111111-1111-4111-8111-111111111111", displayName: "Aarav Sharma", photoUrl: null, networkDegree: 1 },
  { publicPersonRef: "22222222-2222-4222-8222-222222222222", displayName: "Maya Singh", photoUrl: null, networkDegree: 1 },
  { publicPersonRef: "33333333-3333-4333-8333-333333333333", displayName: "Morgan Lee", photoUrl: null, networkDegree: 1 },
  { publicPersonRef: "44444444-4444-4444-8444-444444444444", displayName: "Second Degree Person", photoUrl: null, networkDegree: 2 },
  { publicPersonRef: "55555555-5555-4555-8555-555555555555", displayName: "Third Degree Person", photoUrl: null, networkDegree: 3 },
];
const SUGGESTED = { publicPersonRef: "66666666-6666-4666-8666-666666666666", displayName: "Priya Anand", photoUrl: null, networkDegree: null };
const findPerson = (personRef: string) => [...PEOPLE, SUGGESTED].find(person => person.publicPersonRef === personRef);
export class ConnectionsServiceRequestError extends Error { status = 500; }
const requests = new Set<string>();
const sharedConnections = (personRef: string) =>
  PEOPLE.filter(person => person.publicPersonRef !== personRef && person.networkDegree <= 2);
function rowMetadata(person: typeof PEOPLE[number]) {
  const previews = person.networkDegree === 3 ? [] : person.networkDegree === 2 ? [PEOPLE[1]] : PEOPLE.filter(p => p.networkDegree === 1 && p !== person).slice(0, 2);
  return { ...person, relationship: person.networkDegree === 1 ? "connected" : requests.has(person.publicPersonRef) ? "pending_outgoing" : "none", mutualConnectionCount: previews.length,
    mutualConnectionPreviews: previews, mutualConnectionPreview: previews[0] ?? null };
}
export const PersonProfileService = { connect: async (ref: string) => { requests.add(ref); return { status: "pending_outgoing" }; } };
export const CacheSyncService = { onConnectionGraphMutated(userId: string) { dispatchConnectionGraphChanged(userId); } };
export const ConnectionsService = {
  getPersonContext: async ({ counterpartUserId: userId }: { counterpartUserId: string }) => {
    const person = userId === "peer" ? PEOPLE[0] : userId === "second-peer" ? PEOPLE[1] : null;
    if (!person) throw new Error("Unknown profile");
    return { person: { ...person, userId, email: null, relationship: "connected" }, request: null };
  },
  getNetworkSummary: async ({ personRef }: { personRef: string }) => {
    const person = findPerson(personRef) ?? PEOPLE[0];
    const mutuals = person.networkDegree ? PEOPLE.filter(p => p.networkDegree === 1 && p !== person) : [];
    return { person, networkDegree: person.networkDegree, mutualConnectionCount: person.networkDegree === 3 ? 0 : person.networkDegree === 2 ? 1 : mutuals.length,
      mutualConnectionPreview: person.networkDegree === 2 ? PEOPLE[1] : mutuals[0], canBrowseConnections: person.networkDegree === 1,
      visibleConnectionCount: person.networkDegree === 1 ? sharedConnections(personRef).length : null };
  },
  listMutualConnections: async ({ personRef }: { personRef: string }) => ({
    person: PEOPLE.find(p => p.publicPersonRef === personRef),
    items: PEOPLE.filter(p => p.networkDegree === 1 && p.publicPersonRef !== personRef).map(rowMetadata),
    totalCount: 2, page: 1, hasMore: false,
  }),
  listNetwork: async ({ personRef, degree, query, includeSuggestions }: { personRef?: string; degree?: number; query?: string; includeSuggestions?: boolean }) => ({
    person: personRef ? PEOPLE.find(p => p.publicPersonRef === personRef) : null,
    items: !personRef && new URLSearchParams(window.location.search).has("newNetwork") ? []
      : (personRef ? sharedConnections(personRef) : PEOPLE)
        .filter(p => (!degree || p.networkDegree === degree) && (!query || p.displayName.toLowerCase().includes(query.toLowerCase())))
        .map(rowMetadata),
    suggestions: includeSuggestions && (!query || SUGGESTED.displayName.toLowerCase().includes(query.trim().toLowerCase()))
      ? [{ ...SUGGESTED, suggestionReason: query ? "name_match" : "verified_advisor", relationship: requests.has(SUGGESTED.publicPersonRef) ? "pending_outgoing" : "none" }]
      : [],
    page: 1, hasMore: false,
  }),
};

/** Synthetic read boundary; the browser mounts the production preview, hero and row controls. */
export function PersonProfilePage({ personRef = PEOPLE[0].publicPersonRef, onNetworkReady }: { personRef?: string; onNetworkReady?: () => void }) {
  const [review, setReview] = useState(false);
  const person = findPerson(personRef) ?? PEOPLE[0];
  return <AppPageShell width="agent" fitContent><PersonProfileHero
    profile={{ ...person, verifiedRole: person === PEOPLE[0] ? "Registered investment adviser" : null }}
    status={<span>Connected</span>} contacts={<a href="mailto:profile@example.com">profile@example.com</a>}
    network={<PersonNetworkSummary personRef={personRef} onReady={onNetworkReady} />}
    primaryActions={<button type="button" onClick={() => setReview(true)}>Request information</button>} tasks={null} footer={null}
  /><Dialog modal open={review} onOpenChange={setReview}><DialogContent><DialogTitle>Review information request</DialogTitle><button type="button" onClick={() => setReview(false)}>Cancel request</button></DialogContent></Dialog></AppPageShell>;
}
