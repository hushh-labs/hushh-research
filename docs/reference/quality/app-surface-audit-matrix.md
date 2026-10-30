# App Surface Audit Matrix


## Visual Context

Canonical visual owner: [Quality and Design System Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

This matrix tracks current route ownership and the proof still needed. The
[Pixel Grid And Symmetry Contract](./app-surface-design-system.md#pixel-grid-and-symmetry-contract)
owns geometry; [Toss Frontend Fundamentals](https://github.com/toss/frontend-fundamentals/tree/161d3d6)
informs code-quality and accessibility review, not a second visual language.

## One and Finance

| Surface | Target primitives | Status |
|---|---|---|
| `/one/kai?tab=market` | Shared Finance shell, market list/filter primitives | Canonical route; route-wide geometry not yet proved |
| `/one/kai?tab=portfolio` and finite detail routes | Shared Finance shell, grouped holdings and source rows | Canonical routes; narrow-table overflow proof still required |
| `/one/kai?tab=analysis` | Shared Finance shell and analysis panels | Canonical route; route-wide geometry not yet proved |
| `/one/setup/finance` | Shared top-bar Back, Finance setup body | One-origin and first-run Back contracts pass; physical Finance journey unverified |
| `/one/consent` | Grouped rows and focused detail panels | Canonical route; responsive detail proof still required |
| `/one/kyc` | `PageHeader`, `SettingsGroup`, `SettingsRow` | Canonical route; native interaction proof still required |
| `/one/profile/*` | Canonical grouped settings reference | Shared row geometry has focused Chromium/WebKit proof, not every profile route |
| Top/bottom chrome and Chat | Shared shell and Agent Bar | Focused layout proof; latest native Finance/Chat entry proof remains open |

## Advisor and Marketplace

| Surface | Target primitives | Status |
|---|---|---|
| `/ria/profile` | Advisor workspace launcher | Canonical route; route-wide geometry not yet proved |
| `/ria/onboarding` | Shared shell and page header | Canonical route; native interaction proof still required |
| `/ria/clients` and `/ria/workspace?clientId=...` | Grouped roster and focused access detail | Canonical routes; long-text/table proof still required |
| `/ria/picks` | Grouped active/history rows | Canonical route; responsive proof still required |
| `/marketplace` | Shared shell and discovery groups | Canonical route; responsive proof still required |
| `/kai/*`, `/ria`, `/ria/requests` | Compatibility redirects | Do not restyle or count as separate product workspaces |

## Revision-bound evidence

At `692edc248` on 2026-09-30, the local core mirror, typecheck, skill/docs
governance, generated-contract checks, and focused Finance navigation tests
passed. The selected browser layout pack passed 108 cases with 18 skips across
Chromium and WebKit (shell clearance, settings rows, and agent answer layout).
That is component/fixture proof, **not** a signed-in sweep of every route.
The USB iPhone passed the Chat-drawer smoke on the preceding local build.
After a new native export, the Finance rehearsal stopped at session entry (and
one Xcode runner disconnect); it did not establish Finance Back behavior.

## Open Follow-Through

1. `frontend-design-system`: audit canonical routes in bounded batches at 320/393px and desktop, light/dark, long text, keyboard focus, table overflow, and reduced motion. Compare measured gridlines against the owning contract; do not infer pixel accuracy from source or a fixture alone.
2. `frontend-architecture`: keep the canonical route sweep and native surface inventory current; record pass/skip/error per route, including same-session navigation where vault state matters.
3. `mobile-parity-check` and `reviewer-app-rehearsal`: rerun Finance setup entry, visible Back to One, and Chat return on the current USB iPhone build after a confirmed authenticated session. A build, connection, or unit test cannot substitute for that journey.

## Route and responsive acceptance

Derive the route set from `hushh-webapp/lib/navigation/app-route-layout.contract.json`
and its signed-in route verifier. Classify each route by shell archetype; compatibility
redirects are entry paths, not separate workspaces. Preserve information and function
while changing presentation. Source checks alone never establish rendered acceptance.

Use the relevant small-phone (320/375/390/393/430 px), tablet (768/820 px),
landscape (1024 px), and desktop (1280/1440 px) targets. Cover loading, empty,
partial, error, disabled, selected, validation, success and long-content states,
as applicable. Verify safe-area and keyboard clearance, nested scroll behavior,
constrained desktop columns, accessible touch targets and no horizontal overflow.
Include real iOS Safari/native keyboard evidence before declaring native completion.

Bounded review priorities include dense RIA/finance tables, Gmail section labels,
marketplace status chips, developer labels and Location overlays. Distinguish true
metadata from incorrectly styled content. Record actual route, revision, viewport,
platform, outcome and evidence; no inherited “passed” or “not started” ledger is current proof.

The former UI migration snapshots were consolidated here on 2026-10-19.
Their historical claims remain in Git; no historical status was promoted to acceptance.
