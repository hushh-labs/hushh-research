# The A+ loop — holding 🤫 hussh to the Apple / Jobs bar

**Intent:** examine the *actual* product, grade it honestly against an Apple A+ bar,
then iterate — smallest change, largest jump — until every dimension is A+ and the
whole clears the bar as one system. This is a living document; grades and the backlog
update as increments ship.

**The bar (standing, from `AGENTS.md`):** Jobs would ship it (clean, simple, beautiful,
the detail obsessed over, nothing extra) **and** Munger would call it wise (honest,
rational, good judgment). Beneath the four moats — brand · product · service · trust —
the non-negotiable floor is **taste & craft**. "A+" is verifiable on the real surface,
not slideware.

## Grades — was → now (grounded in a four-way repo examination, updated as increments ship)

| Dimension | Was | Now | Movement |
|---|---|---|---|
| Service experience | B− | **B** | The ownership payoff now shows on the home; one-tap-to-done still open. |
| Service engineering | A− | **A** | Both real holes fixed — dependency-aware `/health/ready`; typed `AUTH_PROVIDER_UNAVAILABLE` across the auth-outage contract. |
| End-user experience (UXD) | C+ | **B** | The home reads as a living agent (name + presence), emoji policy clean & enforced; full Summer-26 vividness in the app still open. |
| Engagement | C+ | **B−** | A warm, personal, time-aware home; return-brief / proactivity still open. |
| Understanding the human | C+ | **B** | The home greets you by name and surfaces *your* agent; "here's what I noticed" still open. |
| Meeting the customer where they are | B− | **B−** | Retired gradient fixed; the front-door "one story / one door" restructure + Ping mechanism still open (founder brand call). |
| **Throughline — "your sovereign agent is alive"** | F | **C+** | The sovereign agent is finally *visible* — an honest "reserved & ready → live" presence on the home; the full post-phone-verify reveal still open. |

## Prioritized backlog (ranked; smallest change → largest jump)

Legend: ☐ todo · ◐ in progress · ☑ shipped (on branch, flag-safe, verified). Repo: **W**=hushh-webapp, **S**=search-console, **B**=consent-protocol.

1. ☑ **Living home greeting (W).** Name + warm, time-aware greeting on `/one`.
2. ◐ **The "your Agent One is alive" presence + reveal (W+B).** ☑ Honest flag-safe status endpoint + a "Your Agent One" card (reserved → live) on the home. ☐ The dedicated post-phone-verify reveal screen (touches the live onboarding path — held for a considered pass).
3. ☐ **One proactive "here's your next best action" card on `/one` (W).** Grounded in real setup/consent state (needs a small data plumb beyond `capabilityStatusById`).
4. ☐ **Calm the trust surface (W).** "Who can see your data" summary atop the consent center; warmer naming; IDs behind a disclosure; designed empty states; restore a real PCHP receipts view. *(Substantial; 2,581-line surface.)*
5. ☑ **Fix the auth-outage contract drift (B+W).** Typed `AUTH_PROVIDER_UNAVAILABLE`; client keys off the code, not prose. *Real bug — fixed.*
6. ☑ **Dependency-aware `/health/ready` (B).** `SELECT 1` + Firebase check → 503 when down. *Real hole — fixed.*
7. ☑ **Enforce the emoji policy (S+W).** Decorative emoji removed in both repos; `EMOJI_STRICT=1` in search-console CI.
8. ◐ **One line + one front door (S).** ☑ Retired gradient killed (Summer26 gold sweep). ☐ The "one story / one door" restructure + CTA-verb unification (a founder brand call).
9. ☐ **Close the "single Ping" say/do gap (S).** Bring the honest in-code caveat to the customer surface, or build the consented introduction.
10. ☑ **Calm native loading (W) — already native-right; no change needed (verified).** *(Founder note: skeletons are usually not great for native.)* Investigated: `app/one/loading.tsx` returning `null` is intentional (documented) — `/one` is a retained shell that keeps the previous surface visible across native route transitions instead of flashing a skeleton, and `one-agent-roster.tsx` already renders **cached-first** via `CacheService.peek()` (stale-while-revalidate). So the app already does the native-right thing; agent-4's "loading returns null" flag was a false positive. Do NOT add skeletons.
11. ☐ **Celebrate named, living humans in their spirit (S).** Real per-expert profiles (not `/contact`); kill boilerplate `focus` strings. *(A feature: new routes + curation.)*

