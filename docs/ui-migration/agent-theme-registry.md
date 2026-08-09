# UAT Agent Theme Registry Audit

Status: Phase 1 registry baseline.

## Visual Context

Canonical visual owner: [Quality and Design System Index](../reference/quality/README.md).

This registry audit maps visual identity for One and specialist sections. It keeps agent accent color inside shared icon and navigation primitives instead of page-local styling.

Current source inputs:

- `hushh-webapp/lib/onboarding/one-capabilities.ts`
- `hushh-webapp/lib/navigation/agent-sections.ts`
- `hushh-webapp/components/app-ui/agent-section-icon.tsx`

Design-system requirement:

- Agent accents must be centrally registered.
- Agent accents may identify agents in icon tiles, selected chips, tiny progress accents, restrained tints, and agent-specific visualization.
- Agent accents must not recolor ordinary body copy, every card, every button, or universal navigation.
- Semantic colors override agent accents.

## Current Product Truth

The design brief refers to seven agents. The current UAT code exposes eight visible top-level navigation sections when the root One section is counted:

| Section id | User-facing label | Route family | Bottom nav scope | Capability tone | Availability |
| --- | --- | --- | --- | --- | --- |
| `agents` | One | one | one | none | visible root section |
| `finance` | Finance | investor | investor | finance | enabled |
| `ria` | RIA | ria | ria | ria | enabled |
| `email` | KYC | one | one | email | enabled |
| `location` | Location | one | one | location | enabled |
| `pkm` | Memory | one | one | pkm | enabled |
| `consent` | Consent | one | one | consent | enabled |
| `connected-systems` | CRM | one | one | connected | enabled |

Additional catalog entries:

| Capability id | User-facing label | Current status |
| --- | --- | --- |
| `gmail` | Gmail | Paused and not shown by `isOneCapabilityEnabled`. |
| `marketplace` | Information Marketplace | Route-addressable but hidden from the primary agent roster. |

## Current Duplication

Agent visual identity is currently split across:

- `ONE_CAPABILITY_ICON_CLASS_BY_TONE` in `one-capabilities.ts`.
- `CAPABILITY_ICON_STYLE_BY_TONE` in `agent-section-icon.tsx`.
- `PROFILE_CAPABILITY_ICON_STYLE_BY_TONE` in `agent-section-icon.tsx`.
- `PROFILE_LAUNCHER_PALETTE` in `agent-section-icon.tsx`.

This is the main registry gap. A future central registry should own accent, soft tint, icon background, foreground/on-accent, dark-mode equivalents, and capability mapping.

## Implemented Registry Shape

The first central registry now exists at:

`hushh-webapp/lib/design/agent-theme-registry.ts`

It owns:

- `AGENT_THEME_BY_TONE`
- `ONE_CAPABILITY_ICON_CLASS_BY_TONE`
- `AGENT_PROFILE_LAUNCHER_PALETTE`

`one-capabilities.ts` re-exports the class map for compatibility, and `AgentSectionIcon` consumes the central registry for icon style and profile launcher colors.

## Target Registry Shape

```ts
export interface AgentTheme {
  accent: string;
  softTint: string;
  onAccent: string;
  iconBackground: string;
  iconForeground: string;
  iconBackgroundDark: string;
  iconForegroundDark: string;
}

export const agentThemeRegistry: Record<string, AgentTheme> = {
  one: {},
  finance: {},
  ria: {},
  kyc: {},
  location: {},
  memory: {},
  consent: {},
  crm: {},
};
```

The registry should be imported by icon, roster, topbar, setup, and agent surfaces. It should not be copied into page-level CSS.

## Migration Rules

- Keep system blue for universal interaction.
- Keep delete/error red semantic even inside colored agent routes.
- Keep success green semantic.
- Keep warning orange/yellow semantic.
- Use neutral icons for peer settings rows.
- Use service/brand identity only for actual service rows with approved bundled assets.
- Do not add new icon packages to solve registry drift.

## Open Verification

- Confirm whether product wants the root `One` section counted in the "seven agents" acceptance gate.
- Confirm whether paused `Gmail` and hidden `Information Marketplace` should be excluded from visual traversal, documented only, or verified as route-addressable exceptions.
