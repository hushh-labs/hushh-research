# ADK Orchestration Documentation Audit

**Review basis:** 2026-09-23 local integration of pod base `11d293dbf7d514c59afa26f8e2a979c5b8539554`, remote ADK `2018cc2dba21b066485318b8053824893f7600c6`, local ADK `253ac50f24fac7b46e1db61b0634134525648052`, and remote main `e4056d1255ce0af88fe98cafaa4bfce4c2631f47`. The final integration revision is the commit containing this report. Source inspection does not establish per-environment rollout or cleanup.

## Visual Context

See the [canonical runtime architecture visuals](../architecture/architecture.md).

```mermaid
flowchart LR
  source["Inspected branch source"] --> code["Code contract inspected"]
  code --> integration["Dashboard and browser proxy remain unverified"]
  source --> deployment["Per-environment rollout evidence unavailable"]
  deployment --> retirement["Retirement completion unverified"]
```

## Findings

| Area | Status | Evidence and boundary |
|---|---|---|
| One delegation | Verified in checkout | [Agent hierarchy](../one/one-agent-hierarchy.md) distinguishes ADK `AgentTool`, process-local dispatch, and external scoped A2A. `SPECIALIST_A2A_SCOPE_MAP` has five admitted identifiers; default shared-runtime local dispatch registers Documents, Location, Email, Nav, and Personal Information handlers. An owner-bound pod may add Connections and Connected Systems for its own turn. These are separate contracts, not one universal router. |
| Plaid vault passthrough | Implemented in inspected source; rollout unverified | [`plaid_vault.py`](../../../consent-protocol/api/routes/kai/plaid_vault.py) exposes link-token, exchange, snapshot, and remove operations with owner authorization and no vault-route database persistence. The backend transiently receives access tokens and readable upstream records. The portfolio hook loads vault financial context and derives Plaid status from it; source inspection does not establish deployed UI behavior. The legacy server-backed route is absent from the integrated source, and migration 239 is present; no per-environment migration, key cleanup, or disconnection evidence was reviewed. |
| Browser proxy caching | Needs verification | Backend vault responses set `Cache-Control: no-store`, but the inspected generic Next Kai proxy rebuilds JSON through `withRequestIdJson` without visibly forwarding that header. Do not claim browser-facing proxy responses are no-store. Verify propagation in the owning frontend/API-contract workflow. |
| Mail/Drive UAT | Implementation evidence; live acceptance unverified | [Acceptance record](../operations/mail-drive-uat-acceptance.md) describes source and synthetic test checkpoints. Its current status calls for separate live rollout and two-account acceptance; this source audit does not establish deployment or feature acceptance. |
| Recursive documentation model | Corrected | [Knowledge model](../operations/documentation-recursive-knowledge-model.md) now identifies the existing mobile and One Location entrypoints and their child pages. |
| Pod authority and erasure | Fixed in inspected source; rollout unverified | The integration fails closed on explicit owner-authentication errors, retains owner-scoped memory, and keeps account erasure aligned with migration 239's removed tables. Focused source tests passed. A deployed pod or migration result was not proven. |
| Cloud Build environment | Fixed in inspected source | The deploy script accepts a bounded packed Drive secret setting so the backend build step stays below Cloud Build's 100-entry environment limit. The image build contract test passed; no image was built or deployed here. |
| Native parity reports | Follow-up required | Static parity validation passed, but the report-verification command found stale generated report artifacts. Refresh them through the native parity workflow before treating those artifacts as current. |
| Runtime model claims | Repo defaults verified; deployment selection varies | [`model_catalog.py`](../../../consent-protocol/hushh_mcp/runtime_providers/model_catalog.py) lists `gemini-3.8-flash` and `gemini-3.7-flash`; manifests can use `gemini-default`, and [`live_compatibility.py`](../../../consent-protocol/hushh_mcp/runtime_providers/live_compatibility.py) documents Live model compatibility. Voice model selection is environment/configuration dependent. These sources do not support describing One as entirely model-agnostic or proving a deployed model selection. |

## Follow-up ownership

- **Frontend proxy and dashboard integration:** verify response-header propagation through [`api-contract-change`](../../../.codex/workflows/api-contract-change/workflow.json) and migrate/verify the mounted status/refresh consumer against the vault contract through [`frontend-cache-coherence`](../../../.codex/workflows/frontend-cache-coherence/workflow.json). Evidence required: route-level header test and a same-contract dashboard integration check.
- **Plaid retirement rollout:** verify migration 239 through [`data-model-audit`](../../../.codex/workflows/data-model-audit/workflow.json), then prove migration and environment cleanup/disconnection through [`uat-scoped-deploy`](../../../.codex/workflows/uat-scoped-deploy/workflow.json) and the repo-operations owner. Evidence required: migration ledger and environment-specific cleanup results. Until then, retirement is present in inspected source, not a completed rollout.
- **Mail/Drive acceptance:** keep the acceptance record open until live rollout and the end-to-end two-account document-sharing journey pass.

## Canonical evidence

- [One agent hierarchy](../one/one-agent-hierarchy.md) and [agent development](../../../consent-protocol/docs/reference/agent-development.md)
- [Kai brokerage connectivity architecture](../kai/kai-brokerage-connectivity-architecture.md) and [Plaid passthrough contract](../kai/plaid-vault-passthrough.md)
- [Mail/Drive UAT acceptance](../operations/mail-drive-uat-acceptance.md)
- [Backend ADK bridge and agent tree](../../../consent-protocol/hushh_mcp/adk_bridge/__init__.py), [`delegation.py`](../../../consent-protocol/hushh_mcp/adk_bridge/delegation.py), [`agent_tree.py`](../../../consent-protocol/hushh_mcp/one_adk/agent_tree.py)
- [Runtime model catalog](../../../consent-protocol/hushh_mcp/runtime_providers/model_catalog.py), [Live compatibility rules](../../../consent-protocol/hushh_mcp/runtime_providers/live_compatibility.py)
