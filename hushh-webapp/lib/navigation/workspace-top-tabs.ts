export type WorkspaceTopTab = {
  id: string;
  label: string;
  href: string;
};

export type WorkspaceTopTabSet = {
  label: "Finance" | "Advisor";
  tabs: readonly WorkspaceTopTab[];
  activeId: string;
};

export function resolveWorkspaceTopTabs(
  _pathname: string | null | undefined,
): WorkspaceTopTabSet | null {
  return null;
}
