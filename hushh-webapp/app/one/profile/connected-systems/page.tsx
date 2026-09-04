import ProfileWorkspacePage from "@/app/profile/profile-workspace-page";
import { requireLocalCrmRoute } from "@/lib/connected-systems/local-crm-route-guard";

export default async function LocalCrmProfilePage() {
  await requireLocalCrmRoute();
  return <ProfileWorkspacePage />;
}
