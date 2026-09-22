import { ROUTES } from "@/lib/navigation/routes";

/**
 * Location tasks whose own terminal action occupies the bottom interaction
 * edge. Persistent app chrome must leave that edge entirely: keeping the
 * Agent Bar or tab bar mounted lets their fixed layer cover Continue/Send on
 * compact and native-iOS viewports.
 */
export type FocusedLocationBottomTask = "ask" | "share" | "sos";

export function isFocusedLocationBottomTask(
  pathname: string,
  action: string | null | undefined,
): action is FocusedLocationBottomTask {
  return (
    pathname === ROUTES.ONE_LOCATION &&
    (action === "ask" || action === "share" || action === "sos")
  );
}
