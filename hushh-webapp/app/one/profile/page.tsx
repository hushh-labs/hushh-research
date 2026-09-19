import { redirect } from "next/navigation";

type ProfilePageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ProfilePage({ searchParams }: ProfilePageProps) {
  const query = (await searchParams) ?? {};
  const params = new URLSearchParams();
  params.set("profile_pane", "1");
  const panel = String(
    query.panel ?? query.tab ?? query.profile_panel ?? "",
  ).trim();
  if (panel) {
    params.set("profile_panel", panel);
  }
  const detail = String(query.detail ?? query.profile_detail ?? "").trim();
  if (detail) {
    params.set("profile_detail", detail);
  }
  redirect(`/one?${params.toString()}`);
}
