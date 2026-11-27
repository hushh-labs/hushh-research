import { cva, type VariantProps } from "class-variance-authority";

// Press is flat: a colour/opacity state change plus the ripple the Button
// renders. No press scale, spring, or bounce (guarded by
// __tests__/components/press-ripple.contract.test.tsx).
//
// Core Pill Design System: every action button uses crisp pill geometry
// (`rounded-full`) with disciplined heights (32px compact/sm, 36px default/standard,
// 40px prominent/lg) and clean fine-pointer hover contrast without muddy overlays.
export const buttonVariants = cva(
  "relative isolate inline-flex items-center justify-center gap-1.5 overflow-hidden whitespace-nowrap rounded-full transition-[opacity,color,background-color,border-color,box-shadow] motion-reduce:transition-none duration-[140ms] ease-[cubic-bezier(0.22,1,0.36,1)] active:enabled:opacity-[0.88] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-3.5 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-[color:var(--app-accent)] focus-visible:ring-[color:var(--app-focus-ring)] focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive touch-manipulation",
  {
    variants: {
      variant: {
        // Solid accent fill for primary actions with crisp fine-pointer hover
        // darkening and subtle 1px top specular edge.
        default:
          "bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)] shadow-[inset_0_1px_0_rgba(255,255,255,0.20),0_1px_2px_rgba(0,0,0,0.08)] [@media(hover:hover)_and_(pointer:fine)]:hover:bg-[color:var(--app-accent-hover)] [@media(hover:hover)_and_(pointer:fine)]:hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.22),0_2px_6px_rgba(0,113,227,0.22)]",
        destructive:
          "bg-[color:var(--app-destructive)] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_1px_2px_rgba(0,0,0,0.08)] [@media(hover:hover)_and_(pointer:fine)]:hover:[background-color:color-mix(in_srgb,var(--app-destructive)_88%,black_12%)] focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40",
        outline:
          "border border-black/[0.11] dark:border-white/[0.14] bg-[color:var(--app-card-surface-default-solid)] text-foreground shadow-[0_1px_1px_rgba(0,0,0,0.03)] [@media(hover:hover)_and_(pointer:fine)]:hover:bg-[color:var(--app-neutral-fill)] [@media(hover:hover)_and_(pointer:fine)]:hover:border-black/[0.18] dark:[@media(hover:hover)_and_(pointer:fine)]:hover:border-white/[0.22]",
        secondary:
          "border border-black/[0.07] dark:border-white/[0.09] bg-[color:var(--app-neutral-fill)] text-foreground shadow-none [@media(hover:hover)_and_(pointer:fine)]:hover:bg-[color:var(--app-neutral-fill-strong)] [@media(hover:hover)_and_(pointer:fine)]:hover:border-black/[0.12] dark:[@media(hover:hover)_and_(pointer:fine)]:hover:border-white/[0.15]",
        subdued:
          "border border-transparent bg-[color:var(--app-neutral-fill)]/75 text-[color:var(--app-secondary-label)] shadow-none [@media(hover:hover)_and_(pointer:fine)]:hover:bg-[color:var(--app-neutral-fill-strong)] [@media(hover:hover)_and_(pointer:fine)]:hover:text-foreground",
        ghost:
          "text-[color:var(--app-accent)] [@media(hover:hover)_and_(pointer:fine)]:hover:bg-[color:var(--app-accent-tint)]",
        plain: "bg-transparent text-foreground [@media(hover:hover)_and_(pointer:fine)]:hover:bg-foreground/[0.05]",
        text: "min-h-0 rounded-none bg-transparent text-[color:var(--app-accent)] [@media(hover:hover)_and_(pointer:fine)]:hover:text-[color:var(--app-accent-hover)]",
        link: "min-h-0 rounded-none text-[color:var(--app-accent)] underline-offset-4 [@media(hover:hover)_and_(pointer:fine)]:hover:underline",
      },
      size: {
        default:
          "ui-text-button-label min-h-9 h-9 [@media(pointer:coarse)]:min-h-10 rounded-full px-4 py-1.5 has-[>svg]:px-3.5",
        /**
         * Semantic pill action-size scale:
         * - compact  = 32px toolbars, inline card actions, utility controls
         * - standard = 36px ordinary form, dialog, and sheet actions
         * - prominent = 40px primary flow commits
         */
        standard:
          "ui-text-button-label min-h-9 h-9 [@media(pointer:coarse)]:min-h-10 rounded-full px-4 has-[>svg]:px-3.5",
        prominent:
          "ui-text-button-label min-h-10 h-10 [@media(pointer:coarse)]:min-h-11 rounded-full px-5 has-[>svg]:px-4 [&_svg:not([class*='size-'])]:size-4",
        compact:
          "ui-text-compact-button-label min-h-8 h-8 [@media(pointer:coarse)]:min-h-9 rounded-full gap-1.5 px-3.5 has-[>svg]:px-3",
        row: "min-h-7 h-7 rounded-full gap-1.5 px-3 py-0.5 text-[12px] font-medium leading-[16px] has-[>svg]:px-2.5 [&_svg:not([class*='size-'])]:size-3.5",
        xs: "min-h-7 h-7 gap-1 rounded-full px-3 text-[12px] font-medium leading-[16px] has-[>svg]:px-2.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "min-h-8 h-8 rounded-full gap-1.5 px-3.5 text-[12.5px] font-medium leading-[16px] tracking-[-0.006em] has-[>svg]:px-3 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "ui-text-button-label min-h-10 h-10 [@media(pointer:coarse)]:min-h-11 rounded-full px-5 has-[>svg]:px-4 [&_svg:not([class*='size-'])]:size-4",
        icon: "size-8 rounded-full",
        "icon-touch": "size-9 [@media(pointer:coarse)]:size-11 rounded-full",
        "icon-xs": "size-6 rounded-full [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7 rounded-full",
        "icon-lg": "size-9 rounded-full",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export type ButtonVariantProps = VariantProps<typeof buttonVariants>;
