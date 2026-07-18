import { redirect } from "next/navigation";

import { PublicKnowledgeWorkspace } from "@/components/app-ui/public-knowledge-workspace";
import { ROUTES } from "@/lib/navigation/routes";

const PUBLIC_KNOWLEDGE_TABS = new Set(["research", "blog", "developers"]);

/**
 * Public knowledge is intentionally separate from `/`: root remains the
 * anonymous onboarding entry, while this route owns the tabbed workspace.
 */
export default async function WelcomePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const { tab } = await searchParams;
  const value = Array.isArray(tab) ? tab[0] : tab;

  if (!value || !PUBLIC_KNOWLEDGE_TABS.has(value)) {
    redirect(ROUTES.HOME);
  }

  return <PublicKnowledgeWorkspace />;
}
