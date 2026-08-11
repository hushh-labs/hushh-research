# Handoff — persistent memory export

Everything carried across sessions for this repo, exported verbatim 2026-08-11.
Companion to `HANDOFF-voice-agent.md` (branch/technical state).

**Read this as point-in-time observations, not live state.** Each entry was true
when written; several have been corrected since and say so inline. Any file:line
or config claim must be re-verified before you act on it — the `location-state`
entry below is a worked example of one that went stale (Supabase → Cloud SQL).

Entries are grouped as the memory system groups them:
- `feedback` — how the user wants the work done, and why
- `project` — ongoing work and constraints not derivable from code or git
- `reference` — pointers to external resources

---

## Index (MEMORY.md, loaded every session)

```markdown
- [Scope: hushh-desktop only](feedback_scope_hushh_desktop.md) — restrict work to hushh-desktop/ subtree unless told otherwise
- [Hushh Desktop beta state](project_hushh_desktop_beta.md) — beta-v1.4/1.5, commit hold lifted 2026-07-18, normal commit rules now apply
- [AI pair: execution layer role](feedback_ai_pair_execution_layer.md) — second Claude chat does architecture/planning, I execute surgically, stop on ambiguity
- [Announce disruptive actions first](feedback_announce_disruptive_actions.md) — check/announce before killing processes or restarting the app, user may be mid-session
- [CSS mask-composite fails in Electron build](feedback_css_mask_composite_electron.md) — use outline+box-shadow keyframes for glow effects instead
- [Backend split idea](project_hushh_desktop_backend_split.md) — deferred plan: local GenieX orchestration vs remote hosted backend, to stop shipping secrets in installer
- [Hushh agent roadmap](project_hushh_agent_roadmap.md) — One/Kai/Nav/KYC, Hermes 64K wall; co-founder's 08-03 picture: hussh-one-hermes, native vault, PCC, AP2/UCP
- [No AI attribution in commits/PRs](feedback_no_ai_attribution_in_commits.md) — this repo uses DCO signoff, never Co-Authored-By or "Generated with Claude Code"
- [DB pool starvation caused "stuck loading"](project_hushh_desktop_db_pool_starvation.md) — fixed via NullPool→QueuePool + DB_POOL_MAX_SIZE; check this before RAM/DNS/thermal theories
- [Founder demo feedback → Beta 1.5 pivot](project_hushh_desktop_founder_demo_feedback.md) — build agents not chatbots, real daily-use cases, major UI/UX overhaul, dogfood test
- [Always cold restart](feedback_cold_restarts.md) — full app restart to pick up backend changes, not a supervisor-respawn shortcut
- [Heightened repo access, no auto-push](feedback_heightened_repo_access_no_push.md) — Parth hired, elevated GitHub access; never push/close PRs without per-instance go-ahead
- [Hushh-research main migration](project_hushh_research_main_migration.md) — Task 1 (active): migrate Sage into main; Task 2 (later): adopt main into desktop; on-device AI on hold
- [GCP projects: prod vs UAT](reference_gcp_projects.md) — consent-protocol has hushh-pda (prod) and hushh-pda-uat (UAT); default to UAT for dev/local work
- [location/state + consent/summary DB load](project_hushh_research_location_state_db_load.md) — 23-77 SQL queries/call, 26-47s+, starves shared DB pool; deferred, don't chase "stuck" symptoms into it uninvited
- [Push target: upstream, not the fork](project_hushh_research_push_target.md) — fork is abandoned; push to hushh-labs upstream, measure divergence against upstream/main
- [Drive PR CI to green](feedback_pr_ci_until_green.md) — after opening/pushing a PR, check Actions and fix failures until all green; never leave a PR red
- [Ship iOS-compatible changes](feedback_ios_compatible_changes.md) — hushh-research ships to TestFlight via Capacitor; verify every change against the native build, not just web
```

---

## `feedback_ai_pair_execution_layer.md`

```markdown
---
name: feedback-ai-pair-execution-layer
description: "User runs a two-AI split — a separate Claude chat does architecture/diagnosis/planning, Claude Code executes surgically"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bd167d0b-4bdf-43f4-9f6a-00a5fbd619e3
---

The user pairs two AI sessions: a separate "Claude" chat acts as the logic/assessment layer (architecture decisions, bug diagnosis from symptoms, plan review, precise instructions). Claude Code (this session) is the execution layer: file reads/edits, terminal commands, the build/run/fix loop, and ground truth from the codebase.

**Why:** The user set this up explicitly as a working arrangement and gave direct behavioral rules for it.

**How to apply:**
- When given a task in this mode, assume the reasoning/approach was already validated upstream — execute surgically, don't re-architect or second-guess the approach unless the codebase directly contradicts the instruction.
- If unsure about an approach mid-task, STOP and surface the exact decision point rather than resolving ambiguity by exploring further — the user will take it to the logic layer and bring back a precise answer.
- Keep responses tight: confirm, execute, report result. Don't re-explain the plan back at length.
- This mode is per-project-context the user pastes in (e.g. Hushh Desktop handoff doc); it may not apply to every conversation — treat it as active once the user frames a task this way. See [[project_hushh_desktop_beta]] for the current project this was set up for.
```

## `feedback_announce_disruptive_actions.md`

```markdown
---
name: feedback-announce-disruptive-actions
description: "Announce before killing processes / restarting the app, and make no code edits at all while Parth is testing — wait for an explicit 'start fixing'"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bd167d0b-4bdf-43f4-9f6a-00a5fbd619e3
  modified: 2026-08-10T01:58:31.033Z
---

Before force-killing a process (e.g. `Stop-Process`, `taskkill`) or restarting the Hushh Desktop app for a test, check first whether the user is actively using it, or at least announce the action before doing it.

**Why:** During a live debugging session (2026-07-04), Claude killed the running GenieX process to simulate a crash for testing `registry.js`'s auto-recovery logic, without checking whether the user was mid-session. The user was actively chatting with the app at the time. Their correction: "yes i was using the app, if you want me to not do that then mention it before hand."

**How to apply:** For this project ([[project_hushh_desktop_beta]]), before any Bash/PowerShell action that kills a process tied to the running app, restarts `npm start`, or otherwise disrupts a live session, say so first and give the user a chance to flag if they're using it — don't just act and find out afterward via log confusion.

**The stronger form — while he is testing, do not edit code at all.** Parth's instruction (2026-08-10), during a localhost test pass on `hushh-research`: "do not start fixing, which may crash backend or frontend, start when i explictly say 'start fixing'." A dev server hot-reloads every save, so an edit made while he is working through a test plan can break the thing under test and make his results meaningless — and he cannot tell my breakage from the bug he was hunting.

So when he is giving feedback item by item: collect it, write it down somewhere durable (a scope file in the scratchpad, plus todos), reply with what was recorded and any implementation notes worth capturing while fresh — and change nothing until the explicit phrase arrives. Batch every fix into one pass at the end. This applies to the whole repo during a test pass, not only to the files under test, since a shared module can break an unrelated screen.
```

## `feedback_cold_restarts.md`

