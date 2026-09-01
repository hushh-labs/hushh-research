import ProfileWorkspacePage from "@/app/profile/profile-workspace-page";
import { requireLocalCrmRoute } from "@/lib/connected-systems/local-crm-route-guard";

type ProfilePageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ProfilePage({ searchParams }: ProfilePageProps) {
  // Search parameters are request state on web but browser state in the
  // serverless Capacitor bundle. Native availability is enforced again by the
  // client workspace, so the exporter must not await a request-only value.
  if (process.env.CAPACITOR_BUILD !== "true") {
    const query = (await searchParams) ?? {};
    const requestedPanel = String(query.panel ?? query.tab ?? "")
      .trim()
      .toLowerCase();
    if (requestedPanel === "connected-systems" || requestedPanel === "systems") {
      await requireLocalCrmRoute();
    }
  }
  return <ProfileWorkspacePage />;
}
