# Hushh Webapp Docs


## Visual Map

```mermaid
flowchart TD
  root["Hushh Webapp Docs"]
  n1["Kai Analysis Layout And Review Mode"]
  root --> n1
  n2["Plugin Api Reference"]
  root --> n2
  n3["Profile Management Design Rules"]
  root --> n3
```

Frontend and native-client implementation references for the webapp package.

This docs home is package-local. It should stay focused on frontend/native implementation material that does not belong in cross-cutting root `docs/`.

## Documents

| Document | Scope |
| -------- | ----- |
| [plugin-api-reference.md](./plugin-api-reference.md) | Capacitor plugin contracts and parameter parity |
| [kai-analysis-layout-and-review-mode.md](./kai-analysis-layout-and-review-mode.md) | Kai analysis UI layout and app-review runtime behavior |
| [profile-management-design-rules.md](./profile-management-design-rules.md) | Guardrails for Profile IA, page navigation, and non-analytical summary usage |

## Source Tree Indexes

- [../components/app-ui/README.md](../components/app-ui/README.md)
- [../components/consent/README.md](../components/consent/README.md)
- [../components/kai/README.md](../components/kai/README.md)
- [../components/ria/README.md](../components/ria/README.md)
- [../lib/services/README.md](../lib/services/README.md)

## Related References

- Cross-cutting docs entry: [`docs/README.md`](../../docs/README.md)
- Kai voice runtime architecture: [`docs/reference/kai/kai-voice-runtime-architecture.md`](../../docs/reference/kai/kai-voice-runtime-architecture.md)
- Documentation homes map: [`docs/reference/operations/documentation-architecture-map.md`](../../docs/reference/operations/documentation-architecture-map.md)
- Backend docs entry: [`consent-protocol/docs/README.md`](../../consent-protocol/docs/README.md)
