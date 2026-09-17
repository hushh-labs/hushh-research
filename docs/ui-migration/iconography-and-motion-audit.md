# 0-to-1 Iconography Architecture & Snappy Motion System Audit

**Status**: Phase 1 Core Implemented · Active Architecture Standard  
**Governing Skills**: [skills/hushh-icon-theme/SKILL.md](../../skills/hushh-icon-theme/SKILL.md) · [skills/improve-animations/AUDIT.md](../../skills/improve-animations/AUDIT.md)  
**Target Package**: `hushh-webapp`

## Visual Context

Canonical visual owner: [Quality and Design System Index](../reference/quality/README.md).
Visual standard: Flat Phosphor duotone vector geometry and obsidian high-contrast surfaces governed by [skills/hushh-icon-theme/SKILL.md](../../skills/hushh-icon-theme/SKILL.md).
Motion standard: Hard-capped $\le 150\text{ms}$ transitions and 60-120fps GPU compositing governed by [skills/improve-animations/AUDIT.md](../../skills/improve-animations/AUDIT.md).

---

## 1. Iconography Architecture: Phosphor Duotone Standard

To establish visual coherence across the entire application and maintain strict parity with the canonical `/one` launcher route, all icons must strictly adhere to the flat Phosphor duotone geometry baseline.

### Key Rules
1. **Official Phosphor Geometry Base**: Native `viewBox="0 0 256 256"`. Zero viewBox clipping.
2. **Duotone Depth**: Primary silhouette at 100% opacity; secondary contour/accent path at 20% opacity (`opacity="0.2"`).
3. **Palette Specialization**:
   - **Capability Icons**: Rendered with single-hue signature tones (Finance `#10B981`, Wallet `#F59E0B`, Location `#EF4444`, RIA `#8B5CF6`, Gmail `#E11D48`, Calendar `#0284C7`, KYC `#2563EB`, Memory `#6366F1`, Consent `#F97316`, Marketplace `#059669`, Connected `#00E5FF`).
   - **Neutral UI Icons**: Inherit `currentColor` with duotone depth for subtle elevation.
4. **Single Source of Import**: Components must import from `@/components/icons` rather than ad-hoc `lucide-react` imports.

### UI Replacement Registry

| Legacy Lucide Icon | Canonical Phosphor Component | Export Name in `@/components/icons` | Default Weight | Status |
|---|---|---|---|---|
| `Search` | `MagnifyingGlass` | `SearchIcon` | `duotone` | ✅ Migrated |
| `Grid` / `LayoutGrid` | `SquaresFour` | `GridIcon` | `duotone` | ✅ Migrated |
| `List` / `Menu` | `List` | `ListIcon`, `MenuIcon` | `duotone` | ✅ Migrated |
| `ChevronRight` | `CaretRight` | `CaretRightIcon`, `ChevronRightIcon` | `duotone` | ✅ Migrated |
| `ChevronDown` | `CaretDown` | `CaretDownIcon`, `ChevronDownIcon` | `duotone` | ✅ Migrated |
| `ChevronLeft` | `CaretLeft` | `CaretLeftIcon`, `ChevronLeftIcon` | `duotone` | ✅ Migrated |
| `ChevronUp` | `CaretUp` | `CaretUpIcon`, `ChevronUpIcon` | `duotone` | ✅ Migrated |
| `ArrowLeft` | `ArrowLeft` | `ArrowLeftIcon` | `duotone` | ✅ Migrated |
| `ArrowRight` | `ArrowRight` | `ArrowRightIcon` | `duotone` | ✅ Migrated |
| `Plus` | `Plus` | `PlusIcon` | `duotone` | ✅ Migrated |
| `X` | `X` | `XIcon`, `CloseIcon` | `duotone` | ✅ Migrated |
| `Check` | `Check` | `CheckIcon` | `duotone` | ✅ Migrated |
| `Trash` / `Trash2` | `Trash` | `TrashIcon` | `duotone` | ✅ Migrated |
| `Pencil` / `Edit` | `PencilSimple` | `PencilIcon` | `duotone` | ✅ Migrated |
| `Copy` | `Copy` | `CopyIcon` | `duotone` | ✅ Migrated |
| `Send` | `PaperPlaneRight` | `SendIcon` | `duotone` | ✅ Migrated |
| `Mic` / `Microphone` | `Microphone` | `MicrophoneIcon` | `duotone` | ✅ Migrated |
| `Sparkles` | `Sparkle` | `SparkleIcon` | `duotone` | ✅ Migrated |
| `Settings` / `Gear` | `GearSix` | `GearIcon`, `SettingsIcon` | `duotone` | ✅ Migrated |
| `Sliders` | `Sliders` | `SlidersIcon` | `duotone` | ✅ Migrated |
| `MoreHorizontal` | `DotsThree` | `DotsThreeIcon`, `MoreHorizontalIcon` | `duotone` | ✅ Migrated |
| `ExternalLink` | `ArrowSquareOut` | `ExternalLinkIcon` | `duotone` | ✅ Migrated |
| `Sidebar` | `SidebarSimple` | `PanelLeftCloseIcon`, `PanelLeftOpenIcon` | `duotone` | ✅ Migrated |
| `Shield` | `ShieldCheck` | `ShieldIcon` | `duotone` | ✅ Migrated |
| `Lock` | `LockKey` | `LockIcon` | `duotone` | ✅ Migrated |
| `User` | `User` | `UserIcon` | `duotone` | ✅ Migrated |
| `Laptop` | `Laptop` | `LaptopIcon` | `duotone` | ✅ Migrated |
| `Key` | `Key` | `KeyIcon` | `duotone` | ✅ Migrated |
| `Mail` | `EnvelopeSimple` | `MailIcon` | `duotone` | ✅ Migrated |
| `LogOut` | `SignOut` | `LogOutIcon` | `duotone` | ✅ Migrated |

