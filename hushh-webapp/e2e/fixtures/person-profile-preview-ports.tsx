import { AppPageShell } from "@/components/app-ui/app-page-shell";
import { PersonProfileHero } from "@/components/connections/person-profile-hero";
import { useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { PersonNetworkSummary } from "@/components/connections/person-network-summary";
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
export class ConnectionsServiceRequestError extends Error { status = 500; }
export const ConnectionsService = {
  getPersonContext: async () => ({ person: PEOPLE[0] }),
  getNetworkSummary: async ({ personRef }: { personRef: string }) => {
    const person = PEOPLE.find(p => p.publicPersonRef === personRef) ?? PEOPLE[0];
    const mutuals = PEOPLE.filter(p => p.networkDegree === 1 && p !== person);
    return { person, networkDegree: person.networkDegree, mutualConnectionCount: person.networkDegree === 3 ? 0 : person.networkDegree === 2 ? 1 : mutuals.length,
      mutualConnectionPreview: person.networkDegree === 2 ? PEOPLE[1] : mutuals[0], canBrowseConnections: person.networkDegree === 1 };
  },
  listMutualConnections: async ({ personRef }: { personRef: string }) => ({
    person: PEOPLE.find(p => p.publicPersonRef === personRef),
    items: PEOPLE.filter(p => p.networkDegree === 1 && p.publicPersonRef !== personRef),
    totalCount: 2, page: 1, hasMore: false,
  }),
  listNetwork: async ({ personRef, degree, query }: { personRef?: string; degree?: number; query?: string }) => ({
    person: personRef ? PEOPLE.find(p => p.publicPersonRef === personRef) : null,
    items: PEOPLE.filter(p => (!personRef || p.networkDegree === 2) && (!degree || p.networkDegree === degree) && (!query || p.displayName.toLowerCase().includes(query.toLowerCase()))),
    page: 1, hasMore: false,
  }),
};

/** Synthetic read boundary; the browser mounts the production preview, hero and row controls. */
export function PersonProfilePage({ personRef = PEOPLE[0].publicPersonRef, onNetworkReady }: { personRef?: string; onNetworkReady?: () => void }) {
  const [review, setReview] = useState(false);
  const person = PEOPLE.find(p => p.publicPersonRef === personRef) ?? PEOPLE[0];
  return <AppPageShell width="agent" fitContent><PersonProfileHero
    profile={{ ...person, verifiedRole: null }}
    status={<span>Connected</span>} contacts={<span>Profile details</span>} primaryActions={<button type="button" onClick={() => setReview(true)}>Request information</button>} tasks={null} footer={null}
  /><PersonNetworkSummary personRef={personRef} onReady={onNetworkReady} /><Dialog modal open={review} onOpenChange={setReview}><DialogContent><DialogTitle>Review information request</DialogTitle><button type="button" onClick={() => setReview(false)}>Cancel request</button></DialogContent></Dialog></AppPageShell>;
}
