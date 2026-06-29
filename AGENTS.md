# Hussh Codex Operating Rules

These repo-level instructions supplement the active Codex system/developer instructions. Follow the more specific instruction when there is a conflict.

## Project-Wide Runtime Telemetry Default

When a coding agent runs the local server, run it IN the agent's own terminal session (in-process / background terminal) by default, so the agent streams live logs, errors, and telemetry directly and can act on them. Do NOT default to the visible-OS-terminal wrapper (`./bin/hushh terminal ...`) for agent-driven runs — that detaches the logs from the agent.

- Agent default = THREE separate in-session terminals, one component each (there is no combined `stack` command): `./bin/hushh proxy --mode local`, then `./bin/hushh backend --mode local --reload`, then `./bin/hushh web --mode local`. Run each as a background/async terminal so the agent keeps working while tailing per-component telemetry.
- Native restart: rely on backend `--reload` hot-restart first; for a full restart, stop only the affected agent-managed terminal, confirm its port is free (`lsof -ti :6543` proxy / `:8000` backend / `:3000` frontend empty), relaunch that in-session command, and verify health (`./bin/hushh doctor --mode local`, web origin, backend `/docs`) before claiming success.
- Use the visible-OS-terminal wrapper only when the developer explicitly wants to watch logs themselves, or for a detached session the agent does not need to read.

Full playbook in `.codex/skills/repo-operations/references/branch-runtime-ops.md` ("Runtime Terminals" / "Native restart playbook").

## Project-Wide Premise Verification Gate

Before accepting a premise, drafting a reply, proposing a plan, patching code, reviewing a PR, or merging work, run a quick repo-backed premise check.

This applies to every non-trivial Codex task in this repo. The goal is to prevent drift where Codex agrees with a user or contributor claim that the repo already contradicts.

The canonical shared contract lives at `.codex/skills/codex-skill-authoring/references/truth-first-operating-kernel.md`. Use that file as the source of truth for claim labels, evidence order, domain probes, and agent handoff shape.

Use this sequence:

1. Extract the concrete claims from the prompt, especially statements like `missing`, `not implemented`, `new`, `dynamic`, `static`, `always`, `never`, `broken`, `safe`, `duplicate`, or `ready`.
2. Check the current source of truth before responding:
   - code paths
   - generated contracts
   - docs and future-state caveats
   - schemas and migrations
   - tests
   - runtime logs or CI when relevant
3. Classify each important claim as:
   - `already_exists`
   - `partially_exists`
   - `missing`
   - `future_state_only`
   - `wrong_direction`
   - `needs_verification`
4. Respond or act from that classification, not from conversational agreement.
5. If the premise is wrong, say so directly and replace it with the correct boundary.
6. If the capability already exists, do not propose a parallel path. Extend or harden the existing contract.
7. If the capability exists only transiently, name the real gap: persistence, visibility, tests, UX, docs, schema, consent, cache, or observability.
8. For high-risk surfaces such as auth, consent, vault, PKM, finance recommendations, generated action contracts, migrations, deploys, and external integrations, verify twice from independent evidence when feasible.

Default response shape for repo-backed Q&A:

1. `Correction / current truth`
2. `Useful contribution boundary`
3. `Where it should live`
4. `What not to build`
5. `Smallest acceptable next PR`

For non-trivial planning, questions must be research-backed instead of bare choices. Before asking, state the `Current truth`, `Recommended path`, `Risk if accepted blindly`, and the exact `Decision needed`; put the recommended option first. Do not ask the user to discover facts Codex can verify from repo, GitHub, CI, docs, runtime logs, or generated contracts.

Do not write as if the project is blank. Hussh already has many shipped contracts. Codex must actively find and reuse them.

## Project-Wide Routing Gate

Operate with a router mentality on every non-trivial request. Before writing code, answering, or delegating, detect intent and route to the owning contract first. Guessing the lane is the largest accuracy leak in this repo, so routing precedes implementation and precedes delegation.

The routing source of truth is the `.codex/` tree, composed exactly the way `./bin/hushh codex route-task` and the `codex-bridge` skill compose it: `workflow` then `owner_skill` plus `default_spoke`, unioned across `required_reads`, `required_commands`, `handoff_chain`, `verification_bundle`, and `risk_tags`. Skills are owners and spokes, workflows compose owner plus spoke, and `.codex/agents/*` are advisory delegation lanes, never the first winner.

