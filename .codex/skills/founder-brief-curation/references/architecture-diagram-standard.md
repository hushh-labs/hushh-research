# Architecture Diagram Standard

Use this reference for architecture diagrams in Markdown, HTML, and PDF artifacts.

## Canonical Model And Syntax

1. Use C4 as the architecture vocabulary and ISO/IEC/IEEE 42010 as the view-governance frame.
2. Use GitHub-native Mermaid `flowchart` for structure, boundaries, deployment, and information movement; use `sequenceDiagram` for ordered runtime behavior.
3. Do not introduce Mermaid C4 extensions, PlantUML, D2, draw.io, or a second diagram source of truth. Structurizr is a future promotion path only if repeated views demonstrably drift from one shared model.
4. Render Mermaid locally with the pinned repo dependency. Never send private diagrams to a public renderer or load a floating CDN script.

## Minimum Figure Contract

Every figure must declare, in its caption or nearby prose:

- view type and concern;
- audience or stakeholders;
- current, future, partner-confirmation, or external status;
- system and trust boundaries;
- directional, labelled relationships;
- source anchors for material claims.

Keep one abstraction level per figure. Prefer context plus one dynamic flow. Add more figures only when each resolves a different material concern. Use `accTitle` and `accDescr` in every Mermaid block.

## View Selection

| Concern | View |
| --- | --- |
| People and systems around Hussh | C4 system landscape or context `flowchart` |
| Deployable/runtime responsibilities | C4 container `flowchart` |
| Important ordered user or provider flow | Dynamic `sequenceDiagram` |
| Plaintext, ciphertext, keys, credentials, or legal documents | Data-boundary `flowchart` |
| Environment and network placement | Deployment `flowchart`, only when repo-backed |

## Status And Boundary Rules

1. Never draw a future integration with the same semantics as shipped runtime.
2. Label optional or unverified partner behavior with dotted edges and explicit text.
3. Name the actor, information class, protocol or capability, and authority at every trust-boundary crossing.
4. Show prohibited crossings when they prevent a likely misunderstanding, such as OAuth tokens entering an agent or browser.
5. A diagram cannot grant authority. Link architecture decisions to the owning contract or ADR.

## Rendering And Proof

1. The Markdown PDF exporter renders Mermaid locally to SVG in strict security mode using the pinned `mermaid` package.
2. Fail the artifact when Mermaid parsing or rendering fails; do not silently publish raw source as a diagram.
3. Inspect every rendered page for clipping, overlap, contrast, arrow direction, legibility, and status-boundary clarity.
4. Confirm the standalone HTML contains SVG and the PDF text does not expose raw Mermaid statements.
5. Keep rendered SVG temporary unless a consuming format requires a committed asset.

## Open-Source Basis

This standard independently distills conventions from the C4 model, Structurizr, Mermaid, D2, PlantUML/C4-PlantUML, arc42, and MADR. Hussh keeps C4 plus Mermaid because it already matches the repository's Markdown-native contract. Do not copy external prose, examples, code, or styling; preserve each upstream license when an actual asset is reused.

Primary references:

- C4 model and checklist: https://c4model.com/diagrams/checklist
- Structurizr: https://github.com/structurizr/structurizr (Apache-2.0)
- Mermaid: https://github.com/mermaid-js/mermaid (MIT)
- D2: https://github.com/terrastruct/d2 (MPL-2.0)
- C4-PlantUML: https://github.com/plantuml-stdlib/C4-PlantUML (MIT)
- MADR: https://github.com/adr/madr (MIT OR CC0-1.0)

