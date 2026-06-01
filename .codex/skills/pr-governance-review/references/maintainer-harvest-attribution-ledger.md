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
