# consent-protocol Reference Index

## Visual Map

```mermaid
flowchart TD
  root["consent-protocol/docs/reference"]
  agent["agent-development.md"]
  api["developer-api.md"]
  consent["consent-protocol.md"]
  pkm["personal-knowledge-model.md"]
  fcm["fcm-notifications.md"]

  root --> agent
  root --> api
  root --> consent
  root --> pkm
  root --> fcm
```

This backend docs home uses the same founder-language matrix as root `docs/`, while keeping implementation labels explicit for routes, tokens, tables, and package surfaces.

- Terminology contract: [../../../docs/reference/architecture/founder-language-matrix.md](../../../docs/reference/architecture/founder-language-matrix.md)
- Brand contract: [../../../docs/reference/operations/brand-and-compatibility-contract.md](../../../docs/reference/operations/brand-and-compatibility-contract.md)

## Reference Documents

- [agent-development.md](./agent-development.md): agent, tool, operon, and service development model
- [backend-semantic-baseline-audit.md](./backend-semantic-baseline-audit.md): backend semantic audit reference
- [backend-semantic-boundary.md](./backend-semantic-boundary.md): backend semantic boundary contract
- [consent-protocol.md](./consent-protocol.md): consent-token lifecycle and trust model
- [developer-api.md](./developer-api.md): developer API and MCP-facing contract
- [dev-environment-setup.md](./dev-environment-setup.md): hosted dev environment runbook
- [mulesoft-agentforce-secure-relay.md](./mulesoft-agentforce-secure-relay.md): MuleSoft/Agentforce secure relay contract
- [env-vars.md](./env-vars.md): backend environment reference
- [fcm-notifications.md](./fcm-notifications.md): push notification delivery model
- [kai-agents.md](./kai-agents.md): Kai backend and agent system reference
- [personal-knowledge-model.md](./personal-knowledge-model.md): PKM model and storage architecture
- [trusted-device-vault-handoff.md](./trusted-device-vault-handoff.md): PKCE-bound ciphertext delivery for Hermes enrollment
- [pkm-agent-north-star.md](./pkm-agent-north-star.md): PKM agent north-star reference
- [pkm-prompt-contract.md](./pkm-prompt-contract.md): PKM prompt contract
- [pkm-structure-agent-live-eval.md](./pkm-structure-agent-live-eval.md): PKM structure evaluation notes
