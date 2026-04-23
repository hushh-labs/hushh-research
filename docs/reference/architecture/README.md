# Hussh Architecture Index


## Visual Map

```mermaid
flowchart TD
  root["Hussh Architecture Index"]
  stack["Seven-layer platform architecture"]
  contracts["API and route contracts"]
  data["Data, provenance, and storage"]
  runtime["Runtime and loading policies"]

  root --> stack
  root --> contracts
  root --> data
  root --> runtime
```

Use this as the north-star entrypoint for the Hussh platform stack, its integration contracts, and the supporting runtime/data references.

The architecture docs use the founder-language dual-label contract defined in [founder-language-matrix.md](./founder-language-matrix.md): founder terms lead when describing system meaning, and implementation labels remain explicit when a reader needs route, token, package, or runtime precision.

Brand and compatibility rules live in [../operations/brand-and-compatibility-contract.md](../operations/brand-and-compatibility-contract.md).

## References

- [architecture.md](./architecture.md): canonical seven-layer Hussh platform architecture, plus integration, deployment, and runtime sequence model.
- [founder-language-matrix.md](./founder-language-matrix.md): canonical founder-term to implementation-term mapping and audit checklist.
- [api-contracts.md](./api-contracts.md): API surface and proxy/backend contracts.
- [route-contracts.md](./route-contracts.md): app route inventory and parity governance.
- [loading-policy.md](./loading-policy.md): canonical loading and empty-state policy.
- [cache-coherence.md](./cache-coherence.md): cache invalidation and freshness model.
- [runtime-db-fact-sheet.md](./runtime-db-fact-sheet.md): runtime storage facts and boundaries.
- [data-provenance-ledger.md](./data-provenance-ledger.md): provenance and audit data model.
- [pkm-cutover-runbook.md](./pkm-cutover-runbook.md): PKM cutover and compatibility rules.
