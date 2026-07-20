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