---

## 2. Snappy Motion System: Hard $\le 150\text{ms}$ Rule

Interactive motion has a **150ms ceiling**. This is an authoring requirement,
not proof that every legacy surface has been migrated or that a device meets
a measured frame-rate target. Continuous loading indicators have independent
durations.

### Token Scale (`app/globals.css`)

```css
--motion-duration-xs: 75ms;   /* Instant tactile taps, press states */
--motion-duration-sm: 100ms;  /* Checkmarks, fast toggles */
--motion-duration-md: 125ms;  /* Segmented controls, badge shifts */
--motion-duration-lg: 140ms;  /* Dropdowns, tooltips, popovers */
--motion-duration-xl: 150ms;  /* Modals, drawers, full sheets (MAX) */
--motion-duration-xxl: 150ms; /* Hard capped ceiling */

--motion-overlay-enter-duration: 150ms;
--motion-overlay-exit-duration: 100ms;
--motion-route-enter-duration: 140ms;
--motion-route-exit-duration: 90ms;
```

### Performance & Compositing Mandates
- **Animate only `transform` and `opacity`**: Eliminates layout recalculations and browser reflows.
- **Hardware Layer Promotion**: High-frequency interactive elements leverage `transform-gpu` or `will-change: transform`.
- **Zero `transition: all`**: Prevents accidental transitions on CPU-bound layout properties like `height` or `padding`.

---

## 3. Chat Workspace Interactivity & Symmetry Fixes

1. **Three-Dot Menu Clickability**:
   - Resolved pointer-down event suppression on `DropdownMenuTrigger` in `components/agent/agent-history-sidebar.tsx`.
   - Elevated `DropdownMenuContent` z-index to `z-[560]` so it renders cleanly above the history drawer container (`z-[550]`).
   - Enabled inline rename mode and destructive delete alert dialogs from row actions.
2. **Header Left-Alignment**:
   - Removed `hideCloseButton && "pl-11"` offset in `agent-history-sidebar.tsx`.
   - Sidebar title ("Chats" / "Puppy chats") is now flush left with consistent padding.
3. **New Chat Button Scale & Symmetry**:
   - Re-scaled the `Plus` icon from strokeWidth 3 inside a colored box badge to a refined `14px` icon with strokeWidth 2.2.
   - Symmetrized vertical and horizontal padding to match surrounding controls.
4. **Puppy vs One Session Partitioning**:
   - Added dedicated `puppyConversations` and `puppyConversationId` state in `components/agent/agent-chat-workspace.tsx`.
   - Toggling between One and Puppy mode now switches the sidebar conversation list:
     - Cloud "One" displays vault-backed cloud chats.
   - On-device "Puppy" displays workspace-session chats held in browser memory.
   - Each Puppy chat owns a mounted Hermes panel, transcript, draft, and server
     session reference. Selection changes visibility without interrupting streams.
     Hidden panels stop polling. Deletion and account changes unmount panels and
     abort pending requests. They do not delete server-side Hermes records.
   - Conversation titles are not stored in localStorage. The obsolete unowned
     title index is discarded; it contained no transcript or resumable session.
   - Sign-out, account changes, a full reload, or leaving the workspace clear this
     memory. Durable encrypted Puppy history is outside this change.

---

## 4. Phased Surface Rollout Plan

- **Phase 1 (Completed)**:
  - Centralized Phosphor UI Registry (`components/icons/`)
  - Motion tokens & <150ms ceiling (`app/globals.css`)
  - High-traffic surfaces: `top-app-bar.tsx`, `settings-ui.tsx`, `profile-pane.tsx`, `agent-history-sidebar.tsx`, `agent-chat-workspace.tsx`, `/one` launcher
