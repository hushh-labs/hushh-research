# 0-to-1 Iconography Architecture & Snappy Motion System Audit

**Status**: Phase 1 Core Implemented · Active Architecture Standard  
**Governing Skills**: [skills/hushh-icon-theme/SKILL.md](../../skills/hushh-icon-theme/SKILL.md) · [skills/improve-animations/AUDIT.md](../../skills/improve-animations/AUDIT.md)  
**Target Package**: `hushh-webapp`

## Visual Context

This audit covers the shared `hushh-webapp` surfaces that establish One’s visual language: the launcher, app shell, navigation and history sidebar, chat workspace, settings and profile panels, and their responsive mobile layouts. The icon registry and motion tokens described below are the shared primitives used by those surfaces; the replacement registry records the remaining migration scope. The canonical visual owner is the [Quality and Design System Index](../reference/quality/README.md).

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

All animations and transitions across the product adhere to a strict **$\le 150\text{ms}$ hard ceiling**. Sluggish transitions ($>200\text{ms}$) that stall user interaction are removed in favor of snappy, GPU-composited micro-interactions.

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
     - On-device "Puppy" displays local-only machine chats.
   - Chats created or deleted in Puppy mode never affect or bleed into One's cloud history.

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