```markdown
---
name: feedback-cold-restarts
description: "Always do a full cold restart of Hushh Desktop after backend/daemon code changes, not a quick process-kill-and-respawn"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bd167d0b-4bdf-43f4-9f6a-00a5fbd619e3
  modified: 2026-07-29T00:44:37.587Z
---

When picking up a backend (or daemon) code change during live testing/demo prep, always do a full cold restart of the whole app (kill the entire Electron process tree via the root `npm start` PID, then relaunch `npm start` fresh) — not the faster shortcut of just killing the `python.exe` server process and relying on Electron's supervisor (`supervisor/index.js`) to auto-respawn it.

**Why:** Parth explicitly corrected this mid-session (2026-07-29) after I used the supervisor-respawn shortcut to pick up a backend fix. A partial respawn leaves residual doubt about whether the fix is fully live (stale imports, stale connections, etc.) — not worth it during live demo-prep testing where reliability matters more than the ~10s saved. See [[project_hushh_desktop_beta]] and [[project_hushh_desktop_founder_demo_feedback]] for the demo-prep context this applies to.

**How to apply:** Any time backend/frontend/daemon code changes and needs to be picked up while the app is running (especially during live user testing), default to a full cold restart:
1. Identify the root `npm start` process (check `ParentProcessId` chain via `Get-CimInstance Win32_Process` if ambiguous — the tree is `npm start` → `electron/cli.js` → main `electron.exe` → gpu/utility/renderer + nested `next dev` electron.exe).
2. `taskkill //PID <root> //T //F` to kill the whole tree in one shot.
3. Unset `ELECTRON_RUN_AS_NODE` first if set in the shell (recurring leak in this environment — breaks `Menu.setApplicationMenu` if left set).
4. Relaunch via `npm start` in the background.
5. Wait for backend `/docs` to return 200 before telling the user it's ready.

Note: `OneWindows.Daemon.exe` runs independently of the Electron process tree (parent is the OS service host, not npm), so killing the app tree via this method does NOT kill the daemon or lose Market Watch pairing — confirmed via process-tree inspection this session.
```

## `feedback_css_mask_composite_electron.md`

```markdown
---
name: feedback-css-mask-composite-electron
description: "In hushh-desktop's Electron/Chromium build, CSS mask-composite gradient-border tricks fail; use outline+box-shadow keyframes instead"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bd167d0b-4bdf-43f4-9f6a-00a5fbd619e3
---

Avoid the `mask-composite: exclude` / `-webkit-mask-composite: xor` "animated gradient border ring" CSS technique in hushh-desktop's frontend. Prefer a plain `outline` (animated via `outline-color` in `@keyframes`) plus a synced `box-shadow` for the glow halo.

**Why:** Attempted this technique for an animated multi-hue border glow on the Kai chat composer (differentiating local/on-device mode from cloud). The mask failed to clip in this Electron/Chromium build — instead of a thin ring, the full unmasked gradient painted solid across the entire element, obscuring content. User feedback: "you made it worse, revert your changes." Switched to a simple `outline-color` + `box-shadow` color-cycle animation (no masking, no pseudo-elements needed) — worked correctly on the first try and was well received ("nice work").

**How to apply:** For [[project_hushh_desktop_beta]] frontend work, when building glow/border animation effects, default to `outline`/`box-shadow` keyframe color-cycling rather than conic-gradient + mask-composite pseudo-element tricks. If a true gradient (not just a color-cycling solid) border is ever required, test the mask rendering in isolation first before wiring it into a real component — don't assume standard CSS-tricks-style masking patterns render correctly in this Electron build without verification.
```

## `feedback_heightened_repo_access_no_push.md`

```markdown
---
name: feedback_heightened_repo_access_no_push
description: Parth now has heightened/elevated access on the hushh-research GitHub repo (post-hire) — never push, close PRs, or take other GitHub write actions without his explicit per-instance go-ahead
metadata:
  node_type: memory
  type: feedback
  originSessionId: bd167d0b-4bdf-43f4-9f6a-00a5fbd619e3
  modified: 2026-08-06T00:45:16.439Z
---

Parth got the job (confirmed 2026-08-06) and now has heightened access on the `hushh-research` GitHub repo. His explicit instruction: "don't push anything as now i have heightened access on the github repo so no messing up."

**Why:** Elevated permissions raise the blast radius of any GitHub write action (push, force-push, PR close/merge, branch delete, etc.) — a mistake now has more reach than it did as a regular contributor. This is a deliberate tightening from earlier in this same engagement, where pushing fixes straight to an open PR branch after local verification was the established, unremarked-upon flow (e.g. CI-fix commits pushed directly to `feature/sage-webapp-port` without asking each time).

