import { ROUTES } from "@/lib/navigation/routes";
import { requestInternalAppNavigation } from "@/lib/utils/browser-navigation";

/**
 * Move an existing chat handoff into the canonical route-level workspace.
 * Handoff payloads stay in the in-memory conversation session; the URL carries
 * only the destination and never private information.
 */
export function navigateToAgentChat(options?: { replace?: boolean }): void {
  requestInternalAppNavigation({
    href: ROUTES.HOME,
    replace: options?.replace,
    scroll: false,
    source: "programmatic",
    transitionMode: "contextual",
  });
}
