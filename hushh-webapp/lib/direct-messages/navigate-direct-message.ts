import {
  isValidatedAuthSessionOwnerCurrent,
  snapshotValidatedAuthSessionOwner,
} from "@/lib/auth/session-owner";
import { DirectMessagesService } from "@/lib/services/direct-messages-service";
import { DirectMessagesResourceService } from "@/lib/services/direct-messages-resource-service";
import { morphyToast } from "@/lib/morphy-ux/morphy";

type Selection = { conversationId?: string | null; personRef?: string | null };

/** Mint before navigation so business identifiers never enter browser history. */
export async function resolveDirectMessageHref(selection: Selection): Promise<string | null> {
  const owner = snapshotValidatedAuthSessionOwner();
  if (!owner) throw new Error("Sign in required");
  const session = DirectMessagesResourceService.beginRequest(owner.userId);
  const { AuthService } = await import("@/lib/services/auth-service");
  // Native auth can be restored before Firebase JS has a currentUser. Reuse
  // the bounded platform-aware lookup and reject another account's token.
  const idToken = await AuthService.getIdTokenWithRetry({ expectedUserId: owner.userId });
  if (!isValidatedAuthSessionOwnerCurrent(owner)) return null;
  if (!idToken) throw new Error("Sign in required");
  const route = await DirectMessagesService.routeSelection({
    idToken,
    ...(selection.conversationId
      ? { conversationId: selection.conversationId }
      : { personRef: selection.personRef || "" }),
  });
  if (!isValidatedAuthSessionOwnerCurrent(owner)) return null;
  // The mint already verified this selection. Keep that mapping in memory so
  // navigation does not resolve the same token again before showing the chat.
  DirectMessagesResourceService.writeRoute(owner.userId, session, route);
  return `/one/messages?token=${encodeURIComponent(route.token)}`;
}

export async function navigateDirectMessage(
  router: { push: (href: string) => void },
  selection: Selection,
): Promise<void> {
  try {
    const href = await resolveDirectMessageHref(selection);
    if (href) router.push(href);
  } catch {
    morphyToast.error("This conversation could not be opened. Try again.");
  }
}
