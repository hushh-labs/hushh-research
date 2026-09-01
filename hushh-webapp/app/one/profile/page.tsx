import ProfileWorkspacePage from "@/app/profile/profile-workspace-page";
import { requireLocalCrmRoute } from "@/lib/connected-systems/local-crm-route-guard";

type ProfilePageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ProfilePage({ searchParams }: ProfilePageProps) {
  const query = (await searchParams) ?? {};
  const requestedPanel = String(query.panel ?? query.tab ?? "")
    .trim()
    .toLowerCase();
  if (requestedPanel === "connected-systems" || requestedPanel === "systems") {
    await requireLocalCrmRoute();
  }
  return <ProfileWorkspacePage />;
}
