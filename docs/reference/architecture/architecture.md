# Architecture

> Current runtime architecture for the Hushh monorepo.

## Visual Map

```mermaid
flowchart LR
  identity["Identity"]
  token["Scoped token"]
  app["App / Agent"]
  backend["Backend services"]
  store["Ciphertext store"]

  identity -->|authenticates actor| token
  token -->|authorizes operation| app
  app -->|sends scoped request| backend
  backend -->|stores ciphertext only| store
```

## Trust Model

The platform should be read as a protocol boundary first and an app stack second.

Core invariants:

1. **BYOK**: the user-controlled key boundary stays on the user side.
2. **Zero-knowledge**: the backend stores ciphertext and metadata, not plaintext user memory.
3. **Consent + scoped access**: sensitive operations require explicit scope.
4. **Tri-flow parity**: web, iOS, and Android stay contract-aligned.

## Protocol View

```mermaid
flowchart LR
  identity["Identity<br/>who is acting"]
  vault["Vault<br/>encrypted user data"]
  token["Scoped token<br/>what access is allowed"]
  app["App / Agent<br/>what operation runs"]
  backend["Backend services<br/>verify scope + persist state"]
  store["Ciphertext store + metadata index"]

  identity -->|authenticates actor| token
  vault -->|decrypts locally with user-held key| app
  token -->|authorizes scoped operation| app
  app -->|sends scoped request| backend
  backend -->|verifies access scope| token
  backend -->|stores ciphertext only| store
  backend -->|returns allowed metadata or ciphertext| app
```

## Runtime View

```mermaid
flowchart TB
  subgraph clients["Client surfaces"]
    web["Web"]
    ios["iOS"]
    android["Android"]
  end

  subgraph frontend["Frontend runtime"]
    shell["Shared shell + providers"]
    services["Typed service layer"]
    cache["Session + stale-first cache"]
  end

  subgraph boundary["Boundary layer"]
    next["Next.js route handlers"]
    native["Capacitor plugins"]
  end

  subgraph backend["Backend runtime"]
    routes["FastAPI routes"]
    domain["Consent, PKM, Kai, IAM, RIA services"]
  end

  subgraph persistence["Persistence"]
    relational["Relational workflow data"]
    blobs["Encrypted PKM blobs + manifests"]
    providers["External providers"]
  end

  web -->|renders signed-in and public routes| shell
  ios -->|hosts same app contract in native shell| shell
  android -->|hosts same app contract in native shell| shell
  shell -->|calls typed APIs| services
  cache -->|hydrates stale-first reads| services
  services -->|web path| next
  services -->|native path| native
  next -->|forwards authenticated contract| routes
  native -->|forwards authenticated contract| routes
  routes -->|delegates domain work| domain
  domain -->|writes workflow state| relational
  domain -->|writes ciphertext and manifests| blobs
  domain -->|reads external systems| providers
```

## Repo Shape

The normal contributor mental model should stay small:

- `hushh-webapp/`: client shell, UI, service layer, native bridges
- `consent-protocol/`: backend routes, services, consent, PKM, agents
- `docs/`: cross-cutting product, architecture, and operations references

The `consent-protocol` subtree relationship still exists, but it is maintainer-only complexity and not part of the first-run contributor contract.

## What The Backend Is Responsible For

- verify consent and scope
- issue and validate token-backed access
- persist encrypted PKM blobs and metadata
- coordinate Kai, IAM, consent, and RIA workflows
- integrate with external providers without breaking the ciphertext boundary

## What The Frontend Is Responsible For

- hold the user-side trust boundary for local decryption
- maintain the session, vault, and persona state
- render the consent and scope UX clearly
- keep web, iOS, and Android aligned on visible behavior

## Design Rule

Keep the backbone integrated where the platform needs it, but make the public contributor surface feel bacterial:

- small commands
- self-contained scripts
- modular docs
- minimal cross-repo mental load
