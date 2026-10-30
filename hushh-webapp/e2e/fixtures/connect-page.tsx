import React from "react";
import { createRoot } from "react-dom/client";

import ConnectPageClient from "../../app/connect/page-client";
import { usePathname, useSearchParams, useRouter } from "./connect-page-boundaries";
import { navigateTopShellBack } from "../../lib/navigation/top-shell-back";
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
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
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
          "--app-bottom-shell-height": "140px",
          "--app-scroll-bottom-pad": "var(--app-bottom-shell-height)",
        } as React.CSSProperties
      }
    >
      <div
        data-app-scroll-root="true"
        style={{
          position: "fixed",
          inset: 0,
          overflowY: "auto",
          paddingBottom: "var(--app-scroll-bottom-pad)",
        }}
      >
        <div data-app-shell-top-spacer="true" aria-hidden="true" />
        <div data-app-shell-content="true">
          {pathname.startsWith("/people/") ? <main data-testid="fixture-person-profile" className="p-6"><h1>Selected person's profile</h1></main> : <ConnectPageClient />}
        </div>
      </div>
      {/* A stand-in for the shared top bar (components/app-ui/top-app-bar.tsx),
          which owns the single "Connect" title: a solid band to the solid mask
          edge, so a scrolled screenshot reads as the app does. It carries no
          geometry the spec measures. */}
      <div
        data-fixture-top-bar=""
        className="fixed inset-x-0 top-0 z-30 flex items-end justify-center bg-background pb-2 text-foreground"
        style={{ height: "calc(var(--top-inset, 0px) + var(--top-systembar-row-gap) + var(--top-bar-h))" }}
      >
        {/* The same hooks the shared bar's breadcrumb trail carries, so the
            page's Profile type scale reaches this title exactly as it does there. */}
        <button aria-label="Back" className="absolute bottom-0 left-2 min-h-11 min-w-11" onClick={() => navigateTopShellBack({ pathname, searchParams, sectionOrigin: null, navigate: (action) => router[action.mode](action.href) })}>←</button>
        <nav data-testid="top-app-bar-breadcrumb-trail" className="ui-text-navigation-title flex items-center">
          <span className="font-semibold">{pathname.startsWith("/people/") ? "Profile" : searchParams.get("mutuals") ? "Mutual connections" : "Connect"}</span>
        </nav>
      </div>
      {document.documentElement.dataset.bottomChrome === "1" ? (
        <div
          data-fixture-bottom-shell=""
          aria-hidden="true"
          className="fixed inset-x-0 bottom-0 z-30 flex flex-col gap-2 bg-background px-4 pb-4 pt-2"
          style={{ height: "var(--app-bottom-shell-height)" }}
        >
          <div className="flex min-h-11 items-center rounded-full bg-white px-4 text-foreground dark:bg-black">Talk to One</div>
          <div className="flex min-h-14 items-center justify-around rounded-full bg-white text-foreground dark:bg-black">
            <span>Chat</span><span>One</span><span>Connect</span><span>Feed</span><span>Search</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Shell />);
