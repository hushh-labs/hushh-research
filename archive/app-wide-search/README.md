# App-wide Search archive

Disabled on 2026-10-17 at the product owner's request. The signed-in bottom
navigation is now Chat, One, Connect, Feed on web, Android, and iOS.

The global palette, host, URL/event helpers, suggestion catalog, usage memory,
and dedicated tests are preserved under their original paths below
`hushh-webapp/`, with `.archived` appended. These are inert source snapshots:
they are outside the app source tree, compiler, test discovery, contract
generation, and runtime imports. There is no enablement flag.

The provider mount, bottom-navigation command, native Search tab, test-harness
launcher, and Finance/RIA buttons that only opened this palette were removed.
Finance research starters and saved analysis remain available; page-local
filters and search fields remain owned by their existing features.

Shared voice/action contracts and `lib/search/search-route-context.ts` remain
active because the agent action runtime uses them. The existing command-bar
action-contract filename is retained for shared Back and control coverage;
it does not mount or enable the archived palette. Only the obsolete UI catalog
coverage check was archived; shared action, control, route, and Back checks
remain mandatory.

The native navigation capability is version 3. Older wrappers fall back to the
four-tab web navigation so their built-in Search tab cannot reappear. The
independent native appearance/chrome contract remains version 2.

Restoration requires a deliberate implementation change: review archived
sources against current contracts, restore imports and UI entry points,
reconcile native compatibility, and rerun the UI contract generation and
behavioral checks. Do not import archived snapshots into the application.
