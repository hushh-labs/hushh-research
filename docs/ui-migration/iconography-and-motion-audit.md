# 0-to-1 Iconography Architecture & Snappy Motion System Audit

**Status**: Application-wide registry migration implemented · Rendered/native acceptance in progress

**Governing Skills**: [skills/hushh-icon-theme/SKILL.md](../../skills/hushh-icon-theme/SKILL.md) · [skills/improve-animations/AUDIT.md](../../skills/improve-animations/AUDIT.md)  
**Target Package**: `hushh-webapp`

## Visual Context

This audit covers the shared `hushh-webapp` launcher, shell, navigation, chat,
settings, profile, and responsive mobile surfaces. The canonical visual owner is
the [Quality and Design System Index](../reference/quality/README.md).
The portable skills linked above own Phosphor icon authoring and the 150ms
interactive motion budget; host-specific skill bridges point to those files.
Rendered and native performance still require acceptance evidence.

---

## 1. Iconography Architecture: Phosphor Duotone Standard

Capability icons use flat Phosphor duotone geometry. Neutral controls use the
same Phosphor geometry with regular weight so close, add, and navigation glyphs
do not acquire filled backplates.

### Key Rules
1. **Official Phosphor Geometry Base**: Native `viewBox="0 0 256 256"`. Zero viewBox clipping.
2. **Capability Duotone Depth**: Primary silhouette at 100% opacity; secondary contour/accent path at 20% opacity (`opacity="0.2"`).
3. **Palette Specialization**:
   - **Capability Icons**: Rendered with single-hue signature tones (Finance `#10B981`, Wallet `#F59E0B`, Location `#EF4444`, RIA `#8B5CF6`, Gmail `#E11D48`, Calendar `#0284C7`, KYC `#2563EB`, Memory `#6366F1`, Consent `#F97316`, Marketplace `#059669`, Connected `#00E5FF`).
   - **Neutral UI Icons**: Inherit `currentColor` with regular geometry. Utility controls never receive a secondary fill that can be mistaken for an icon background; capability icons retain duotone depth.
4. **Single Source of Import**: Runtime components import from `@/components/icons`. The typed compatibility facade maps legacy names to official Phosphor geometry while callers migrate without changing their public props.

### UI Replacement Registry

| Legacy Lucide Icon | Canonical Phosphor Component | Export Name in `@/components/icons` | Default Weight | Status |
|---|---|---|---|---|
| `Search` | `MagnifyingGlass` | `SearchIcon` | `regular` | ✅ Migrated |
| `Grid` / `LayoutGrid` | `SquaresFour` | `GridIcon` | `regular` | ✅ Migrated |
| `List` / `Menu` | `List` | `ListIcon`, `MenuIcon` | `regular` | ✅ Migrated |
| `ChevronRight` | `CaretRight` | `CaretRightIcon`, `ChevronRightIcon` | `regular` | ✅ Migrated |
| `ChevronDown` | `CaretDown` | `CaretDownIcon`, `ChevronDownIcon` | `regular` | ✅ Migrated |
| `ChevronLeft` | `CaretLeft` | `CaretLeftIcon`, `ChevronLeftIcon` | `regular` | ✅ Migrated |
| `ChevronUp` | `CaretUp` | `CaretUpIcon`, `ChevronUpIcon` | `regular` | ✅ Migrated |
| `ArrowLeft` | `ArrowLeft` | `ArrowLeftIcon` | `regular` | ✅ Migrated |
| `ArrowRight` | `ArrowRight` | `ArrowRightIcon` | `regular` | ✅ Migrated |
| `Plus` | `Plus` | `PlusIcon` | `regular` | ✅ Migrated |
| `X` | `X` | `XIcon`, `CloseIcon` | `regular` | ✅ Migrated |
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
--motion-route-enter-duration: 90ms;
--motion-route-exit-duration: 60ms;
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

## 4. Application completion ledger

| Surface | Source status | Rendered proof | Native proof |
|---|---|---|---|
| Shell, `/one`, bottom navigation and top bar | Registry imports | Focused component contracts | Pending device run |
| Profile pane and nested settings | Registry imports and `/one` capability mappings | Focused Profile rehearsal | Pending device run |
| Chat, history drawer and Puppy/One controls | Registry imports; sessions remain isolated | Reviewer UI rehearsal | Pending device run |
| Vault, onboarding, Connect, Finance, Location and voice | Registry imports; branded/diagram SVGs remain owned exceptions | Focused route contracts pending full-suite green | Pending device run |
| Developer and secondary surfaces | Registry imports | Full-suite and visual audit pending | Pending device run |
| Inline SVG charts, maps, provider logos and illustrations | Reviewed non-UI-icon exceptions | Owner-specific visual tests | N/A |

The runtime census now reports zero `lucide-react` imports under
`hushh-webapp/{app,components,lib}`. This is an import-source result, not by itself
proof of visual equivalence; the rendered and device columns remain release gates.

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

### Sidebar and Profile visual follow-up

New chat now selects the shared small button size, avoiding the default 50px
minimum and primary-action padding. Its 36px silhouette matches search, with a
transparent 44px hit area. Header, search and list use one inset. The drawer
starts at the actual chat-header height, not the unrelated reserved app-shell
height; its top corner is flush and safe-area clearance is owned by the header.

The close and add glyphs default to official Phosphor regular: the duotone
variants contained square backplates. Profile's close control has no raised
shadow/border, while capability glyphs retain duotone. The animated menu/close
control now crossfades registry icons instead of drawing custom bars.
Profile's 17 authored icon consumers, plus its theme, Gemini and Kai preference
controls, import the registry; section-header types are vendor-neutral.

Codex and Claude icon bridges resolve to the same canonical skill with identical
frontmatter and body. Tests enforce bridge equality, transparent close/add paths,
capability duotone and Profile import ownership. The reviewer rehearsal verifies
rendered button height, shared insets, zero header/drawer gap and the flat Profile
close control on mobile and desktop. Fixed-label control crops are safe visual
evidence; entire authenticated pages are not captured.

The previous migration census found 309 files with Lucide imports. The application
source pass now uses the registry facade across all runtime files; reproduce with
`rg -l 'from ["\\x27]lucide-react' hushh-webapp/{app,components,lib} | wc -l`.