Run this detection sequence:

1. Extract the intent and the concrete surfaces the request touches: paths, domains (consent, vault, PKM, Kai, Nav, MCP, IAM, backend, frontend, mobile, docs, comms, ops, analytics, security), and risk tags.
2. Map intent to the owning contract in priority order:
   - prefer a matching `workflow` over a bare skill, because workflows already compose owner plus spoke
   - prefer the `default_spoke` over the `owner_skill` when both match the narrower surface
   - fall back to the closest `owner_skill` only when no workflow or spoke fits
3. Resolve ambiguity deterministically. When multiple skills score close, pick the spoke over the owner and the workflow over the bare skill. Do not improvise a blended lane.
4. Read first. Open every composed `required_reads` entry before touching code, then follow the routed Workflow or Playbook section verbatim. That is the path the repo already decided works.
5. Detect delegation lanes from the same routing pass, not as an afterthought. When intent or changed paths are not obvious, run the delegation router to surface specialist lanes:

```bash
python3 .codex/skills/agent-orchestration-governance/scripts/delegation_router.py --workflow <workflow-id> --phase start --prompt "<user request>" --paths "<comma-separated paths>" --text
```

6. Hand off on drift. If the work expands past the routed scope, stop and re-route to the next entry in `handoff_chain` instead of stretching the current lane.
7. Re-route mid-task when new evidence changes the surface, such as discovering a trust boundary, a generated contract, a schema migration, a duplicate runtime, or a cross-surface caller mismatch.

Routing accuracy rules:

- Never skip routing because the task feels familiar. Familiarity is the most common cause of landing in the wrong spoke.
- Never invent a parallel skill, workflow, or agent. If the lane seems missing, classify it with the premise gate (`already_exists`, `partially_exists`, `missing`) and confirm against the `.codex/` tree before proposing anything new.
- Keep routing and delegation as one decision. The lane you route to is the lane you delegate to or execute in, so the owner skill, the verification bundle, and any spawned agent stay aligned.
- State the routed lane briefly for non-trivial work, for example: `Routed: workflow new-feature-tri-flow (owner frontend-architecture, spoke frontend-design-system).`

## Project-Wide Delegation Checkpoint

At the start of every non-trivial request, run a quick delegation suitability checkpoint as the second half of the routing pass above, before choosing a local-only path. Routing picks the lane; this checkpoint decides whether that lane runs in the parent session or in a read-only subagent.

This applies to every non-trivial Codex task in this repo, not only PR governance. Repo workflows inherit a global read-only evidence-lane policy unless a workflow explicitly opts out. For high-stakes PR governance, RCA, release readiness, security/consent review, cross-surface runtime work, schema/migration review, docs/founder-language work, voice/action-runtime work, analytics/observability work, mobile/native work, or frontend/backend contract work, use read-only evidence subagents when the suitability checkpoint passes. This is not optional ceremony: if a specialist agent can materially reduce drift or hallucination without blocking the parent, spawn it and record the lane.

Use the repo delegation router when the intent or changed paths are not obvious:

```bash
python3 .codex/skills/agent-orchestration-governance/scripts/delegation_router.py --workflow <workflow-id> --phase start --prompt "<user request>" --paths "<comma-separated paths>" --text
```

Delegation threshold is intentionally low for non-trivial work: if the router finds a concrete specialist evidence lane from the prompt or touched paths, prefer spawning that read-only lane unless the task is small, immediately blocked, or the runtime does not expose the role.

Standing Delegation Default (repo-wide directive): read-only, parallel evidence delegation is pre-authorized for every non-trivial multi-lane task in this repo. Treat it as the default operating mode, not an exception that needs fresh per-task permission. When a request touches two or more independent evidence surfaces (for example backend contracts plus frontend callers, or runtime plus tests plus docs), spawn read-only evidence subagents in parallel by default and keep the parent session driving the critical path. Run independent read-only lanes concurrently rather than serially. Only fall back to a local-only path when one of the explicit "keep the work local" conditions below holds. This standing allowance covers read-only evidence work only; it never authorizes writes, approvals, merges, deploys, branch changes, or secret handling, which always stay local unless the user explicitly requests worker-style delegation with a disjoint write set.

