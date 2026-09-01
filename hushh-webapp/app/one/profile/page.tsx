import ProfileWorkspacePage from "@/app/profile/profile-workspace-page";
import { requireLocalCrmRoute } from "@/lib/connected-systems/local-crm-route-guard";

type ProfilePageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ProfilePage({ searchParams }: ProfilePageProps) {
  // Static Capacitor exports have no request query. The profile workspace reads
  // its query client-side after the app starts, while server builds retain the
  // local-only CRM route guard below.
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
