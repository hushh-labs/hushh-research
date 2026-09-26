# Flow views

## Visual Context

The [architecture index](../README.md) provides the top-down visual map; the [view catalog](../architecture-view-catalog.md) indexes this page and its figure status.

Canonical diagrams for this concern. Return to the [architecture view catalog](../architecture-view-catalog.md).

## Dynamic View: Consented Encrypted Export

View metadata:

| Field | Value |
| --- | --- |
| Stakeholders | partners, security, developer-platform engineers |
| Concern | How a connector receives only an approved encrypted export |
| Model kind | C4 dynamic / sequence diagram |
| Source anchors | `consent-protocol/docs/reference/developer-api.md`, `packages/hushh-mcp/README.md`, `docs/reference/iam/architecture.md` |

```mermaid
sequenceDiagram
  accTitle: Consented encrypted export
  accDescr: Ordered approval and scoped encrypted export flow.
  participant Connector as Connector or MCP host
  participant MCP as Hussh MCP / Developer API
  participant Kai as Kai approval surface
  participant User as User
  participant PKM as PKM / Vault
  participant Audit as Consent audit

  Connector->>MCP: Discover available user scopes
  MCP->>PKM: Read discovery-safe domains and scope registry
  PKM-->>MCP: Return scope labels and handles
  Connector->>MCP: Request one scope for one purpose
  MCP->>Kai: Create approval request
  Kai->>User: Show app, purpose, scope, expiry
  User-->>Kai: Approve or deny
  Kai->>Audit: Record decision and scope
  MCP->>PKM: Materialize approved slice only
  PKM-->>MCP: Return ciphertext and wrapped-key metadata
  MCP-->>Connector: Return encrypted scoped export
  Connector->>Connector: Decrypt locally under connector-owned key
```

Partner boundary: if a connector decrypts PII and writes plaintext into a CRM, that copy is outside the Hussh zero-knowledge boundary and needs explicit purpose, consent scope, retention, encryption or masking, access control, deletion, and audit ownership.

## Dynamic View: One / Kai Specialist Delegation

View metadata:

| Field | Value |
| --- | --- |
| Stakeholders | product, agent-runtime engineers, security |
| Concern | How specialist handoffs should inherit authority instead of minting broader access |
| Model kind | C4 dynamic / sequence diagram |
| Source anchors | `docs/vision/agent-ontology.md`, `docs/reference/kai/kai-action-gateway-vnext.md`, `docs/reference/kai/kai-architecture-specification-v1.md`, `consent-protocol/hushh_mcp/agents/one/agent.yaml` |

```mermaid
sequenceDiagram
  accTitle: One and Kai delegation
  accDescr: Scoped specialist delegation inside the agent runtime.
  participant User as User
  participant One as Agent One
  participant Policy as Consent / vault / route guards
  participant Kai as Kai specialist
  participant Tool as Scoped tool or operon
  participant PKM as PKM / Vault

  User->>One: Ask cross-domain or finance question
  One->>Policy: Check actor, persona, route, and requested scope
  Policy-->>One: Allow scoped handoff or block
  One->>Kai: Scoped AgentTool / in-process dispatch (where admitted)
  Kai->>Policy: Re-check scope before tool invocation
  Policy-->>Kai: Allow scoped action
  Kai->>Tool: Execute specialist work
  Tool->>PKM: Read/write only if scoped and approved
  Kai-->>One: Return specialist result
  One-->>User: Close the loop when relationship context is needed
```

Delegation rule: specialist delegation never bypasses consent, vault, persona, workspace, route, rollout, or kill-switch checks.

## Dynamic View: Portfolio Import

View metadata:

| Field | Value |
| --- | --- |
| Stakeholders | Kai engineers, security, product |
| Concern | How import work stays under portfolio/import and vault/PKM authority |
| Model kind | C4 dynamic / sequence diagram |
| Source anchors | `consent-protocol/hushh_mcp/agents/portfolio_import/agent.yaml`, `docs/reference/kai/kai-architecture-specification-v1.md`, `docs/guides/plaid-activation-and-testing.md` |

