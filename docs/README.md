# Hushh Documentation

> Canonical entry point for repo-level documentation.


## Visual Map

```mermaid
flowchart TB
  hub["docs/<br/>Canonical system knowledge"]

  subgraph orientation["Orientation"]
    context["project_context_map.md<br/>product + repo north stars"]
    guides["guides/<br/>task and contributor guides"]
  end

  subgraph reference["Reference Domains"]
    arch["architecture/<br/>runtime, cache, API, route contracts"]
    iam["iam/<br/>actor model, consent, access control"]
    kai["kai/<br/>investor flows and system maps"]
    mobile["mobile/<br/>Capacitor and parity"]
    ops["operations/<br/>CI, release lanes, governance"]
    quality["quality + streaming + vision"]
  end

  subgraph implementation["Implementation Docs"]
    fe["hushh-webapp/docs/<br/>frontend and native implementation"]
    be["consent-protocol/docs/<br/>backend and protocol implementation"]
  end

  subgraph packages["Code Packages"]
    webapp["hushh-webapp/<br/>Next.js + Capacitor client"]
    backend["consent-protocol/<br/>FastAPI + PKM + agents"]
  end

  hub --> context
  hub --> guides
  hub --> arch
  hub --> iam
  hub --> kai
  hub --> mobile
  hub --> ops
  hub --> quality
  hub --> fe
  hub --> be
  context --> webapp
  context --> backend
  arch --> webapp
  arch --> backend
  fe --> webapp
  be --> backend
```

Hushh is a personal agent platform built on four operational invariants:

1. BYOK: server stores ciphertext only.
2. Consent-first: every data access path is consent-gated.
3. Tri-flow: web, iOS, and Android stay contract-aligned.
4. Minimal browser storage: vault keys, VAULT_OWNER, and decrypted PKM remain memory-only; only approved encrypted or non-sensitive caches may persist on device.

For repo setup, see [`readme.md`](../readme.md) and [`getting_started.md`](../getting_started.md).

## Domain Indexes

| Domain | Index |
| ---- | ---- |
| Guides | [guides/README.md](./guides/README.md) |
| Architecture | [reference/architecture/README.md](./reference/architecture/README.md) |
| AI | [reference/ai/README.md](./reference/ai/README.md) |
| IAM | [reference/iam/README.md](./reference/iam/README.md) |
| Kai | [reference/kai/README.md](./reference/kai/README.md) |
| Mobile | [reference/mobile/README.md](./reference/mobile/README.md) |
| Operations | [reference/operations/README.md](./reference/operations/README.md) |
| Quality / Design System | [reference/quality/README.md](./reference/quality/README.md) |
| Streaming | [reference/streaming/README.md](./reference/streaming/README.md) |
| Vision | [vision/README.md](./vision/README.md) |

## Implementation Indexes

| Code Domain | Index |
| ---- | ---- |
| Frontend/native package docs | [../hushh-webapp/docs/README.md](../hushh-webapp/docs/README.md) |
| App UI shell and shared surfaces | [../hushh-webapp/components/app-ui/README.md](../hushh-webapp/components/app-ui/README.md) |
| Consent UI and launchers | [../hushh-webapp/components/consent/README.md](../hushh-webapp/components/consent/README.md) |
| Kai investor surfaces | [../hushh-webapp/components/kai/README.md](../hushh-webapp/components/kai/README.md) |
| RIA surfaces | [../hushh-webapp/components/ria/README.md](../hushh-webapp/components/ria/README.md) |
| Service layer and platform-aware calls | [../hushh-webapp/lib/services/README.md](../hushh-webapp/lib/services/README.md) |
| Backend implementation docs | [../consent-protocol/docs/README.md](../consent-protocol/docs/README.md) |

## Documentation Homes

| Location | Scope | Entry Point |
| -------- | ----- | ----------- |
| `docs/` | Cross-cutting architecture, operations, quality, product references | [README.md](./README.md) |
| `consent-protocol/docs/` | Backend implementation and protocol references | [README.md](../consent-protocol/docs/README.md) |
| `hushh-webapp/docs/` | Frontend/native implementation references | [README.md](../hushh-webapp/docs/README.md) |

## Directory Layout

```text
docs/
  README.md
  project_context_map.md
  guides/
    README.md
  reference/
    ai/
      README.md
    architecture/
      README.md
    iam/
      README.md
    kai/
      README.md
    mobile/
      README.md
    operations/
      README.md
    quality/
      README.md
    streaming/
      README.md
  vision/
    README.md
```

Use kebab-case for non-index docs and keep only durable references in this tree.
