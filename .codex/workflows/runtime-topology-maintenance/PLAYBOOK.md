# Runtime Topology Maintenance

Use this workflow to keep the project's structural context fresh as routes,
semantic workspaces, agents, database families, or compatibility surfaces move.

## Boundary

This is an engineering-maintenance workflow. It is not a runtime product agent,
does not receive user information or credentials, does not select product
actions, and does not mutate databases, routes, or compatibility surfaces by
itself. One remains the only user-facing semantic router.

## Procedure

1. Run the topology generator in check mode before trusting a map.
2. Select one or more declared maintenance profiles. Profiles are deterministic
   coverage bundles for product personas, not new runtime personas.
3. Use the profile's existing read-only evidence lanes. The parent/governor
   synthesizes their evidence; subagents never approve a merge, deployment, or
   destructive migration.
4. Correct authored sources, then regenerate the affected projection. Do not
   hand-edit `contracts/`.
5. Treat `decision_required` findings as explicit owner decisions. A reported
   overdue API sunset or pending table retirement is current truth, not a green
   signal to silently remove it.
6. Run the workflow verification bundle and update the canonical architecture
   reference in the same change when the topology changes.

## Profile selection

Use `python3 scripts/ops/generate_runtime_topology_index.py --profile <id>`.

- `one_core`: One and onboarding.
- `finance`: Kai, Investor, and RIA.
- `privacy_connections`: Nav, Location, and Connections.
- `information_identity`: KYC, Email, Connected Systems, and Personal
  Information.

Profiles choose existing engineering evidence lanes only. They do not create
product subagents, grant consent, or expose database contents.

## Recurring founder audit

Run this workflow manually before adopting a new model or coding-agent host,
and after material code or infrastructure changes.
This is an operator cadence, not an installed scheduler. Start by recording the
branch, commit, upstream distance, working changes, model/host when exposed, and
available authenticated read access. Never equate a configured account with a
successful live read.

Use `scripts/ops/audit_agents_md_alignment.py --json` for shared rules, portable
bridges, platform-authored skill candidates and nested agent definitions. The
curated enforcement map is commentary; the live checks are structural evidence.
Use `--self-test` when changing the audit. Existing skill lint gates canonical
bridge drift; legacy platform-only bodies remain explicit migration candidates.

Compose the existing data-model, environment, native-parity and Founder Wiki
checks. Report each as verified, failed or unverified against its exact revision
and environment. A static report never proves deployment or device behavior.
Keep database checks read-only and content checks aggregate-only; retain no
credentials, decrypted records or private wiki bodies in artifacts.

For each finding, record evidence, severity, owner, correction, verification and
rollback. Remove code only after callers, imports, generated contracts and
compatibility obligations are checked. Turn a reproduced failure into a focused
regression check. Model upgrades repeat the same fixtures before expanding
scope or authority; stronger model output alone is not a passing result.
