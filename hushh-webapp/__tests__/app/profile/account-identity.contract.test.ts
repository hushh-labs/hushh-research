import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const profilePageSource = readFileSync(
  join(process.cwd(), "components/profile/profile-workspace-page.tsx"),
  "utf8",
);
const editorSource = readFileSync(
  join(process.cwd(), "components/profile/display-name-editor.tsx"),
  "utf8",
);
const providersSource = readFileSync(join(process.cwd(), "app/providers.tsx"), "utf8");

describe("Profile account identity contract", () => {
  it("mounts the existing DisplayNameEditor in the Account name row (typed correction / manual fallback)", () => {
    // Graph observation 1: the editor existed but the Account row was read-only.
    expect(profilePageSource).toContain(
      'import { DisplayNameEditor } from "@/components/profile/display-name-editor";',
    );
    expect(profilePageSource).toContain('data-testid="profile-account-display-name-editor"');
    expect(profilePageSource).toContain("onClick={() => setEditingDisplayName((open) => !open)}");
    expect(profilePageSource).toContain("onSaved={() => setEditingDisplayName(false)}");
    // Still one editor: no second name form was invented.
    expect(profilePageSource.match(/<DisplayNameEditor\b/g)?.length).toBe(1);
  });

  it("the editor accepts a committed-but-syncing voice result, not only a synced one", () => {
    expect(editorSource).toContain('result.status !== "updated" && result.status !== "committed_sync_pending"');
  });

  it("refreshes identity from any screen after a spoken name change, without the editor mounted", () => {
    expect(providersSource).toContain("<ProfileIdentityVoiceRefresh />");
    // Mounted beside the session-scoped handlers, inside AuthProvider.
    const auth = providersSource.indexOf("<AuthProvider>");
    const global = providersSource.indexOf("<GlobalVoiceActionHandlers />");
    const refresh = providersSource.indexOf("<ProfileIdentityVoiceRefresh />");
    expect(auth).toBeGreaterThan(-1);
    expect(global).toBeGreaterThan(auth);
    expect(refresh).toBeGreaterThan(global);
  });
});