**How to apply:** Treat every `git push`, PR state change (close/merge/ready-for-review), branch deletion, or other repo-mutating GitHub action as requiring explicit confirmation *for that specific instance* — not a standing blanket approval, even if he approved a similar action earlier in the same session. Local commits are fine to create (still don't commit unprompted per the general safety baseline), but stop before anything that touches the remote or the PR's state on GitHub and ask first. This supersedes the earlier looser push behavior in this engagement.
```

## `feedback_ios_compatible_changes.md`

```markdown
---
name: feedback_ios_compatible_changes
description: "Every hushh-research change must work on the iOS Capacitor/TestFlight build, not just web — check the native path before calling a fix done"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bd167d0b-4bdf-43f4-9f6a-00a5fbd619e3
  modified: 2026-08-09T22:36:05.678Z
---

Parth's instruction (2026-08-10): "also make your changes ios compatible." `hushh-research` ships a TestFlight iOS build from `main` via Capacitor, so web-only correctness is half a fix.

**Why:** several native behaviours have no web equivalent, and code that reads fine in a browser is silently wrong on device. Concrete traps already hit in this repo:

- **`window.location.origin` is not a public URL.** `capacitor.config.ts` sets `iosScheme: "App"`, so a shared link built from the origin becomes `App://localhost/...`, useless to a recipient. The correct pattern is `lib/one-location/public-invite-url.ts`: prefer `NEXT_PUBLIC_APP_URL` and require the result to match `^https?://`.
- **Native-only permission tiers.** `HushhLocationPermissionState.precise` comes from the native plugin; `lib/capacitor/plugins/location-web.ts` hardcodes `precise: null`, so any UI branching on `precise === false` is dead in a browser and only testable on device.
- **No browser back.** WKWebView has no native navigation stack for Next routes, so `router.back()` can eject the person out of the app. The app owns its own edge-back gesture, which shares `resolveTopShellBackAction` with the top-bar button — one resolver serves web and iOS, so changing it changes both.
- **Static export.** The Capacitor build is a static export; anything depending on server rendering or request-time env will not exist there.

**How to apply:** when touching links, permissions, navigation, storage or layout, ask what the native build does before shipping. Prefer a shared helper that already handles it over a fresh `window.*` read. Say plainly in the PR when a change is verified on web but not on device — an iOS claim needs a real build. See [[mobile-bug-log]] for the build recipe and the recurring gotchas (UAT backend URL, sim boot, iCloud path).
```

## `feedback_no_ai_attribution_in_commits.md`

```markdown
---
name: feedback-no-ai-attribution-in-commits
description: "Never add Claude/AI attribution to git commits or PRs in this project (hushh-research) — no Co-Authored-By trailer, no \"Generated with Claude Code\" footer."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bd167d0b-4bdf-43f4-9f6a-00a5fbd619e3
---

Never add "Co-Authored-By: Claude..." to commit messages, and never add "🤖 Generated with Claude Code" (or similar) to PR descriptions, in this project.

**Why:** explicit instruction from the user (2026-07-18), after having to retroactively strip this from 15 already-pushed commits and a PR body via a non-interactive rebase + force-push. This project uses DCO (`Signed-off-by: <user's real name/email>`) instead — verified via the repo's own DCO GitHub Action check, which passes on a clean `Signed-off-by` trailer using the user's real git identity (Parth Mawai <parth.mawai.12@gmail.com>).

**How to apply:** this overrides the default Claude Code commit-message instructions (which normally append a Co-Authored-By trailer) for this repo. When creating commits here, use `git commit --signoff` (or add the trailer manually) instead of any AI co-author line. When creating PRs, do not add a "Generated with Claude Code" footer to the body. This applies project-wide, not just to any one branch — assume it holds for all future commits/PRs in `hushh-research`/`hushh-desktop` unless the user says otherwise. See [[project_hushh_desktop_beta]] for the broader project context.
```

## `feedback_pr_ci_until_green.md`

```markdown
---
name: feedback_pr_ci_until_green
description: "After opening or pushing to a PR, always check its GitHub Actions and keep fixing failures until every check is green — never leave a PR red"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bd167d0b-4bdf-43f4-9f6a-00a5fbd619e3
  modified: 2026-08-09T22:35:41.699Z
---

Opening a PR is not the end of the task. After every `gh pr create` and every push to an existing PR, check the checks and keep working until they are all green. Parth's instruction (2026-08-10): "always check the published pr for github actions and act on the failed actions until everything is green."

**Why:** a red PR cannot merge and cannot deploy, so leaving one red hands back work that looks finished and is not. On `hushh-research` this is worse than usual — `main` sits behind a merge queue and a codeowner review, so a PR that goes red after review costs another human round trip. Failures there are also frequently *mine* rather than flaky: on PR #5006 four red gates were, in order, a stale base branch, a contract index I regenerated unnecessarily, a ruff import-sort in my own test, and a route id I returned without adding to its union type.

**How to apply:** `gh pr checks <n> --repo hushh-labs/hushh-research`, then `gh run view --job <id> --log-failed` on each failure — logs only exist once the run completes. Fix, push, re-check, repeat. Read the actual failure rather than assuming flakiness, and distinguish cascades from causes: `Preflight Gate` and `CI Status Gate` only aggregate other jobs, and a failed preflight *skips* the expensive lanes, so a green-looking board can mean the real tests never ran. Watch for the base drifting mid-review — `Base Freshness Gate` blocks on being even one commit behind. See [[project_hushh_research_push_target]] for the upstream/fork trap that makes divergence counts lie.
```

## `feedback_scope_hushh_desktop.md`

```markdown
---
name: feedback-scope-hushh-desktop
description: Work scope is restricted to the hushh-desktop sub-project directory unless the user says otherwise
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bd167d0b-4bdf-43f4-9f6a-00a5fbd619e3
---

Treat `hushh-desktop/` as an independent sub-project within the `hush` repo. Build, run, search, and reason about code only within `hushh-desktop/` unless the user explicitly directs otherwise.

**Why:** The user stated this directly: "we are making a sub-project i.e. hushh-desktop, so build and look within it only unless i tell you otherwise." `hushh-desktop/ARCHITECTURE.md` reinforces this — it describes a strict boundary between the main repo and the desktop codebase, with `frontend/` and `backend/` being synced copies from `hushh-webapp` and `consent-protocol` (see `hushh-desktop/sync/BOOTSTRAP.md` for baseline commit).

**How to apply:** Default all Glob/Grep/Explore/build/run activity to the `hushh-desktop/` subtree. Don't wander into sibling directories of the parent `hush` repo for context unless the user asks. See [[project_hushh_desktop_beta]] for current work state.
```

## `project_hushh_agent_roadmap.md`

```markdown
---
name: project_hushh_agent_roadmap
description: "Real internal agent roadmap (One/Kai/Nav/KYC), the DNA-model pattern for building agents, the Hermes 64K-context wall already hit, and the co-founder's 2026-08-03 bigger-picture direction (hussh-one-hermes, native vault, PCC, AP2/UCP)"
metadata: 
  node_type: memory
  type: project
  originSessionId: bd167d0b-4bdf-43f4-9f6a-00a5fbd619e3
  modified: 2026-08-03T04:32:00.899Z
---

Hushh's actual maintained product ontology (per `docs/vision/agent-ontology.md` in consent-protocol) is **Hussh → One → {Kai, Nav, KYC}** — not the "Kai/Nav/Care/Style" framing on the public hushh.ai marketing site. Care and Style do not exist anywhere in the codebase (docs, code, or `.codex/`) — pure external marketing, zero internal reflection.

- **One**: top-level personal agent/relationship layer. Status "appr" (approved direction) in the project's own architecture map (`hussh-mega-map.gen.py`), not yet a separate shipped runtime — current runtime is still Kai-first.
- **Kai**: finance specialist, fully shipped. Reference implementation for how every future agent should be built: `fundamental/sentiment/valuation_agent.py` + `debate_engine.py` running a weighted 2-round debate → `DecisionCard`, streamed over SSE.
- **Nav**: privacy/consent guardian (`agent.nav.review` scope). Real scaffolding exists already (`consent-protocol/hushh_mcp/agents/nav/agent.yaml`, `manifest.py`) but not yet a separate runtime.
- **KYC**: identity/workflow specialist (`agent.kyc.process` scope) — explicitly documented as "the first planned specialist added after Kai and Nav." Also has real scaffolding in place already.

**The DNA Model** (strict 4-layer pattern, documented in `consent-protocol/docs/reference/agent-development.md`): `AGENT` (owns `agent.yaml`, enforces consent via `HushhAgent.run()`) → `TOOLS` (`@hushh_tool`-decorated, re-validates consent per call) → `OPERONS` (pure/stateless logic, never imports services) → `SERVICES` (only layer touching the DB). Consent is checked three separate times per request. New agent registration is a documented 7-step recipe: new `agents/{name}/` dir → `agent.yaml` → subclass `HushhAgent` → `@hushh_tool` wrappers → FastAPI routes → register in `server.py` → optional delegation tool in `agents/orchestrator/tools.py`.

**Hermes wall already hit**: the maintainer's stated direction is to fit on-device inference into a "Hussh One / Hermes Agent runtime" (NousResearch's open-source `hermes-agent`) as a swappable model backend — status "appr", not shipped. Someone already live-tested pointing the real `hermes-agent` CLI at the desktop's GenieX↔OpenAI-compatible `local_bridge` (port 18182): **Hermes hard-refuses any model under 64K-token context**, a hard-coded floor, and GenieX is 4K. Documented in `hushh-desktop/backend/hushh_mcp/services/agent_chat_service.py` code comments and `hushh-desktop/docs/KNOWN_ISSUES.md`. The written resolution: Hermes's main loop should stay on a large-context model and *delegate* narrow steps (intent routing, PKM capture) to the on-device bridge, not try to run Hermes's own loop on-device. Separately confirmed externally: Hermes's own native multi-agent/role orchestration (named specialist roles like Coordinator/Researcher/Reviewer) is still just a GitHub design proposal upstream (`NousResearch/hermes-agent` issue #344), not merged code — so "build Nav/KYC as agents living inside Hermes" isn't actually how the project's own docs frame the split; Hermes is meant to be the conversational runtime layer, Nav/KYC get built via the DNA model independent of Hermes.

**`.codex/` is unrelated**: a separate 12-agent governance fleet (`governor`, `reviewer`, `rca_investigator`, etc., defined as `.codex/agents/*.toml`) for maintaining *this repo itself* (code review, CI, docs audits) — not a pattern for product-facing agents, though its "single owner + explicit scope + no silent authority creep" discipline is worth borrowing conceptually for Nav/KYC's boundaries.

**Why this matters**: Kai works today; Nav and KYC are actively expected to join soon (per the user, this is active development, not speculative). When work turns to building Nav or KYC, this is the documented pattern and status quo to build from — and Nav/KYC's canonical home is `consent-protocol`, not `hushh-desktop`, which matters given [[feedback_scope_hushh_desktop]] restricts default work scope to hushh-desktop only.

**How to apply**: Before recommending Hermes-orchestration-shaped approaches for new agents, remember the 64K-context wall already ruled that out for on-device paths. Before guessing at agent names/roles, use Kai/Nav/KYC (not Care/Style). When asked to scaffold a new agent, follow the DNA model + 7-step recipe above rather than inventing a different structure.

**Decided app architecture direction (2026-07-15)**: after the user's own broader read on Hermes Agent, we researched NousResearch/hermes-agent directly (GitHub repo, docs, issues #344, #24140, #32048, #53347, #31600) and confirmed: (1) `MINIMUM_CONTEXT_LENGTH = 64_000` is hardcoded in `agent/model_metadata.py`, currently has no config override, and is the subject of multiple open, unprioritized (P3) upstream issues — GenieX/on-device models cannot run Hermes's own reasoning loop, this is a real current upstream limitation, not just something we hit once; (2) native multi-agent orchestration (specialized roles, shared state, DAG workflows) is an unimplemented, unprioritized design proposal (#344), not shipped code. Given this, the user explicitly chose **Option (a): Hermes as a conversational router/front-door only**, delegating to Kai/Nav/KYC which remain independent DNA-model agents (each deciding their own cloud/local hybrid inference, e.g. via [[project_hushh_desktop_backend_split]]'s local_bridge). Hermes itself must run on a model clearing 64K context (cloud, or a large local model) — it is explicitly NOT going to own process lifecycle/supervision of Kai/Nav/KYC (that was rejected as Option (b) — not supported upstream, would require building bespoke orchestration infra ourselves).

**How to apply**: When building the Hermes integration, build it as a chat/routing surface in hushh-desktop that calls out to Kai/Nav/KYC's existing/planned endpoints via tool-calling (`delegate_task`-style), not as something that spawns/monitors agent processes. Don't revisit Option (b) unless the user explicitly reopens it — it was a considered and rejected direction, not an oversight.

**Correction (2026-07-16), supersedes the 2026-07-15 entry above on Nav's maturity and on which router is "the real one"**: fetched upstream/main fresh (local checkout had been ~200 PRs stale) and read the actual merged code, not just docs:
- **Nav is far more built than "scaffolding"**: `consent-protocol/hushh_mcp/adk_bridge/nav_agent.py` is a real 427-line manifest-driven agent (`ManifestLoader`, per-request consent-token validation, delegates trusted-people queries to a child `connections_agent`). Update any future claim that Nav is speculative.
- **The org runs TWO parallel One-orchestration routers today, and the deterministic one is the production default, not a legacy one being replaced**: `hushh_mcp/agents/orchestrator/tools.py`'s `classify_specialist_domain()` is a plain-Python keyword-cue matcher (portfolio/stock->Kai, consent/vault/privacy->Nav, kyc/passport/document->KYC, etc.), fail-closed, no LLM/ADK dependency. The LLM/ADK tool-delegation tree (`one_adk/agent_tree.py`, a real Google-ADK `LlmAgent` with the full specialist roster as tools) is also real and merged, but is gated behind `AGENT_ONE_ADK_DELEGATION` (off by default) with an explicit code comment: it stays off "until the Phase 4 realtime/agent benchmark justifies adopting the ADK runtime over the deterministic classifier." **Do not describe hushh-desktop's own regex/keyword `plan_action()` fallback as "the superseded approach" — it's the same category of solution the org itself currently trusts more in production.**
- **`one_adk`/`agent_tree.py` is real but tightly coupled** to infrastructure hushh-desktop does not have: a generated action-gateway/voice-manifest contract pipeline (per-route `.voice-action-contract.json`, `contracts/kai/voice-action-manifest.v1.json`) and a web-specific onboarding-goal resolver. Porting it verbatim would mean faking that machinery — explicitly against this repo's own "What Not To Build" doctrine in `docs/future/one-product-surface-evolution-plan.md`.
- **hushh-desktop DOES already have its own copy of the generated action-gateway contract** (`hushh-desktop/frontend/contracts/kai/kai-action-gateway.vnext.json` + `lib/voice/kai-action-gateway.ts` reading it) — this was wrong in the earlier assessment that desktop lacks the contract system entirely. It has one, just possibly stale/incomplete relative to upstream's current version. Concretely: `route.one_kyc` already existed fully-wired in this contract (target `/one/kyc`) even though the *backend* (`agent_chat_service.py`) never offered it as a reachable action — fixed 2026-07-16 by adding a `kyc` entry to `_APP_SURFACE_ACTIONS` and a matching regex in `_NAVIGATION_ACTION_PATTERNS`, using `classify_specialist_domain()`'s KYC cues as the source for the new phrasing (not invented locally).
- **Kai backend drift is a real migration project, not small sync work**: diffed hushh-desktop's vendored Kai/market files against current upstream — every file differs, and by a lot (`plaid_portfolio_service.py` ~6,368 differing lines, `operons/kai/fetchers.py` ~3,149, `debate_engine.py` ~2,518). This is near-total rewrites accumulated over time, not incremental drift. Do not attempt a blind/bulk sync of these files without the user awake to verify Kai chat still works after each change — recommend a dedicated, file-by-file session instead.

**MAJOR correction (2026-07-17), supersedes the drift-magnitude claim directly above**: those inflated numbers were a **CRLF/LF line-ending artifact**, not real drift. hushh-desktop's vendored `hushh_mcp/*.py` files are CRLF; upstream `consent-protocol/hushh_mcp/*.py` are LF. Diffing without normalizing counts every single line as changed. Proven: `plaid_portfolio_service.py` raw diff = 6,387 lines, but with `sed 's/\r$//'` on both sides = **115 real lines**. The true drift is ~50× smaller than the notes above feared — the Kai/backend sync is genuinely tractable, not a rewrite. Full normalized inventory of `hushh-desktop/backend/hushh_mcp` vs `upstream/main:consent-protocol/hushh_mcp` (script saved in session scratchpad `drift_inventory.sh`): **58 identical, 30 minor (≤40 lines), 38 major (>40 lines), 8 desktop-only (fork customizations to preserve), 64 upstream-only (features desktop never vendored)**. Branch is 1173 behind / 1628 ahead of upstream/main. `hushh-desktop/` itself does NOT exist upstream — it's fork-only; the drift is purely vendored-copy drift of `hushh_mcp`. **Always normalize line endings before diffing/measuring drift here** (see [[feedback_css_mask_composite_electron]]-adjacent CRLF lessons).

- **The local GenieX↔OpenAI bridge is ALREADY BUILT and mature** (as of 2026-07-17): `hushh-desktop/backend/local_bridge/server.py` + `tool_calling.py` exist and are shipped. It's a spec-compliant OpenAI backend on fixed port 18182 wrapping GenieX (18181): fixes streaming `finish_reason`/`[DONE]` compliance AND does real tool-calling translation via the Nous/Hermes `<tool_call>` tag convention. `agent_chat_service.py` already routes local mode through it (`stream_response` → `http://localhost:18182`, `_plan_action_via_bridge` for the tool-calling classifier). The beta-1.2 bridge plan (`swirling-shimmying-hennessy.md`) is DONE — do not propose "build the bridge," it exists.

- **Upstream already has a `runtime_providers/` provider-abstraction package that desktop does NOT vendor** (8 files, all UPONLY: base/factory/registry/openai_transport/anthropic_transport/normalized/translate/vertex_failover). This is highly relevant to the user's stated goal of "drop the hardcoded local chatbot in Kai, make it one of the Hermes/routed endpoints rather than hardcoding it directly" — upstream may already have the clean provider-endpoint abstraction that de-hardcodes local vs cloud. `agent_chat_service.py` is the crux file for that refactor (MAJOR drift: 444 added / 569 deleted normalized — the desktop's 569 extra lines are largely the local-bridge routing).
- **`feat/kyc-agent-enhancements` is live unmerged WIP** (12 commits ahead of main as of 2026-07-16, KYC redraft HTML rendering with structured table/card parity) — expect this to land and change KYC-adjacent code later.

**The bigger technical picture, straight from Kushal (co-founder, second to founder Manish), 2026-08-03**: this is the highest-authority source on direction to date — a live DM, not inferred from code or docs — and qualifies/partially supersedes the 2026-07-15 "Decided app architecture direction" entry above, particularly on whether Hermes runs on-device.

- **Hushh is building on top of Hermes (Nous Research's agent), not a fully custom agent core.** Kushal has personally open-sourced a new project, **hussh-one-hermes**, framed as: Hermes is already a stable, trusted personal agent, and Hushh's job is the *private layer* on top of it, delivered through the protocol. This is a step further than the earlier "Hermes = router only" framing — Hermes itself is now the product's agent foundation, not just a front-door router.
- **Vault connection is native, not MCP.** The Agent One app's vault is connected directly into hussh-one-hermes. Kushal's explicit framing of MCP's role: it's for *external* AI agents requesting consent/real-time info from the user — that's where he sees the monetizable value, not for Hushh's own internal vault-to-agent wiring.
- **Private Cloud Compute (PCC)**: users attach their own cloud or get a Hushh-deployed POD on a governed platform. Burst/surge capacity is handled via a "private relay" — cloud-run-style services, explicitly NOT dedicated always-on VMs per user (called out as too costly to run full Hermes VMs per user).
- **Long-term monetization vision**: give users control so their own data becomes an accessible, monetizable asset to external "hungry" agents that need context to complete real business transactions — user data framed explicitly as a consumer asset. Reference standards: **AP2 (Agent Payments Protocol)** and **UCP** (`ucp.dev/documentation/ucp-and-ap2`).
- **On-device vs. cloud for the Hermes brain is explicitly still undecided** (Kushal's own words: "I have still not decided if that's better") — this is a live open question, not settled. Current mental model: Agent One's AI agents run on ADK, in the cloud. He's weighing that against just consuming Hermes's fast-improving upstream directly while maintaining privacy via Hushh's own layer, rather than trying to host/run Hermes itself on-device.
- **Company positioning**: hushh.ai is going into "the business of supercomputing," with on-device inference as a key part of that — Kushal cited recent Stanford AI summit exhibiting as strong external validation for this direction.
- **Practical implication for GenieX/on-device work**: Kushal did not confirm GenieX↔Hermes integration when Parth raised it — redirected to "first thoroughly go through the hussh-one-hermes onboarding" before assuming compatibility.

**Resolved from the two links Kushal sent (checked 2026-08-03), which name the vague pieces above concretely:**
- **"PCC" / "your own POD" = Puppy One**, a real named product on hushh.ai: "a personal supercomputer enabling both local device processing and distributed computing that generates income during idle periods" — a grid where idle personal supercomputers serve a neighborhood network for compensation. This is the actual implementation of the "private relay / cloud burst" mechanism Kushal described informally.
- **Agent One** (also on hushh.ai) is confirmed as the public name for the vault-holding personal-AI app whose vault is now natively wired into hussh-one-hermes.
- **AP2/UCP mechanics** (from ucp.dev/documentation/ucp-and-ap2): UCP standardizes commerce transactions; AP2 is a trust layer on top for *agent-led* transactions, removing the need for a middleman "trust referee." Flow: merchant signs a `CheckoutMandate` (transaction hash) → platform issues a `PaymentMandate` (signed SD-JWT) only after user consent → mandate is scoped to that exact checkout hash (no replay/amount tampering). Read together with Kushal's MCP framing, the intended stack is: **MCP grants an external agent consent to access a user's context → AP2/UCP is how that agent then pays the user for it** — two distinct protocol layers, consent vs. payment, not one mechanism doing both.
- Site tagline directly echoes Kushal's monetization pitch: "Your information is your business and your asset, from day one... nothing sold" — confirms this is stated company positioning, not just Kushal's personal framing.

**How to apply (updated)**: When PCC/POD comes up again, call it by its real name, Puppy One. When MCP vs. AP2/UCP comes up, keep them as separate layers (consent-granting vs. payment-settling) rather than conflating.

**How to apply**: Treat "Hermes = router only, decided" from the 2026-07-15 entry as no longer settled — the co-founder himself frames on-device-vs-cloud as open. Before proposing on-device/local-bridge architecture work, check whether it should route through hussh-one-hermes's own onboarding path first rather than the desktop-local GenieX bridge in isolation. When discussing monetization or external-agent access patterns, MCP is the consent/external-agent surface — don't conflate it with Hushh's own internal vault wiring, which is native.
```

## `project_hushh_desktop_backend_split.md`

```markdown
---
name: project_hushh_desktop_backend_split
description: Future architecture idea -- split local orchestration from a remotely-hosted backend to stop shipping production secrets in the desktop installer
metadata: 
  node_type: memory
  type: project
  originSessionId: bd167d0b-4bdf-43f4-9f6a-00a5fbd619e3
---

Hushh Desktop currently bundles `backend/.env` and `frontend/.env*` into every installer build (`hushh-desktop/package.json` `build.files`), with `asar: false`. These files carry live secrets: DB password, Firebase admin creds, Google private key, Alpaca/Plaid broker secrets, Gmail OAuth client secret, OpenAI key, vault/signing keys. Currently acceptable because the user is running this solo for a company evaluation (not distributed to other users yet), but not viable once/if the project gets selected and ships to real users.

Proposed future direction (explicitly deferred, not being built now — "that's far-fetched, rn main focus is on-device AI functionalities"): split the backend into (1) a thin local orchestration service that only talks to GenieX (`localhost:18181`) and assembles chat context — needs none of the sensitive integration secrets — and (2) the full FastAPI backend hosted remotely (the same one that would serve the webapp), holding all trading/broker/Gmail/DB/Firebase credentials server-side only.

**Why:** GenieX only binds to `localhost` on the user's machine, so a remote backend can never reach it directly — the on-device chat orchestration is structurally forced to stay local no matter what. This means "just move the whole backend remote" isn't viable as a single step; it has to be a split. Splitting also shrinks the local install's footprint (ties into [[project_hushh_desktop_beta]] RAM/perf concerns) since the local half wouldn't need most of the current `.env`.

**How to apply:** Don't suggest shipping the desktop app to other users, or building out true multi-tenant secret handling, until this split (or an equivalent) is decided and built. Revisit this note when the company conversation about adoption progresses, or before any external beta distribution.
```

## `project_hushh_desktop_beta.md`

```markdown
---
name: project-hushh-desktop-beta
description: "Hushh Desktop beta-v1.4/1.5 is mid-flight (hybrid local AI inference); commit hold was lifted 2026-07-18, normal commit rules apply"
metadata: 
  node_type: memory
  type: project
  originSessionId: bd167d0b-4bdf-43f4-9f6a-00a5fbd619e3
  modified: 2026-07-29T03:03:23.127Z
---

`hushh-desktop` is on branch `feature/desktop-beta-v1.4`, building toward a beta release focused on native local-LLM inference (hybrid GenieX setup: Qwen3-4B for chat replies, Llama-3.2-1B for tool-calling classification). Alpha (`desktop-alpha-v0.1.0`, 2026-06-30) already shipped as a portable Windows ARM64 ZIP.

**2026-07-03 note (historical):** at that point there was a large uncommitted working-tree diff and the user said "once the beta is functional, we will commit, hold on till then" — commits were on hold.

**2026-07-18 update:** that hold is lifted. The user explicitly said "commit this" after confirming a round of fixes worked live (DB connection-pool starvation causing app-wide stalls — see [[project_hushh_desktop_db_pool_starvation]] — plus a Firebase Admin init race, an event-loop-blocking auth call, PKM's dead model name, staggered local-model warm-up, and teal/blue/green glow theming). Four commits landed on `feature/desktop-beta-v1.4`, and `package.json`'s version was bumped to `1.5.0` per the user's request ("name this beta 1.5").

**How to apply:** The default is no longer "hold all commits" — normal commit-on-explicit-request behavior applies now. Still always confirm before committing per the general safety guidance (don't commit unprompted), but don't assume a blanket hold is in effect unless the user says so again. See [[feedback_scope_hushh_desktop]] for the directory-scope constraint that still applies, and [[feedback_no_ai_attribution_in_commits]] for this repo's DCO signoff convention.

**2026-07-28 update:** Beta 1.4.1 was demoed to the founder on 2026-07-27 and didn't land — see [[project_hushh_desktop_founder_demo_feedback]] for the full reaction (wants real agents not chatbots, major UI/UX overhaul, dogfood-test every feature). The user confirmed the resulting overhaul work is versioned as **Beta 1.5** — this is a real, explicit version target, not just a working label. When bumping `package.json`/commit history/PR titles for this cycle, use 1.5.x.

**2026-07-29 update — live demo-prep + trial run imminent:** Beta 1.5's three planned surfaces shipped and were live-tested by the user in the same session: Market Watch (`OneWindows.Daemon` background poller + dashboard card), Memory Highlights (PKM auto-capture surfaced as a clean Gemini-written sentence, replacing raw fragments), and a Spotlight panel (synthetic NVDA price chart + Gemini present-tense commentary, added mid-session per user's "visual representation" ask). A synthetic Schwab portfolio statement (10 holdings, +15.56%) was fabricated and imported as demo data with the user's explicit sign-off, since real market-data provider keys (Finnhub/FMP) are still placeholders. Portfolio Optimize was also exercised live and had a real, now-fixed bug (see below).

Two real live bugs were found and fixed this session, both demo-blocking:
1. `backend/api/routes/kai/losers.py`'s Gemini `response_schema` for `/portfolio/analyze-losers/stream` had `losers`/`portfolio_level_takeaways` typed `ARRAY` with no `items` sub-schema — Vertex AI rejected the request outright (400). Fixed by fully specifying the schema to match the endpoint's documented prompt output shape (was previously only patched minimally, which fixed the crash but left `summary.health_reasons`/`analytics.health_radar` silently empty since those nested objects had no declared properties either — Vertex gives the model zero structural guidance for undeclared nested fields).
2. `pkm_highlight.py` and `portfolio_insight.py` (the two new Gemini-summarization endpoints backing Memory Highlights and Spotlight) were both calling `gemini-2.5-flash-lite`, which turned out to be retired from this Vertex project/region — silently 404ing and falling back to plain template text all evening. Swapped both to `gemini-3.1-flash-lite` (the project's actively-registered lite model per `runtime_providers/registry.py`) and directly verified the call succeeds.

An audit of every other `response_schema` block in the backend found no other instance of the missing-`items` bug. A **founder demo trial-run script** was written and published as a Claude artifact (beat-by-beat walkthrough, talking points, honest limitations section) — see the session transcript for the URL, or ask to regenerate/relocate it if the link has gone stale. See [[project_hushh_desktop_db_pool_starvation]] for a related, unfixed (flagged-only) DB connection-pool contention issue found live during this same session, and [[feedback_cold_restarts]] for the restart discipline adopted mid-session. Nothing from tonight's fixes has been committed — normal commit-on-explicit-request rules still apply, this was live hot-fixing during an active demo-prep session.
```

## `project_hushh_desktop_db_pool_starvation.md`

```markdown
---
name: project-hushh-desktop-db-pool-starvation
description: "Root cause of hushh-desktop's 'stuck loading' symptom was DB connection-pool starvation, not RAM/DNS/thermal issues"
metadata:
  type: project
  originSessionId: bd167d0b-4bdf-43f4-9f6a-00a5fbd619e3
  modified: 2026-07-29T03:02:52.962Z
---

`hushh-desktop`'s recurring "stuck loading chat history" / broad multi-endpoint slowness (persona, consent/center/summary, account/identity/refresh, PKM metadata/upgrade-status all taking 20-55s each in the same startup burst) was ultimately traced to **database connection-pool starvation**, confirmed fixed and verified live by the user ("nice, its gone").

Two compounding misconfigurations in `hushh-desktop/backend/.env`:
1. `DB_SQLALCHEMY_USE_NULL_POOL=1` — forced the sync SQLAlchemy engine (`db/db_client.py`) to open a brand-new TCP+SSL connection to the Supabase host (`aws-1-ap-northeast-1.pooler.supabase.com`, Tokyo — cross-region from the user) for literally every query, no reuse.
2. `DB_POOL_MAX_SIZE` was unset, so the separate asyncpg pool (`db/connection.py`) defaulted to only 2 max connections app-wide — while the app fires ~10 concurrent DB-bound requests on every page load/navigation.

Fixed by setting in `.env`: `DB_SQLALCHEMY_USE_NULL_POOL=0`, `DB_SQLALCHEMY_POOL_SIZE=5`, `DB_SQLALCHEMY_MAX_OVERFLOW=10`, `DB_POOL_MAX_SIZE=10`. Requires a full backend restart to take effect (`.env` is only read at process start).

**Why this matters:** this session chased several wrong theories first for a related-but-distinct slowness investigation earlier in the same window — disk/memory bandwidth, thermal/power throttling, ARM emulation overhead, RAM saturation (that one was real, for a *different* symptom: broad OS-level paging from the local-model dual-warmup). The DB pool issue is a separate, simpler, and more fundamental cause specifically for endpoints that touch Postgres. Two earlier fixes this session (Firebase Admin race-condition lock, `run_in_threadpool` for the blocking `firebase_admin.get_user()` call) were real bugs but did NOT fully explain the slowness — this pool config was the missing piece.

**How to apply:** If "stuck loading" / broad multi-endpoint slowness recurs in hushh-desktop, check `backend/.env`'s `DB_SQLALCHEMY_USE_NULL_POOL` and `DB_POOL_MAX_SIZE` FIRST, before re-investigating RAM/DNS/CPU throttling theories — those are real phenomena but were not the cause of this particular symptom pattern (many unrelated endpoints all stalling in the same 20-55s range within one burst is the signature of pool queuing, not per-endpoint inefficiency or system-wide resource pressure).

**Update, 2026-07-29 (live during Beta 1.5 demo-prep testing):** the aggressive 5/10/10 values above are no longer live — `backend/.env` now runs the more conservative `DB_SQLALCHEMY_POOL_SIZE=3` / `DB_SQLALCHEMY_MAX_OVERFLOW=4` / `DB_POOL_MAX_SIZE=8` (sync max 7 + async max 8 = 15, deliberately at Supabase's session-pooler hard ceiling per the comment in `db_client.py`). Even at that ceiling, the pool still saturates under real concurrent load: firing portfolio import + Market Watch pairing + ticker sync + several PKM domain reads/writes within the same few seconds produced `/api/pkm/store-domain` calls taking 140s and 152s (still succeeded, just past the frontend's 90s client timeout, surfacing as a "please retry" error to the user), and separately a live `psycopg2.OperationalError: FATAL: max clients reached in session mode - max clients are limited to pool_size: 15` from `gmail_receipts_service`'s background scheduler. Backend was idle and fast (sub-5ms) again within seconds each time — this is real contention under concurrent bursts, not a crash or leak. Not re-tuned tonight (too risky to touch pool sizing unsupervised right before a founder demo); the practical mitigation used instead was behavioral — don't stack multiple heavy DB-touching actions within the same few seconds during the live demo. See [[project_hushh_desktop_founder_demo_feedback]] for the demo this applies to.
```

## `project_hushh_desktop_founder_demo_feedback.md`

```markdown
---
name: project_hushh_desktop_founder_demo_feedback
description: Founder reaction to the Beta 1.4.1 demo (2026-07-27) — on-device chatbot didn't land, wants real agents not chatbots, UI/UX needs a major pass, dogfooding is the bar
metadata:
  node_type: memory
  type: project
  originSessionId: bd167d0b-4bdf-43f4-9f6a-00a5fbd619e3
  modified: 2026-07-28T17:53:01.064Z
---

Parth demoed Hushh Desktop (Beta 1.4.1) to the founder on 2026-07-27. Reaction: "kind of impressed but it didn't cut it." Three specific problems raised, in the founder's own framing:

1. **The on-device chatbot itself isn't the win.** Technically solid, but not compelling on its own. Founder explicitly cited a concrete example of what he *does* want: an agent that tells you your screen time or productivity hours. General direction: build things people would actually use day to day, not a demo of "we got a local LLM running."
2. **UI/UX is majorly unfinished.** Alpha's original design decision was to mirror the web app's UI exactly ("no relearning," see the Alpha milestone in the engineering review) — the founder is pushing back on that as insufficient for a native desktop product; he wants genuinely good, polished UI, not a reskinned webapp.
3. **"We need to build agents, not chatbots."** Parth wasn't fully sure how far to take this, but the founder's own words. This does NOT mean ripping out the LLM/chat entirely — chat/LLM can still be used internally (e.g. generating summaries, powering something "fascinating" under the hood) but must not be the product's primary surface or identity. The product should be agents that *do* things autonomously/usefully, with chat as an implementation detail at most.

**The bar the founder set, verbatim in spirit:** "Do I use, or will I use, the product I build — because if I won't, why would anyone else?" Dogfooding is the explicit litmus test, not technical impressiveness.

**Why this matters:** This reframes the whole desktop roadmap. All the on-device inference work through Beta 1.4.1 (GenieX hybrid model, local bridge, tool-calling, DB pool fix, etc. — see [[project_hushh_desktop_beta]]) was necessary infrastructure but is NOT itself the product. The product still to be built is: concrete, narrow agent use-cases on top of that infra (screen-time/productivity tracking is the founder's own example), a real UI/UX overhaul, and a personal-dogfooding filter on every feature choice.

**How to apply:** Before proposing or building any new hushh-desktop feature, run it through: (a) would Parth actually use this every day, not just demo it once, (b) is this an agent quietly doing/tracking/deciding something useful, or just another chat surface, (c) does the UI look and feel like a real native desktop product, not a ported webapp page. This supersedes purely infra-focused framing in [[project_hushh_agent_roadmap]] for prioritization purposes (the agent-ontology/DNA-model pattern there still applies to *how* agents get built, just not to *what* gets built first). Treat this feedback as the current top-priority lens for all hushh-desktop roadmap work until superseded.
```

## `project_hushh_research_location_state_db_load.md`

```markdown
---
name: hushh-research-location-state-db-load
description: "/api/one/location/state and /api/consent/center/summary hammer the DB pool (26-47s+ per call) and starve concurrent work, including voice tool calls"
metadata: 
  node_type: memory
  type: project
  originSessionId: bd167d0b-4bdf-43f4-9f6a-00a5fbd619e3
  modified: 2026-08-11T00:06:56.129Z
---

In `hushh-research`, `/api/one/location/state` consistently issues ~23 SQL queries per call (budget is 4) taking 26-36s each, and `/api/consent/center/summary` issues ~77 SQL queries taking 37-47s+ with 20s+ of DB pool wait. Both fire repeatedly/frequently while the One app is open, and since they share the process's DB connection pool, they starve every other concurrent request — including voice-agent tool calls that need DB access (e.g. a stock-analysis turn hung and the voice session died mid-call, which initially looked like a voice bug but traced to this).

**Why:** discovered 2026-08-07 while live-testing voice fixes in the `hushh-voice-bugfix` worktree — a "voice crashed" report turned out to be this starvation, not the voice code. Shape matches [[hushh-desktop-beta]]'s DB pool starvation note (NullPool→QueuePool fix) but is a different root cause here (query volume/N+1, not pool sizing) and is specific to `hushh-research`, not `hushh-desktop`.

**How to apply:** before chasing a "stuck loading" / timeout / hung-request symptom anywhere in `hushh-research` (voice or otherwise), check whether `/api/one/location/state` or `/api/consent/center/summary` are mid-flight and slow in the backend log first. User explicitly deferred fixing this (2026-08-07) — do not proactively fix it, just recognize the pattern quickly if it recurs and ask before spending time on it.

**Correction, 2026-08-11 (Parth: "yk we use cloudsql now"):** the DB is **Cloud SQL**, not Supabase. `consent-protocol/.env` has `CLOUDSQL_INSTANCE_CONNECTION_NAME=hushh-pda-uat:us-central1:hushh-uat-pg` with the auth proxy on `127.0.0.1:6543` (`DB_HOST`/`DB_PORT`), i.e. the UAT project per [[reference_gcp_projects]]. Supabase only survives in `.env.example`. This changes the arithmetic: every query is a round trip from India to **us-central1**, so the 26-query `location/state` at ~900ms/query is dominated by RTT, not query cost — **the fix is reducing query COUNT, not optimizing queries**, and the Supabase session-pooler ceiling of 15 clients from [[project_hushh_desktop_db_pool_starvation]] does NOT apply here. Also: every backend restart costs a fresh cross-continent TLS reconnect storm — restarts throw ~11.6s `asyncpg` connect `TimeoutError`s (500s on `/api/account/identity/refresh`, `/api/iam/persona`) at whatever page the user has open, then recover. Don't read those as new bugs, and don't restart while the user is mid-test.
```

## `project_hushh_research_main_migration.md`

```markdown
---
name: project_hushh_research_main_migration
description: Parth is now hired; active task queue is (1) migrate Sage into hushh-research's main branch (new UI, diverged from pr-train), (2) later adopt that codebase into hushh-desktop; on-device AI work is on hold
metadata:
  node_type: memory
  type: project
  originSessionId: bd167d0b-4bdf-43f4-9f6a-00a5fbd619e3
  modified: 2026-08-06T00:45:33.160Z
---

Parth got the job (confirmed 2026-08-06). With that comes a new task queue for `hushh-research`, stated directly:

1. **Task 1 (ACTIVE, current focus)**: migrate the Sage research agent into `hushh-research`'s **`main`** branch — not `integration/pr-train`, which is where the original webapp port ([[project_hushh_agent_roadmap]]-adjacent work, PR #4771) was built and opened. Parth has heard `main` "has new UI and stuff" — it's known from earlier in this engagement to have diverged from `pr-train` (Cloud SQL migration `78aaa1e4b`, a `mutation_plan` write-confirmation gate `pr-train` lacks, and general drift since `pr-train` was dated 2026-07-15 vs `main` at 2026-08-01). The actual current shape of `main`'s UI/PKM/write-coordinator code has not yet been re-verified as of this memory being written — treat as needing fresh investigation, not assumed to match either `pr-train` or the original hushh-desktop source.
2. **Task 2 (DEFERRED, do only after Task 1)**: adopt `main`'s new codebase into `hushh-desktop`, adjusting/fixing whatever breaks from the sync. This directly overrides [[feedback_scope_hushh_desktop]]'s default "hushh-desktop only" scope restriction for the current period — Task 1 lives in `hushh-webapp` + `consent-protocol` on `main`, not `hushh-desktop`, and that's correct, expected scope right now, not a violation of the standing rule.
3. **On-device AI work is explicitly on hold.** Parth's own reasoning: shipping true on-device inference means building/maintaining it per-platform (Mac, iPhone, Android, Windows, etc.) — "a nightmare" — so it's parked until further notice. Don't propose on-device/GenieX/Hermes-local work as part of the current task list; [[project_hushh_agent_roadmap]]'s Hermes-context work is background/roadmap knowledge only right now, not active work.

**Open question as of this memory**: the existing PR #4771 (`feature/sage-webapp-port` → `integration/pr-train`) was built against `pr-train`, not `main`. Whether that work is rebased/redirected onto `main`, superseded by a fresh port, or left standing as a separate parallel track has not yet been decided with Parth — confirm before assuming either path. Also see [[feedback_heightened_repo_access_no_push]]: any GitHub-side action on that PR (closing, redirecting, etc.) needs explicit sign-off now.

**How to apply**: Before starting Sage-in-`main` work, fetch and read the actual current `main` branch state (routes, dashboard, PKM write-coordinator, domain contracts) rather than assuming it matches the `pr-train` port already done — the whole premise of Task 1 is that `main` has moved. Keep hushh-desktop work (Task 2) out of scope until Task 1 is confirmed done. Do not touch on-device/GenieX/Hermes work unless Parth explicitly reopens it.
```

## `project_hushh_research_push_target.md`

```markdown
---
name: project_hushh_research_push_target
description: "In hushh-research, the fork (origin/parthmawai) is abandoned — push branches to upstream (hushh-labs) and target main + UAT, never the fork"
metadata: 
  node_type: memory
  type: project
  originSessionId: bd167d0b-4bdf-43f4-9f6a-00a5fbd619e3
  modified: 2026-08-09T13:03:35.486Z
---

As of 2026-08-09 Parth's personal fork of `hushh-research` is **abandoned** — do not push to it. His words: "do not push to my fork, remember and store in your memory to leave my fork behind, we now push to main and uat."

In the `hushh-voice-bugfix` worktree the remotes are:
- `origin` → `https://github.com/parthmawai/hushh-research.git` (the fork — **dead, do not push**; its `main` was ~6 weeks stale on 2026-08-09)
- `upstream` → `https://github.com/hushh-labs/hushh-research.git` (the real repo — this is the target)

**Why:** post-hire he works directly in the org repo, so the fork is vestigial. It also actively misleads: comparing a branch against the stale `origin/main` reported 1891 commits ahead when the true count against `upstream/main` was 28. Any "how far ahead is this branch" question must be measured against `upstream/main`, never `origin/main`. `feature/sage-main-port` appearing as a plausible base was purely an artifact of that stale ref — see [[project_hushh_research_main_migration]].

**How to apply:** Push branches to `upstream` and open PRs against `hushh-labs/hushh-research` `main`; deploy to UAT (`hushh-pda-uat`, see [[reference_gcp_projects]]). Always `git fetch upstream main` before reporting divergence. The per-instance go-ahead rule in [[feedback_heightened_repo_access_no_push]] still applies to every push and PR state change — a bigger blast radius now that the target is the org repo, not a fork.
```

## `reference_gcp_projects.md`

```markdown
---
name: reference_gcp_projects
description: GCP project IDs for consent-protocol (hushh-research backend) — prod vs UAT, and which one to default to for dev/local work
metadata:
  node_type: memory
  type: reference
  originSessionId: bd167d0b-4bdf-43f4-9f6a-00a5fbd619e3
  modified: 2026-08-06T01:34:31.256Z
---

Parth got GCP access for `hushh-research`'s backend (`consent-protocol`) as part of his new hire access, alongside the GitHub heightened access (see [[feedback_heightened_repo_access_no_push]]). Two projects exist:

- **`hushh-pda`** — "consent-protocol prod"
- **`hushh-pda-uat`** — "consent-protocol uat"

Parth's explicit instruction (2026-08-06): use the **UAT project (`hushh-pda-uat`)** by default going forward, not prod.

**How to apply:** When setting up `.env`/service-account credentials, `GOOGLE_CLOUD_PROJECT`, Vertex AI region/project config, or any GCP-backed local dev/testing for `consent-protocol` (including Sage's Gemini calls — see [[project_hushh_research_main_migration]]), point at `hushh-pda-uat` unless Parth explicitly says to use prod for a specific reason. Never default to `hushh-pda` for routine dev/test work.
```

