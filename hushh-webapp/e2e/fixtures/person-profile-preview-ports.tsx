import { AppPageShell } from "@/components/app-ui/app-page-shell";
import { PersonProfileHero } from "@/components/connections/person-profile-hero";
import { useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
export { useAuth } from "./person-profile-request-ports";
export const usePathname = () => window.location.pathname;
export const useSearchParams = () => new URLSearchParams(window.location.search);
export const ConnectionsService = { getPersonContext: async () => ({ person: { publicPersonRef: "11111111-1111-4111-8111-111111111111" } }) };

/** Synthetic read boundary; the browser mounts the production preview, hero and row controls. */
export function PersonProfilePage() {
  const [review, setReview] = useState(false);
  return <AppPageShell width="agent" fitContent><PersonProfileHero
    profile={{ personRef: "11111111-1111-4111-8111-111111111111", displayName: "Aarav Sharma", photoUrl: null, verifiedRole: null }}
    status={<span>Connected</span>} contacts={<span>Profile details</span>} primaryActions={<button type="button" onClick={() => setReview(true)}>Request information</button>} tasks={null} footer={null}
  /><Dialog modal open={review} onOpenChange={setReview}><DialogContent><DialogTitle>Review information request</DialogTitle><button type="button" onClick={() => setReview(false)}>Cancel request</button></DialogContent></Dialog></AppPageShell>;
}