Use subagents when all of these are true:

1. The task is non-trivial and read-only evidence work is in scope (the Standing Delegation Default above already supplies the allowance; explicit per-task permission is not required for read-only lanes, and any user request for parallel/subagent work or an approved repo workflow delegation step reinforces it).
2. The task can be split into independent evidence lanes, such as backend contracts, frontend callers, CI/deploy, security/consent, tests, docs, or RCA.
3. The next parent action is not blocked on the delegated result.
4. The parent session can keep working on non-overlapping work while subagents inspect evidence.
5. Final authority remains with the parent session or the repo `governor`; subagents return evidence, not final merge/deploy/approval decisions.

Keep the work local when any of these are true:

1. The task is small, single-surface, or faster to verify directly.
2. The next action depends immediately on the result.
3. The task involves branch switching, approval, merge, deploy, credential handling, or secrets (these are never delegated under the Standing Delegation Default).
4. Parallel agents would duplicate effort or create inconsistent assumptions, or the lanes are not actually independent.
5. The user has explicitly asked you to keep the work in the current session.

For high-stakes or batch workflows, state the delegation decision briefly in the response or working report. Example: `Subagent checkpoint: not delegated because the batch is low-risk, non-overlapping, and faster to verify locally.`

When spawning repo-scoped specialist agents, use at least high reasoning. Use extra-high reasoning for governor synthesis, reviewer regression review, security/consent/vault audits, and voice/action-runtime audits. Keep agents read-only unless the user explicitly requests worker-style code changes with a disjoint write set.

Re-run the checkpoint mid-execution when new evidence changes the shape of the task, such as discovering a trust boundary, schema migration, generated contract, deploy surface, duplicate runtime, active requested-changes review, or cross-surface caller mismatch.

Keep the repo-scoped fleet curated. The target is a small set of broad evidence lanes, not one agent per skill. Add a new agent only when repeated misses show a high-risk evidence family needs its own specialist authority, and validate that change with the agent fleet audit.

## Authority Boundary

Subagents improve evidence quality; they do not replace repo skills, workflow checks, or parent-session judgment.

1. Use repo skills first to choose the owner lane.
2. Delegate only concrete, bounded sidecar tasks.
3. Do not delegate final approval, merge, deploy, branch authority, or release recommendations.
4. Require delegated handoffs to include claim inspected, classification, evidence checked, current repo truth, real gap, suggested boundary, blind-acceptance risk, scope, inspected surfaces, assumptions, validations, and unresolved risks.

## Project-Wide Branch Discipline Gate (HARD RULE)

This is a hard, non-negotiable rule for every Codex/agent task in this repo. It exists because agents have repeatedly drifted: auto-creating branches, leaving the developer parked on a stray branch, and leaving temp branches uncleaned. Do not repeat this.

1. Record the developer's active branch at the start of any branch, CI, PR, merge, deploy, or validation work, and treat it as the branch you MUST return to.
2. NEVER create a new branch for follow-up, continuation, "phase N", "it felt cleaner", or ship-convenience reasons without either (a) an explicit user request for a new branch, or (b) a genuine isolation need (an isolated `main` hotfix, or unrelated unsafe in-flight work). When in doubt, continue on the existing development branch and cherry-pick across named existing branches.
3. NEVER end a task with the developer parked on a different branch than where they started, unless they explicitly asked for that final state. If branch switching happened during the task, switch back to the developer's branch before handoff and state that you did.
4. ALWAYS delete temporary branches you created (local AND remote) once the work is safely preserved on the kept branches. Before deleting, verify every unique piece (commits/files) is represented on a branch you are keeping; only then delete. Close any throwaway PR opened from that temp branch.
5. After cleanup, leave the tree clean: developer on their branch, no stray local temp branches, no stray remote temp branches, no dangling throwaway PRs. State the final branch and what was cleaned.
6. If you discover a stray branch you created earlier, self-correct: move its real commits onto the correct existing branch(es), delete the stray (local and remote if pushed-but-unmerged), and report the correction.

This gate is enforced by judgment, not just docs: violating it (auto-branching, abandoning the developer on a stray branch, or leaving temp branches behind) is a defect to be corrected immediately, not an acceptable shortcut.
