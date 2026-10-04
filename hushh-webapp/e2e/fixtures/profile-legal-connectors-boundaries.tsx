// Synthetic boundaries for the Profile pane Legal + Connectors harness. The
// production ProfilePane (sheet, header, Back, close, URL state), the legal
// reader, the Legal and Connectors stack entries and the pane navigation
// helpers are real; only routing, the vault gate and the heavy Profile
// workspace are stood in for.
import { useSyncExternalStore } from "react";

import { ProfileStackNavigator } from "@/components/profile/profile-stack-navigator";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { SettingsPresentationProvider } from "@/components/app-ui/settings-ui";
import {
  buildProfileLegalStackEntries,
  ProfileLegalRows,
} from "@/components/profile/profile-legal-section";
import { buildProfileConnectorsStackEntry } from "@/components/profile/profile-connectors-section";
import type { ProfileStackEntry } from "@/components/profile/profile-stack-navigator";
import {
  pushProfilePaneLocation,
  replaceProfilePaneLocation,
  type ProfilePaneLocation,
} from "@/lib/navigation/profile-pane";
import type {
  ProfileDetail,
  ProfilePanel,
} from "@/lib/navigation/profile-routes";

export * from "./connections-boundaries";

function subscribe(listener: () => void) {
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
}

function useLocationKey() {
  return useSyncExternalStore(
    subscribe,
    () => `${window.location.pathname}${window.location.search}`,
    () => "/",
  );
}

export function usePathname() {
  useLocationKey();
  return window.location.pathname;
}

export function useSearchParams() {
  const key = useLocationKey();
  return new URLSearchParams(key.includes("?") ? key.split("?")[1] : "");
}

export function useRouter() {
  const go = (method: "pushState" | "replaceState") => (href: string) => {
    window.history[method]({}, "", href);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };
  return { push: go("pushState"), replace: go("replaceState"), back: () => window.history.back() };
}

export function useVault() {
  return { vaultOwnerToken: "synthetic-owner", isVaultUnlocked: true };
}

/**
 * Stand-in for the Profile workspace in pane presentation: the same root
 * Legal group (the real rows), a Connectors row, and the real stack entries,
 * moving through the real pane history helpers exactly as
 * ProfilePageContent's updateProfileView does.
 */
export function ProfilePage({ paneLocation }: { paneLocation?: ProfilePaneLocation }) {
  const search = useSearchParams();
  const location = paneLocation ?? { panel: null, detail: null };
  const updateView = (
    next: { panel?: ProfilePanel | null; detail?: ProfileDetail | null },
    mode: "push" | "replace" = "push",
  ) => {
    const target = {
      panel: next.panel === undefined ? location.panel : next.panel,
      detail: next.detail === undefined ? location.detail : next.detail,
    };
    if (mode === "push") pushProfilePaneLocation(window.location.pathname, search, target);
    else replaceProfilePaneLocation(window.location.pathname, search, target);
  };
  const entries: ProfileStackEntry[] = [];
  if (location.panel === "legal") {
    entries.push(...buildProfileLegalStackEntries({ detail: location.detail, updateView }));
  } else if (location.panel === "connectors") {
    entries.push(buildProfileConnectorsStackEntry({ detail: location.detail, updateView }));
  }
  return (
    <SettingsPresentationProvider density="compact">
      <ProfileStackNavigator
        resetScroll={false}
        entries={entries}
        rootContent={
          <div className="flex flex-col gap-6 px-[var(--page-inline-gutter-standard)] pt-6">
            <SettingsGroup title="Your settings" separatorInset>
              <SettingsRow
                title="Connectors"
                chevron
                testId="profile-connectors-row"
                onClick={() => updateView({ panel: "connectors", detail: null }, "push")}
              />
            </SettingsGroup>
            <SettingsGroup title="Legal" separatorInset>
              <ProfileLegalRows
                onOpen={(document) => updateView({ panel: "legal", detail: document }, "push")}
              />
            </SettingsGroup>
          </div>
        }
      />
    </SettingsPresentationProvider>
  );
}
