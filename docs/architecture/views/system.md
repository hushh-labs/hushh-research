# People and system boundaries

[System views](README.md) · [Architecture](../README.md)

One connects a person to selected information and services. Hussh owns the
coordination and consent contracts; external systems retain their own custody
and processing boundaries.

## Visual Map

```mermaid
flowchart TB
  person["Person: intent, keys and consent"]
  app["Web, iOS and Android"]
  one["One: private agent"]
  specialists["Bounded specialists: finance, memory, documents and tools"]
  platform["Hussh: identity, consent, placement and audit"]
  pkm["Encrypted memory and scoped exports"]
  external["Chosen models and connected services"]
  requester["External people, apps and MCP agents"]
  person --> app
  app --> one
  one --> specialists
  app --> platform
  specialists -->|Scoped access| platform
  platform --> pkm
  specialists -->|Approved processing| external
  requester -->|Discover and request| platform
  platform -->|Review sharing| person
```

One is the root private-agent runtime. Specialists do not become independent
principals or inherit unrestricted access. An external requester receives only
the granted scope through the existing consent/export contract.

See [identity and consent](../modules/identity.md), [sharing](../modules/sharing.md)
and [information custody](information-boundary.md). Future partner systems and
new execution models belong in the [roadmap](../../roadmap/README.md).