```mermaid
sequenceDiagram
  accTitle: Portfolio import flow
  accDescr: Statement import and consented information flow.
  participant User as User
  participant Kai as Kai finance specialist
  participant Import as Portfolio Import Agent
  participant Client as Device vault and Plaid Link
  participant API as Plaid vault passthrough
  participant Provider as Plaid
  participant Vault as Owner authority and local vault key
  participant PKM as PKM encrypted storage

  alt Statement import
    User->>Client: Upload statement for bounded parse
    Client->>Import: Request structured extraction
    Import-->>Client: Return holdings and account summary for review
    User->>Client: Review and confirm import
    Client->>Vault: Unlock or create vault and confirm save authority
    Vault-->>Client: Allow or block local encryption
    Client->>Client: Encrypt reviewed financial domain
    Client->>PKM: Write encrypted financial domain
    PKM-->>Kai: Provide authorized structured snapshot
  else New Plaid connection
    User->>Client: Start Link or unlock for refresh
    Client->>Vault: Require VAULT_OWNER and unlocked local vault key
    Vault-->>Client: Authorize provider call and local sealing
    Client->>API: Request Link token
    API->>Provider: Create Link token
    Provider-->>API: Link token
    API-->>Client: Link token
    Client->>Provider: Complete Link in the device SDK
    Provider-->>Client: Public token
    Client->>API: Exchange token or request snapshot
    API->>Provider: Exchange or fetch readable provider data
    Provider-->>API: Access token or financial response
    API-->>Client: Return token or snapshot transiently
    Client->>Client: Seal connection and snapshot with unlocked vault key
    Client->>PKM: Send encrypted domain through the PKM write path
  else Relink an existing connection
    User->>Client: Unlock vault and choose relink
    Client->>Vault: Require VAULT_OWNER and unlocked local vault key
    Vault-->>Client: Allow update-mode relink
    Client->>API: Request update-mode Link token with sealed access token
    API->>Provider: Create update-mode Link token
    Provider-->>API: Link token
    API-->>Client: Link token
    Client->>Provider: Complete update flow in the device SDK
    Provider-->>Client: Relink complete
    Client->>API: Request a fresh snapshot with the existing access token
    API->>Provider: Fetch readable provider data
    Provider-->>API: Financial response
    API-->>Client: Return snapshot transiently
    Client->>Client: Seal refreshed snapshot with unlocked vault key
    Client->>PKM: Send encrypted domain through the PKM write path
  else Refresh an existing connection
    User->>Client: Unlock vault or request Refresh
    Client->>Vault: Require VAULT_OWNER and unlocked local vault key
    Vault-->>Client: Allow refresh and local sealing
    Client->>API: Request snapshot with sealed access token and cursor
    API->>Provider: Fetch readable provider data
    Provider-->>API: Financial response
    API-->>Client: Return snapshot transiently
    Client->>Client: Seal refreshed snapshot with unlocked vault key
    Client->>PKM: Send encrypted domain through the PKM write path
  end
```

Import rule: statement parsing does not give Kai or the import agent broad access to the
vault. Plaid calls transiently process provider tokens and readable responses on the backend;
the device seals connection data before writing the encrypted domain. This diagram describes
the vault route, not completion of legacy server-row cleanup in deployed environments.

## Dynamic View: One Email KYC

View metadata:

| Field | Value |
| --- | --- |
| Stakeholders | KYC, backend, frontend, security |
| Concern | Mailbox intake, approval-gated draft, scoped export refresh, and structured writeback |
| Model kind | C4 dynamic / sequence diagram |
| Source anchors | `docs/reference/architecture/one-email-kyc.md`, `consent-protocol/hushh_mcp/services/one_email_kyc_service.py`, `hushh-webapp/lib/services/one-kyc-client-zk-service.ts` |

```mermaid
sequenceDiagram
  accTitle: One Email KYC flow
  accDescr: Mailbox and identity workflow boundaries.
  participant Mail as One mailbox / Gmail
  participant Backend as One Email KYC backend workflow
  participant Client as One KYC client surface
  participant Consent as Consent and scoped export
  participant User as User approver
  participant PKM as PKM / Vault

  Mail->>Backend: Receive KYC workflow signal
  Backend->>Consent: Create or refresh scoped workflow request
  Consent->>User: Ask for approval in Hussh/Kai
  User-->>Consent: Approve or deny
  Client->>Consent: Refresh approved encrypted export
  Consent-->>Client: Return encrypted export metadata
  Client->>Client: Decrypt and draft locally under strict ZK guard
  Client->>Backend: Send approved workflow action metadata
  Client->>PKM: Write structured approved facts through PKM path
```

KYC rule: backend orchestrates workflow metadata and mail/send surfaces; strict client-side zero-knowledge behavior must not turn the backend into a plaintext review-draft store.
