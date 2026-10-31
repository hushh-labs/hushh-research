import { describe, expect, it, vi } from "vitest";

import { ROUTES } from "@/lib/navigation/routes";
import { INTERNAL_APP_NAVIGATION_REQUEST_EVENT } from "@/lib/utils/browser-navigation";
import { navigateToAgentChat } from "@/lib/navigation/agent-navigation";

describe("navigateToAgentChat", () => {
  it("routes every chat handoff to the canonical root without an origin query", () => {
    const listener = vi.fn();
    window.addEventListener(INTERNAL_APP_NAVIGATION_REQUEST_EVENT, listener);

    navigateToAgentChat();

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]?.[0]).toMatchObject({
      detail: expect.objectContaining({
        href: ROUTES.HOME,
        scroll: false,
        source: "programmatic",
      }),
    });
    window.removeEventListener(INTERNAL_APP_NAVIGATION_REQUEST_EVENT, listener);
  });
});
