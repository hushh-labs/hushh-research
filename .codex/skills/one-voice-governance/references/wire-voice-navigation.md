Read the owning One Voice skill before applying this reference.

# Wire voice navigation

Adding voice navigation for a set of screens is a mechanical, repeatable recipe —
the same regardless of domain. What is *not* mechanical, and what this skill
deliberately refuses to auto-generate, is wiring a functional in-screen action
(something that mutates state or calls a backend). That needs real
`execution_policy` / `guard_ids` / backend-handler judgment calls from a person,
not a recipe. Confusing the two produces either a broken action (claims to run
something with no backend behind it) or an over-cautious dead nav link.

Written from doing this for Finance (Kai portfolio detail screens + market news,
2026-09) — see PR wiring `route.kai_portfolio_holdings` etc. as a worked example.

## Step 0 — sort navigation from actions, before writing anything

Ask the person requesting this (or read it back from them if they already listed
capabilities) to split every requested capability into exactly one of two lists.
Do not proceed to Step 1 until this split exists — guessing wrong here is exactly
the failure mode this skill exists to prevent.

**Navigation** — saying it should only take the person to a screen. Nothing is
created, changed, sent, or cancelled. "Show my holdings", "open news", "go to
allocation." → this skill's recipe (Steps 1–5) handles these directly.

**Action** — saying it does something: creates, edits, sends, deletes, confirms,
cancels, or calls an external API. "Send this email", "cancel the analysis",
"delete this connection." → **do not wire these here.** Hand them off as a
separate list for a person to design: each needs a considered `execution_policy`
(`allow_direct` / `confirm_required` / `manual_only`), `guard_ids`, and — critically
— an actual backend handler to call. Point them at
`docs/reference/kai/kai-action-gateway-vnext.md` for the authoring rules and at
this same domain's existing wired actions (e.g. `analysis.start` in
`app/one/kai/analysis/page.voice-action-contract.json`) as a worked example of
what a real action contract looks like, including its `goal` block for
multi-turn slot-filling.

If a requested capability is ambiguous ("show me connected sources" could read
as navigation *or* as "check whether sources are healthy," which might be an
action) — ask, don't guess. A navigation action that's secretly expected to
do a health check will look "done" and be wrong.

Keep the two lists separate in whatever tracking the person uses (a comment, a
scratch file, two sections of one issue) — later steps only ever touch the
navigation list.

## Step 1 — find what already exists

For each screen on the navigation list:

1. Find the real, live route. Don't trust a directory name alone — this codebase
   has retired compatibility redirects sitting at plausible-looking paths
   (`app/one/kai/investments/page.tsx` looks like a real screen; it's a
   `<ClientRedirect>` to Portfolio). Read the page file. If it's a redirect,
   drop it from the list and note where it actually goes.
2. Grep the whole tree for an existing action targeting that route:
   `grep -rn "/exact/route/path" --include="*.voice-action-contract.json" .`
   Contract files are not always colocated with the page — a shared view
   component used by several routes (e.g. `KaiPortfolioDetailPage` serving
   holdings/allocation/performance/sources via a `section` prop) often owns one
   contract file for all of them, sitting next to the component in
   `components/`, not `app/`. Find the actual rendering component before
   deciding where the contract file belongs.
3. If an action already exists but its aliases are too generic (e.g. a
   dashboard-overview action whose aliases already include the more specific
   phrase you're about to add), narrow it — one unambiguous target per phrase,
   not two actions competing for the same words.

## Step 2 — author the contract action

One action per screen, in the `*.voice-action-contract.json` that owns it
(existing file if Step 1 found the right home, otherwise a new file next to the
page/component, matching the `kai.local_action_contract.v1` schema — copy the
shape from a sibling file rather than inventing field names).

```json
{
  "action_id": "route.<domain>_<screen>",
  "label": "Show <Screen>",
  "meaning": "Navigates to <what a person would recognise this screen as>.",
  "aliases": ["show my <screen>", "show <screen>", "open <screen>"],
  "search_keywords": ["<screen>", "<a couple of synonyms>"],
  "reachability": {
    "routes": ["/exact/real/route"],
    "screens": ["<domain>_<screen>"],
    "hidden_navigable": true,
    "navigation_prerequisites": ["<parent surface> route must be active"]
  },
  "guard_ids": [],
  "risk_level": "low",
  "execution_policy": "allow_direct",
  "execution_target": {
    "status": "wired",
    "path": "route",
    "target": "/exact/real/route"
  },
  "control_ids": [],
  "state_exposure": [],
  "docs_references": ["path/to/the/real/page-or-component.tsx"],
  "speaker_persona": "<matches the domain's existing actions>"
}
```

Notes that aren't obvious from the schema alone:

- `path: "route"` is what makes this a pure-navigation action — it's the only
  path that's self-dispatching (the relay can `router.push`/`replace` it
  directly, without a registered `local_handler`). Never use `local_handler`
  for a plain "go to this screen" action; that requires a component to
  register a handler at runtime for something a route change already does.
- `hidden_navigable: true` + a `navigation_prerequisites` note is correct for
  a screen nested under a parent surface (a portfolio *section*, a profile
  *panel*). Top-level surfaces (the thing itself, not a sub-view of it) use
  `hidden_navigable: false` with empty prerequisites.
- **Do not** add the new action to `GLOBAL_NAV_ACTION_IDS`
  (`hushh-webapp/lib/voice/screen-context-builder.ts`) just because it "should
  be reachable from anywhere." That list is a reserved, tightly-scoped set —
  one entry per top-level agent surface (Profile, Location, Finance itself,
  not Finance's holdings screen). A `route` action is already callable from
  any screen via direct dispatch and `list_app_actions`; it just isn't
  pre-loaded into the compact per-turn menu on every screen, which is correct
  for a nested detail view, not a bug.

## Step 3 — regenerate the governed artifacts, in this order

```bash
cd hushh-webapp
npm run build:voice-gateway
npm run build:route-orchestration-index
cd ..
consent-protocol/.venv/Scripts/python.exe scripts/ops/generate_runtime_topology_index.py
```

The topology index depends on the gateway and route index, so it must run last
or it will regenerate against stale inputs and need a second pass. (Windows:
use the venv's own `python.exe` directly — a bare `python3` on PATH can resolve
to the broken Microsoft Store alias instead.)

## Step 4 — verify

```bash
cd hushh-webapp
npm run verify:voice-gateway
npm run verify:surface-map
npx vitest run __tests__/voice/kai-action-gateway.test.ts
cd ..
consent-protocol/.venv/Scripts/python.exe -m pytest consent-protocol/tests/test_one_adk_agent_tree.py -q
```

The pytest run is the one that actually catches a broken navigation action: it
includes `test_no_wired_action_is_a_dead_end_from_a_foreign_screen`, which fails
loudly if a new action can't actually be reached from a cold screen (the
`SCREEN_BOUND_BY_DESIGN` allowlist in that test is for genuinely context-bound
controls — a profile-page "this person" reference, an OTP field — not for a
plain navigation gap; if this test fails on your new action, the fix is almost
always to double-check `path: "route"` is set correctly, not to add yourself to
that allowlist).

`tsc --noEmit` and `eslint` on whatever `.tsx` you touched are still worth
running if Step 1 required narrowing an existing action's aliases.

## Step 5 — ship

One board ticket, PR references it. Commit message names the exact
`action_id`s added, notes any retired/redirect screens you ruled out (so the
next person doesn't re-investigate them), and states plainly that the action
list was hand-classified navigation-only in Step 0.
