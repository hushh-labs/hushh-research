"use client";

/**
 * Keeps the signed-in person's identity fresh after a server-owned voice
 * change, from any screen.
 *
 * The `update_display_name` tool commits at Firebase and re-syncs the shadow
 * on the server; nothing here writes. It only refreshes the two places the
 * app reads identity from -- the UID-keyed identity cache and the Firebase
 * user object -- so the header, Account and avatars agree without the name
 * editor having been mounted. Mounted once, next to GlobalVoiceActionHandlers.
 *
 * The relay mirrors a confirmed action as both `tool.result` and
 * `pending_action.resolved`; the deduper collapses that pair into one refresh.
 */

import { useRef } from "react";

import { useAuth } from "@/hooks/use-auth";
import { VoiceRefreshDeduper } from "@/lib/one-voice/people-voice-refresh";
import { isOwnIdentityChange } from "@/lib/one-voice/profile-voice-refresh";
import type { ToolResultPublic } from "@/lib/one-voice/protocol";
import { useVoiceToolEffects } from "@/lib/one-voice/session-store";
import { AccountIdentityService } from "@/lib/services/account-identity-service";

export function ProfileIdentityVoiceRefresh() {
  const { user } = useAuth();
  const dedupeRef = useRef(new VoiceRefreshDeduper());

  const refresh = (tool: string | null, result: ToolResultPublic | null | undefined) => {
    if (!user?.uid) return;
    if (!isOwnIdentityChange(tool, result)) return;
    if (!dedupeRef.current.shouldRefresh(result)) return;
    AccountIdentityService.invalidateCachedIdentity(user.uid);
    void AccountIdentityService.refreshCurrentUserIdentity(user, { force: true }).catch(
      () => undefined,
    );
    void user.reload().catch(() => undefined);
  };

  useVoiceToolEffects({
    onToolResult: (tool, result) => refresh(tool, result),
    onPendingResolved: (_id, status, result) => {
      if (status !== "executed") return;
      refresh(null, result);
    },
  });

  return null;
}
