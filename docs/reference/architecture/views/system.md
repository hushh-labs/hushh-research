# System views

## Visual Context

The [architecture index](../README.md) provides the top-down visual map; the [view catalog](../architecture-view-catalog.md) indexes this page and its figure status.

Canonical diagrams for this concern. Return to the [architecture view catalog](../architecture-view-catalog.md).

## System Landscape

View metadata:

| Field | Value |
| --- | --- |
| Stakeholders | founders, partners, engineering, security |
| Concern | External landscape around Hussh, including current channels and future-state partner lanes |
| Model kind | C4 system landscape |
| Source anchors | `docs/project_context_map.md`, `docs/reference/architecture/architecture.md`, `docs/vision/agent-ontology.md`, `packages/hushh-mcp/README.md`, `docs/future/hussh-one-infra/salesforce-mulesoft-brief.md` |

```mermaid
flowchart TB
  accTitle: Hussh system landscape
  accDescr: People, channels, providers, and future partner systems around Hussh.
  user["User<br/>owns account, vault, and consent"]
  web["Hussh web app<br/>One shell + Kai finance runtime"]
  mobile["Capacitor mobile shell<br/>iOS / Android parity lane"]
  mcpHost["External MCP hosts<br/>Claude / Codex / Cursor / partner tools"]
  devCaller["Developer API callers<br/>approved apps and connectors"]
  providers["External providers<br/>Firebase, Plaid, Gmail, market APIs"]
  partner["Salesforce / MuleSoft / Agentforce<br/>future-state partner workflow channel"]

  hussh["Hussh platform<br/>Consent Protocol, MCP, PKM, agents, audit"]
  pkm["PKM / Vault<br/>canonical encrypted user memory"]
  crm["Partner CRM<br/>narrow approved workflow fields only"]

  user --> web
  user --> mobile
  web --> hussh
  mobile --> hussh
  mcpHost --> hussh
  devCaller --> hussh
  providers --> hussh
  partner -.-> hussh

  hussh --> pkm
  hussh -.-> crm
```

Reading rule: Hussh owns the trust and memory boundary. External systems are channels, providers, or workflow endpoints.

## System Context

View metadata:

| Field | Value |
| --- | --- |
| Stakeholders | product, engineering, security, partners |
| Concern | Hussh boundary, user authority, agent roles, MCP/developer access, and partner limitations |
| Model kind | C4 system context |
| Source anchors | `docs/vision/agent-ontology.md`, `docs/reference/iam/architecture.md`, `consent-protocol/docs/reference/developer-api.md`, `packages/hushh-mcp/README.md` |

```mermaid
flowchart TB
  accTitle: Hussh system context
  accDescr: Hussh trust boundary and external actors.
  user["User<br/>subject and authority"]
  kai["Kai<br/>current finance specialist surface"]
  one["One<br/>approved top private-agent direction"]
  nav["Nav<br/>privacy and consent guardian"]
  kyc["KYC<br/>identity workflow specialist"]

  mcp["Hussh MCP<br/>scope discovery, consent, export"]
  api["Developer API<br/>/api/v1"]
  partner["Salesforce / MuleSoft<br/>future-state workflow channel"]

  hussh["Hussh platform boundary<br/>Consent Protocol, PKM, vault, agents, audit"]
  pchp["PCHP approval<br/>ask, approve, audit"]
  pkm["PKM / Vault<br/>encrypted user memory"]

  user --> kai
  kai --> hussh
  one -.->|"approved direction"| kai
  one -.->|"approved direction"| nav
  one -.->|"approved direction"| kyc

  mcp --> hussh
  api --> hussh
  partner -.-> hussh

  hussh --> pchp
  pchp --> user
  hussh --> pkm
```

Current-state boundary: One, Nav, and KYC are approved ontology directions with checked-in manifests. Kai remains the most mature current product runtime unless a specific route proves otherwise.