- **Phase 2 (Queued)**:
  - Vault unlock & biometrics (`components/vault/`)
  - Connect & Circles directory (`components/connect/`)
  - One Voice action cards (`components/one-voice/`)
  - Onboarding steps (`components/onboarding/`)
- **Phase 3 (Queued)**:
  - Secondary developer tools & long-tail debug cards

## Verification checkpoint — 2026-09-17

The follow-up fixes wire Puppy history selection into actual mounted chat
panels, remove the shared plaintext title store, use the canonical sidebar
icons, and align route, drawer, sheet-drag, and voice-meter motion.
The desktop sidebar changes width without interpolating layout on every frame;
the mobile drawer retains a transform transition. Reduced motion disables its
transition and the sheet drag-settlement transition.

Focused verification commands:

```bash
cd hushh-webapp
npx vitest run __tests__/agent/puppy-conversations.test.tsx __tests__/agent/puppy-one-surface.test.tsx __tests__/agent/hermes-chat-panel-transcript.test.tsx __tests__/agent/hermes-chat-panel-link-states.test.tsx __tests__/navigation/route-transition* __tests__/components/bottom-sheet-drag-dismiss.contract.test.tsx __tests__/components/one-dashboard-page.test.tsx
npm run typecheck
npm run verify:design-system
npm run verify:docs
npm run verify:cache
```

These passed (48 focused tests and 62 cache tests). The originally proposed
`__tests__/components/agent-chat-workspace.test.tsx` does not exist; the tests
above verify the actual session and transcript owners.

### Follow-up acceptance

The final focused suite passes 57 tests across 11 files, including regression
coverage for the service scanner and reviewer bootstrap. Typecheck, design-system,
documentation, service-boundary, reviewer-harness and native static checks pass.
The broader `npm run verify:agent-surface` suite also passes 245 tests across
28 files. These suites overlap; their totals are not additive.
The service scanner now excludes test assertions without exempting production
components; its fixture proves a real component-level fetch is still rejected.

The signed-in sweep now bootstraps canonical `/` instead of forcing the RIA
persona. `HUSHH_ROUTE_FILTER='=/' npm run verify:routes` passes at phone, tablet,
laptop and desktop widths. This is root coverage, not an all-route sweep.
Failure diagnostics retain sanitized state and pathname, not page text or owner IDs.

Canonical reviewer rehearsals proved a visible cold vault gate, same-session
unlock continuity, separate cold-session re-unlock, and a real cloud Chat prompt
round trip. The new reproducible UI acceptance command is:

```bash
REVIEWER_APP_ORIGIN=http://localhost:3000 REVIEWER_ALLOW_SHARED_MUTATIONS=true \
  node .codex/skills/reviewer-app-testing/scripts/verify-reviewer-chat-ui-plan.mjs
```

This run requires current-task mutation authority: normal post-unlock PKM
reconciliation can write. It is not a read-only pass. The default guard remains
intact; only the source-verified metadata read `POST /api/vault/status` joins its
exact read allowlist. Credentials and decrypted information remain in memory.

At desktop 1440px and phone 390px, the UI rehearsal passes heading alignment,
symmetric New chat padding, menu viewport placement,
rename autofocus/save, delete confirmation, One/Puppy list isolation, Phosphor
viewBoxes, hover foreground inheritance, pointer cursor, no horizontal overflow,
150ms drawer duration, reduced motion and vault continuity. Fixed-label menu
screenshots were visually inspected; no transcript or account screenshots are
retained. Puppy local rename/delete no longer emit a toast that can cover the
mobile mode switch. Opening Puppy history no longer fetches the cloud chat list.
The registry now includes the previously missing `ShieldIcon`; shared button,
theme, fade and composer transitions no longer use the audited over-budget or
layout-interpolating declarations.

Browser rAF sampling exposed the full-viewport blurred drawer backdrop as a
performance concern. Removing that blur while preserving the opacity dimmer and
transform drawer improved the isolated desktop sample from median 23.9ms / p95
50.3ms to median 10.1ms / p95 18.1ms (33 intervals). Phone measured median 8.3ms /
p95 9.2ms (48 intervals). These short headless development samples are diagnostic,
not a sustained FPS benchmark or physical-device guarantee. Native static validation
and static export do not establish physical-device animation performance or real
on-device model responses. Those remain separate runtime acceptance obligations.

Migration census: 309 files under `hushh-webapp/{app,components,lib}` still
import Lucide. Reproduce with
`rg -l 'from ["\\x27]lucide-react' hushh-webapp/{app,components,lib} | wc -l`.
Registry availability is not a repository-wide migration claim; Phases 2 and 3
remain queued.