## Loop protocol & guardrails
- **Ground → grade → ship → verify → re-grade → repeat.** Assume we're wrong; hunt the edges.
- **Flag-safe, dev-branch (`claude/hushh-infrastructure-analysis-7o991c`) only.** Verify each increment end-to-end (typecheck + guards + real render/test), commit in intervals.
- **No UAT/Prod deploy without explicit founder sign-off.** Anything that needs a founder decision (spend, scope, a real human's participation) is called out, not assumed.

## Progress log (all on branch, flag-safe, verified end-to-end, dev-only — not deployed)
1. **Living home greeting (W)** `e2510d8` — name + time-aware greeting; 6 render/logic tests.
2. **`/health/ready` readiness probe (B)** `aea1b7f` — real dep checks; 5 tests; ruff/mypy/bandit clean.
3. **Auth-outage typed code (B+W)** `8d6acb1` — `AUTH_PROVIDER_UNAVAILABLE`; backend test + whole-app typecheck 0.
4. **Emoji policy — search-console (S)** `da45614` — 8 violations removed; `EMOJI_STRICT=1`; guard green.
5. **Emoji policy — webapp (W)** `feb320d` — customer-copy violations removed + dead `consent-dialog` deleted; typecheck 0.
6. **Personal-agent status endpoint (B)** `bb34d79` — honest, flag-safe, never-404 status; 4 tests.
7. **"Your Agent One" presence (W)** `bfe1b23` — reserved → live card on the home; fail-safe; 9 render tests; guards pass.
8. **Retired gradient → Summer26 sweep (S)** `a1508f1` — `/home` design-bar A+ 6/6; emoji clean.

Verification method for W/S: whole-app `tsc --noEmit` 0 errors, `eslint --max-warnings=0`, `verify:design-system`/`verify:accent-tokens`/`verify:design-bar`/`verify:emoji`, and real `@testing-library/react` render tests (deps installed in-sandbox so "verified" means *ran it*). For B: ruff + mypy + bandit + the CI-manifest pytest.

### Freshness sync + cleanup
- **Branch freshness sync.** Four syncs to date, all landing at **0 behind** in both repos.
  Sync 1: was 119 behind in research, 147 in search-console; conflicts resolved by adopting
  main's structure and re-layering the A+ work (dashboard roster + greeting/presence;
  `runtime_settings` kept `personal_agent_enabled`, dropped main-removed
  `crm_registry_db_enabled`; search-console took main's restructured nav ribbon). **Sync 2
  (2026-07-20):** was 20 behind in research, 18 in search-console; main's "unify private
  agent experience" + "unify connections and action runtime" + a large voice refactor
  landed. One conflict (`api/routes/one/__init__.py` router registry) resolved by keeping
  `personal_agent_router` + main's new `runtime_router` and dropping the dead `voice_router`
  (main deleted `voice.py`). Personal-agent wiring auto-merged intact. Also honored the
  repo's new **Commit Attribution Gate** (PR #4605: `includeCoAuthoredBy:false`) — no AI
  byline on commits. **Sync 3 (2026-07-20):** was 12 behind in research; clean auto-merge
  (main's runtime-contract + release-migration work). Adopted the standing practice of
  fetching `main` into the branch each milestone to resolve small conflicts continuously.
  **Sync 4 (2026-07-20):** was 6 behind; clean auto-merge (more crm/kai migration work).
- **Stale/redundant cleanup (migration numbering) — DURABLE FIX ADOPTED.** For three
  syncs each `origin/main` merge advanced the applied-migration head and forced a
  forward renumber of our three unapplied, flag-off migrations (`098/099/100` → `106/107/108`
  → `108/109/110` → `111/112/113`). main churns migrations fast (crm/kai), so this was a
  per-sync tax. **Sync 4 ends it: the three are parked in a high band — `900/901/902` —
  out of the active sequence.** This is safe because migrations apply via the explicit
  `db/release_migration_manifest.json` (ours are not listed → never applied), there is no
  directory-scan apply and no max+1 generator to poison, and the three are additive,
  standalone tables with no ordering dependency (apply-last is correct). They will be
  renumbered into sequence and added to the manifest **at greenlight**; until then `900+`
  never collides with main's growth. Order preserved (registry → prompt-versions →
  tombstone-index); every code + doc reference updated in lockstep. Current set:
  `900_personal_agent_registry.sql`, `901_agent_prompt_versions.sql`,
  `902_personal_agent_tombstone_hushh_id_index.sql`.
- **#10 evaluated (native loading):** already native-right (cached-first, no skeletons) — no change; see backlog #10.
