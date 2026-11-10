import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SettingsPresentationProvider } from "../../components/app-ui/settings-ui";
import { CommunicationPreferencesGroup } from "../../components/profile/communication-preferences-group";
import type { OwnerStyleSettings } from "../../lib/agent/owner-style-settings";

/**
 * Profile > Preferences > "How One writes to you", from the production group,
 * inside the profile stack's own wrapper and presentation. Synthetic values;
 * nothing here reads or writes a vault. `?state=suggested` shows a chat offer.
 */
const params = new URLSearchParams(window.location.search);
const suggested = params.get("state") === "suggested";
const inPane = params.get("pane") === "true";

function Fixture() {
  const [value, setValue] = useState<OwnerStyleSettings>({
    preferred_name: "Kay",
    tone: "executive",
    length: "short",
    language: "en",
    avoid_em_dashes: true,
    owner_style_note: "Write Hussh with two s's, and lead with numbers when there are any.",
  });
  return (
    <div className={inPane ? "profile-pane-sheet" : undefined} data-slot={inPane ? "sheet-content" : undefined} data-app-side-pane={inPane ? "" : undefined}>
      <div className={inPane ? "profile-pane-scroll-root" : undefined}>
        <main className={`app-page-shell min-h-dvh bg-background py-4 text-foreground${inPane ? " profile-pane-page profile-pane-page--inner" : ""}`} data-app-density="compact" data-app-surface="one">
          {/* In the pane, the stack screen opts into the Connect scale exactly as ProfileStackNavigator does. */}
          <div
            className="mx-auto flex w-full max-w-[720px] flex-col px-[var(--page-inline-gutter-standard)]"
            data-profile-stack-screen={inPane ? "panel:preferences" : undefined}
          >
            <div
              className="contents"
              data-profile-stack-content={inPane ? "true" : undefined}
              data-connect-type-scale={inPane ? "profile" : undefined}
            >
              <SettingsPresentationProvider separatorInset density="compact">
                <CommunicationPreferencesGroup
                  value={value}
                  onChange={setValue}
                  onSave={() => undefined}
                  dirty={suggested}
                  saving={false}
                  suggested={suggested}
                />
              </SettingsPresentationProvider>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
