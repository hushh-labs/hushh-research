import React from "react";
import { createRoot } from "react-dom/client";

import ConnectPageClient from "../../app/connect/page-client";
import {
  resolveSignedInShellContentOffset,
  resolveTopShellGeometryStyle,
} from "../../components/app-ui/signed-in-shell-content-offset";

/**
 * The production Connect page (`app/connect/page-client.tsx`) inside the
 * signed-in shell geometry `app/providers.tsx` gives it: a scroll root that
 * owns the bottom clearance, a spacer under the top bar, and the page itself.
 * The network behind it answers on timers (connect-page-boundaries.tsx).
 */
function Shell() {
  return (
    <div
      data-app-shell-root="true"
      style={
        {
          ...resolveSignedInShellContentOffset({
            shellVisible: true,
            routeLayoutMode: "standard",
          }).style,
          ...resolveTopShellGeometryStyle({ hasTabs: true }),
        } as React.CSSProperties
      }
    >
      <div
        data-app-scroll-root="true"
        style={{
          position: "fixed",
          inset: 0,
          overflowY: "auto",
          paddingBottom: "140px",
        }}
      >
        <div data-app-shell-top-spacer="true" aria-hidden="true" />
        <div data-app-shell-content="true">
          <ConnectPageClient />
        </div>
      </div>
      {/* A stand-in for the shared top bar (components/app-ui/top-app-bar.tsx),
          which owns the single "Connect" title: a solid band to the solid mask
          edge, so a scrolled screenshot reads as the app does. It carries no
          geometry the spec measures. */}
      <div
        data-fixture-top-bar=""
        aria-hidden="true"
        className="fixed inset-x-0 top-0 z-30 flex items-end justify-center bg-background pb-2 text-[17px] font-semibold text-foreground"
        style={{ height: "calc(var(--top-inset, 0px) + var(--top-systembar-row-gap) + var(--top-bar-h))" }}
      >
        Connect
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Shell />);
