"use client";

import { useSearchParams } from "next/navigation";

import { RiaClientWorkspace } from "@/components/ria/ria-client-workspace";

type WorkspaceTab = "overview" | "access" | "kai" | "explorer";

const WORKSPACE_TABS = new Set<WorkspaceTab>(["overview", "access", "kai", "explorer"]);

export default function RiaClientWorkspacePageClient({
  clientId,
}: {
  clientId: string;
}) {
  const searchParams = useSearchParams();
  const initialTabParam = (searchParams.get("tab") || "").trim();
  const initialTab = WORKSPACE_TABS.has(initialTabParam as WorkspaceTab)
    ? (initialTabParam as WorkspaceTab)
    : "overview";
  const forceTestProfile = (searchParams.get("test_profile") || "").trim() === "1";

  return (
    <RiaClientWorkspace
      clientId={clientId}
      forceTestProfile={forceTestProfile}
      initialTab={initialTab}
    />
  );
}
