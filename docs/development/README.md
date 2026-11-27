<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../assets/brand/pillar-development-dark.svg" />
    <source media="(prefers-color-scheme: light)" srcset="../assets/brand/pillar-development-light.svg" />
    <img alt="Development and Contracts" src="../assets/brand/pillar-development-light.svg" width="100%" />
  </picture>
</p>

# Development

[Documentation](../README.md) · **Intent:** Tutorials, how-to guides & contracts

Build from the canonical branch for your work (`dev`, `uat`, or `main`), use the existing package owners, and validate every contract your change touches locally before pushing.

## Visual Map

```mermaid
flowchart LR
  subgraph LocalLoop["Local Engineering Loop"]
    setup["1. Bootstrap locally"]
    locate["2. Locate owning module"]
    change["3. Implement & test locally"]
  end

  subgraph GovernanceGate["Governed Admission"]
    pr["4. Open PR & pass CI"]
    queue["5. Merge Queue combined check"]
    release["6. Separate authorized release"]
  end

  setup --> locate
  locate --> change
  change --> pr
  pr --> queue
  queue --> release
```

## Core developer guides

| Goal | Intent | Start here |
| --- | --- | --- |
| Set up your machine and local services | `Tutorial` | [Getting started](guides/getting-started.md) · [Environments](../operations/environments.md) |
| Orient across the monorepo | `Explanation` | [Repository map](repository-map.md) · [Architecture modules](../architecture/README.md#modules) |
| Contribute cleanly and pass PR gates | `How-To` | [Contributor guide](../../contributing.md) · [Testing](../../TESTING.md) · [PR checklist](quality/pr-impact-checklist.md) |
| Read API, route, cache, and native contracts | `Reference` | [Technical references](references.md) · [Web & mobile docs](../../hushh-webapp/docs/README.md) · [Backend docs](../../consent-protocol/docs/README.md) |
| Author or evolve documentation | `How-To` | [Documentation standard](documentation.md) |
| Work with the coding-agent framework | `Reference` | [Engineering principles](engineering-principles.md) · [`.agents` guide](../../.agents/README.md) · [Framework checks](agents/README.md) |
| Keep local disk, worktrees, and dependencies healthy | `Reference` | [Worktree and dependency hygiene](worktree-and-dependency-hygiene.md) |

> [!NOTE]
> Release permissions, branch rules, and deployment workflows live exclusively in [Operations](../operations/README.md) so there is never a competing release procedure.

## Further reading

- [Guides Index](guides/README.md)
- [Hussh Mobile Index](mobile/README.md)
- [Quality and Design System Index](quality/README.md)
- [Streaming Index](streaming/README.md)

<details>
<summary><strong>For coding agents: pre-PR verification entrypoints</strong></summary>

- Route recurring tasks via `./bin/hushh agents route-task <workflow-id>`.
- Run `./bin/hushh docs verify` for doc edits, `npm run typecheck && npm run verify:ui-contracts` for frontend edits, and `pytest` + `mypy --config-file pyproject.toml --ignore-missing-imports` for backend edits before pushing.
- For multi-cloud storage, KMS custody, capability-prefix, or sandbox/BYOC changes, run `./bin/hushh protocol floci` ([Floci wire verification](quality/floci-multicloud-wire-verification.md)) before container builds or live cloud qualification.

</details>
