# Maintainer Harvest Attribution Ledger

This ledger records maintainer harvests where useful contributor value landed
through a maintainer-normalized patch instead of a direct source-PR merge.

The goal is fairness without rewriting history:

1. internal Hussh impact credit remains attached to the source PRs
2. public PR closeouts name the source PRs and accepted value
3. GitHub-visible co-author credit is added to the actual maintainer landing
   commit when the attribution decision is made before merge
4. after a maintainer harvest has already merged without co-author trailers, the
   only safe external-credit path is a transparent follow-up PR that contains a
   real, non-empty co-authored harvest replay or supplemental harvest patch

Do not claim that a follow-up PR changes the original merge commit's authorship
or additions/deletions. A replay commit may become the latest blame for replayed
lines, but it must be documented as a transparent non-rewrite replay, not as
retroactive mutation of the original merge.

## 2026-06-06: Damria One Location Stack Harvest

Maintainer landing commit:
`047b16289e89efee9c77bc0ba08df0f27c35dd18`

Landing status:

- The commit is merged to `integration/pr-train` via merge commit `4d82df446b244364371d83facf955d9596a22139`.
- Native GitHub contributor credit remains pending until this co-authored landing commit reaches `main`.
- Source PRs are closed as superseded.

Attribution status:

- The landing commit contains valid co-author trailers for `DamriaNeelesh`.
- Internal impact credit remains attached to the source PRs.

| Source PR | Contributor | Accepted Value |
| --- | --- | --- |
| [PR #1769](https://github.com/hushh-labs/hushh-research/pull/1769) | `DamriaNeelesh` | Revamp one location sharing UI. |
| [PR #1770](https://github.com/hushh-labs/hushh-research/pull/1770) | `DamriaNeelesh` | Add KAI Circle recommendation metadata. |
| [PR #1771](https://github.com/hushh-labs/hushh-research/pull/1771) | `DamriaNeelesh` | Add multi-recipient one location sharing. |
| [PR #1772](https://github.com/hushh-labs/hushh-research/pull/1772) | `DamriaNeelesh` | Add One Location section states and analytics. |
| [PR #1834](https://github.com/hushh-labs/hushh-research/pull/1834) | `DamriaNeelesh` | Add One Location contact sync invites. |
| [PR #1841](https://github.com/hushh-labs/hushh-research/pull/1841) | `DamriaNeelesh` | Add One Location activity dashboard. |
| [PR #1887](https://github.com/hushh-labs/hushh-research/pull/1887) | `DamriaNeelesh` | Add One Location stale retry telemetry. |
| [PR #1891](https://github.com/hushh-labs/hushh-research/pull/1891) | `DamriaNeelesh` | Add KAI Circle ranking for One Location recipients. |
| [PR #2098](https://github.com/hushh-labs/hushh-research/pull/2098) | `DamriaNeelesh` | Add Google Maps live location preview. |

## 2026-05-30: Author-Scoped PR Governance Harvest

Maintainer landing commit:
`72c464be84a14f73c2872d1028edf2b8433b85a3`

Landing status:

- The commit is on `kushaltrivedi/feat/agent-kai-revamp`.
- Native GitHub contributor credit remains pending until this co-authored
  landing commit reaches `main`.
- Source PRs remain open with `CHANGES_REQUESTED`; do not close them as
  superseded until the landing commit is merged to `main` and linked from the
  source PR records.

Attribution status:

- The landing commit contains valid co-author trailers for `Ayush04-C` and
  `DamriaNeelesh`.
- Internal impact credit remains attached to the source PRs.
- If a source PR receives a fresh contributor update before the landing commit
  reaches `main`, re-enter that PR through a repass train and prefer direct
  contributor PR merge when safe.

| Source PR | Contributor | Accepted Value |
| --- | --- | --- |
| [PR #1029](https://github.com/hushh-labs/hushh-research/pull/1029) | `Ayush04-C` | Visual not-found recovery on the canonical app route. |
| [PR #1031](https://github.com/hushh-labs/hushh-research/pull/1031) | `Ayush04-C` | Motion-safe loader feedback and ARIA status polish. |
| [PR #1066](https://github.com/hushh-labs/hushh-research/pull/1066) | `Ayush04-C` | Narrowed root metadata/SEO hardening. |
| [PR #1667](https://github.com/hushh-labs/hushh-research/pull/1667) | `DamriaNeelesh` | One Location profile entry point. |

## 2026-05-14: PR #1013 Async PR Train Patch Wave One

Original maintainer landing PR:
[PR #1013](https://github.com/hushh-labs/hushh-research/pull/1013)

Original merge commit:
`c150264ae87c12d681210fe43a917a601ab6f57a`

Attribution status:

- The original #1013 merge commit was not co-authored.
- Source PRs keep internal `harvested_source` impact credit.
- The co-authored replay commit in the follow-up PR provides GitHub-visible
  co-author credit for the source contributors listed below once it lands on
  `main`.
- Future maintainer harvests should put valid co-author trailers on the actual
  landing commit before merge when contributor code or test logic is materially
  reused.

| Source PR | Contributor | Accepted Value |
| --- | --- | --- |
| [PR #808](https://github.com/hushh-labs/hushh-research/pull/808) | `imsharukhan` | Top app bar back affordance touch target. |
| [PR #810](https://github.com/hushh-labs/hushh-research/pull/810) | `imsharukhan` | Settings drawer safe-area bottom padding. |
| [PR #809](https://github.com/hushh-labs/hushh-research/pull/809) | `imsharukhan` | RIA status panel responsive grid. |
| [PR #811](https://github.com/hushh-labs/hushh-research/pull/811) | `imsharukhan` | Onboarding carousel accessible labels. |
| [PR #942](https://github.com/hushh-labs/hushh-research/pull/942) | `smirthi-dharma` | Shared UI accessibility regression coverage. |
| [PR #967](https://github.com/hushh-labs/hushh-research/pull/967) | `smirthi-dharma` | Diagnostic observability log redaction helper. |
| [PR #1001](https://github.com/hushh-labs/hushh-research/pull/1001) | `smirthi-dharma` | Reachable observability client redaction attach point. |
| [PR #931](https://github.com/hushh-labs/hushh-research/pull/931) | `anshul23102` | Bounded Kai market-data cache growth control. |
| [PR #924](https://github.com/hushh-labs/hushh-research/pull/924) | `anshul23102` | Bounded Kai market-data lock growth control. |
| [PR #1002](https://github.com/hushh-labs/hushh-research/pull/1002) | `anshul23102` | Bounded Kai provider cooldown growth control. |
| [PR #943](https://github.com/hushh-labs/hushh-research/pull/943) | `suyashkumar102` | UID-safe Kai chat auth-mismatch logging. |
| [PR #913](https://github.com/hushh-labs/hushh-research/pull/913) | `anshul23102` | Kai chat pagination query bounds. |
| [PR #934](https://github.com/hushh-labs/hushh-research/pull/934) | `anshul23102` | Marketplace public query filter bounds. |
| [PR #926](https://github.com/hushh-labs/hushh-research/pull/926) | `anshul23102` | RIA client query filter bounds. |
