import { DirectMessagesService } from "@/lib/services/direct-messages-service";
import { morphyToast } from "@/lib/morphy-ux/morphy";

type Selection = { conversationId?: string | null; personRef?: string | null };

/** Mint before navigation so business identifiers never enter browser history. */
export async function resolveDirectMessageHref(selection: Selection): Promise<string | null> {
  const { auth } = await import("@/lib/firebase/config");
  const user = auth.currentUser;
  if (!user) throw new Error("Sign in required");
  const href = await DirectMessagesService.routeHref({
    idToken: await user.getIdToken(),
    ...(selection.conversationId
      ? { conversationId: selection.conversationId }
      : { personRef: selection.personRef || "" }),
  });
  return auth.currentUser?.uid === user.uid ? href : null;
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
