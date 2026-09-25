# Runtime views

## Visual Context

The [architecture index](../README.md) provides the top-down visual map; the [view catalog](../architecture-view-catalog.md) indexes this page and its figure status.

Canonical diagrams for this concern. Return to the [architecture view catalog](../architecture-view-catalog.md).

## Container View

View metadata:

| Field | Value |
| --- | --- |
| Stakeholders | frontend, backend, platform, security |
| Concern | Runtime containers, stores, providers, and external transport lanes |
| Model kind | C4 container view |
| Source anchors | `consent-protocol/README.md`, `docs/project_context_map.md`, `docs/reference/architecture/api-contracts.md`, `packages/hushh-mcp/README.md`, `docs/guides/mobile.md`, `consent-protocol/hushh_mcp/services/gcp_backend.py`, `consent-protocol/pod_server.py` |

```mermaid
flowchart TB
  accTitle: Hussh runtime containers
  accDescr: Frontend, hub, per-owner pods, and storage boundaries.
  subgraph clients["Client and channel containers"]
    web["hushh-webapp<br/>Next.js / React / Cloud Run frontend"]
    mobile["Capacitor app shell<br/>native iOS / Android WebView"]
    mcpClient["MCP host<br/>remote HTTP or stdio bridge"]
    devClient["Developer API connector"]
    nextProxy["Next.js API proxy routes<br/>frontend-owned"]
  end

  subgraph backend["Consent Protocol runtime — the hub"]
    fastapi["FastAPI backend<br/>consent-protocol"]
    mcpServer["MCP server<br/>hosted remote or @hushh/mcp bridge"]
    domainServices["Domain services<br/>IAM, consent, PKM, Kai, RIA, One Email KYC"]
    agents["Agent runtime<br/>agents, tools, operons"]
    fleet["Pod fleet control plane<br/>provision, heartbeat, reconcile, teardown"]
    relay["Pod turn relay<br/>owner-authorized hub to pod"]
  end

  subgraph pods["Per-user compute — one container per person (dev lane)"]
    podA["one-pod-&lt;HusshID&gt;<br/>Cloud Run, hub-only ingress by default"]
    podB["one-pod-&lt;HusshID&gt;<br/>...one per person"]
  end

  ownerStore["BYOC owner cloud<br/>encrypted commit log + KMS, when configured"]

  subgraph data["Storage and provider containers"]
    relational["Postgres / Cloud SQL<br/>workflow, consent, audit, metadata"]
    encrypted["PKM encrypted blobs<br/>ciphertext + manifests + scope registry"]
    cache["Provider/reference caches<br/>Plaid, Gmail, market, reference data"]
    firebase["Firebase<br/>auth, FCM"]
    secrets["Secret Manager<br/>runtime secrets and config"]
  end

  web --> nextProxy --> fastapi
  mobile --> fastapi
  mcpClient --> mcpServer --> fastapi
  devClient --> fastapi

  fastapi --> domainServices
  domainServices --> agents
  domainServices --> relational
  domainServices --> encrypted
  domainServices --> cache
  fastapi --> firebase
  fastapi --> secrets

  domainServices --> fleet
  fleet -->|"create / delete service"| podA
  fleet --> podB
  fastapi --> relay
  relay -->|"ID token, roles/run.invoker"| podA
  podA -->|"heartbeat, consent verify, prompt fetch<br/>ID token, audience-checked"| fastapi
  podA -.->|"BYOC encrypted recovery only"| ownerStore
```

Container rule: clients call service/proxy boundaries; they do not become policy authorities or memory stores.

Pod container rule: a pod has no hub Postgres credential or vault data key. Hub-owned information reads travel pod → hub → Postgres over `HUSSH_HUB_BASE_URL`; a configured BYOC pod can also reach its owner's encrypted commit-log bucket and KMS for recovery. Default hub-only reachability uses internal ingress plus the narrow hub `roles/run.invoker` binding. A separately gated dev direct mode uses public ingress and a public Cloud Run invoker, with pod-level signed binding and session admission as its application lock. Do not mistake public transport reachability for information authority.

## Component View

View metadata:

| Field | Value |
| --- | --- |
| Stakeholders | backend, agent, frontend-service, security reviewers |
| Concern | Major components inside the Consent Protocol runtime |
| Model kind | C4 component view |
| Source anchors | `consent-protocol/docs/reference/agent-development.md`, `consent-protocol/docs/reference/kai-agents.md`, `docs/reference/iam/architecture.md`, `docs/reference/architecture/runtime-db-fact-sheet.md` |

```mermaid
flowchart TB
  accTitle: Consent Protocol components
  accDescr: Policy, services, and agent components within the hub.
  fastapi["FastAPI ingress<br/>routes and middleware"]

  subgraph policy["Trust and policy components"]
    iam["IAM / actor profiles"]
    consent["Consent lifecycle<br/>request, approve, status, revoke"]
    token["Token validation<br/>VAULT_OWNER, consent tokens, developer tokens"]
    audit["Audit and regulated evidence"]
  end

  subgraph pkm["PKM and export components"]
    pkmSvc["PKM services"]
    exportSvc["Scoped export services"]
    registry["Domain and scope registry"]
    vault["Vault wrappers and encrypted blobs"]
  end

  subgraph agent["Agent execution components"]
    one["Agent One / orchestrator<br/>approved direction / manifest"]
    kai["Kai finance agent<br/>current mature runtime"]
    nav["Nav consent guardian<br/>approved direction"]
    kyc["KYC workflow specialist<br/>checked workflow surface"]
    importAgent["Portfolio Import Agent<br/>current Kai-adjacent surface"]
    memory["Memory agents<br/>approved direction"]
    tools["Tools<br/>@hushh_tool"]
    operons["Operons<br/>business logic"]
  end

  subgraph workflow["Workflow and provider components"]
    ria["RIA / marketplace workflows"]
    email["One Email KYC workflow"]
    plaid["Plaid portfolio import"]
    gmail["Gmail / mailbox services"]
    market["Market data services"]
  end

  fastapi --> iam
  fastapi --> consent
  fastapi --> token
  consent --> audit

  fastapi --> pkmSvc
  pkmSvc --> registry
  pkmSvc --> vault
  exportSvc --> vault
  consent --> exportSvc

  fastapi --> one
  one -->|"scoped AgentTool / dispatch"| kai
  one -.->|"approved / conditional"| nav
  one -.->|"approved / conditional"| kyc
  kai --> importAgent
  kai --> memory
  kai --> tools
  importAgent --> tools
  tools --> operons

  fastapi --> ria
  fastapi --> email
  fastapi --> plaid
  fastapi --> gmail
  fastapi --> market
```

Component rule: agents orchestrate, tools expose callable operations, operons hold business logic, and services own persistence boundaries. Kai is the current mature specialist runtime. One, Nav, KYC, and memory-agent nodes are included only where checked manifests, route surfaces, or approved direction exist; do not read this diagram as proof that full One/Nav default runtime has shipped.
