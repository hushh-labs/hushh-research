# Quality and Design System Index


## Visual Map

```mermaid
flowchart TD
  root["Quality and Design System Index"]
  n8["Analytics Verification Contract"]
  root --> n8
  n1["App Surface Audit Matrix"]
  root --> n1
  n2["App Surface Design System"]
  root --> n2
  n3["Design System"]
  root --> n3
  n4["Frontend UI Architecture Map"]
  root --> n4
  n5["Frontend Pattern Catalog"]
  root --> n5
  n6["Pr Impact Checklist"]
  root --> n6
  n7["Profile Settings Design System"]
  root --> n7
```

This is the north-star entrypoint for design-system rules plus verification contracts that decide whether UI and analytics behavior are trustworthy.

## Read In This Order

- [design-system.md](./design-system.md): component layering and primitive ownership.
- [frontend-ui-architecture-map.md](./frontend-ui-architecture-map.md): repo map, labs boundary, and layer ownership.
- [app-surface-design-system.md](./app-surface-design-system.md): page shell, header, card, bell, and interaction contract.
- [profile-settings-design-system.md](./profile-settings-design-system.md): canonical grouped settings language.
- [frontend-pattern-catalog.md](./frontend-pattern-catalog.md): implementation patterns and allowed primitives.
- [app-surface-audit-matrix.md](./app-surface-audit-matrix.md): current rollout matrix across routes.
- [pr-impact-checklist.md](./pr-impact-checklist.md): change-impact review checklist.
- [analytics-verification-contract.md](./analytics-verification-contract.md): proof ladder for GA4, Firebase, BigQuery, and growth dashboard trust.
