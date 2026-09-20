import { cva, type VariantProps } from "class-variance-authority"

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full transition-[transform,opacity,color,background-color,border-color,box-shadow] motion-reduce:transition-none duration-100 ease-out press-scale active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-[color:var(--app-accent)] focus-visible:ring-[color:var(--app-focus-ring)] focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive touch-manipulation",
  {
    variants: {
      variant: {
        // Filled actions carry the Liquid Glass material (founder decision,
        // 2026-09-20; app/globals.css `.morphy-liquid`): the fill colour stays
        // with the variant and its hover partner, the material adds the rim,
        // gloss, depth and halo in that colour. destructive keeps its own
        // solid red fill -- a neutral-fill "red text only" treatment would
        // make it visually indistinguishable from a plain neutral action by
        // background alone (see e2e/one-location-check-in-panel.layout.spec.ts,
        // which asserts exactly that a non-destructive action never shares
        // destructive's background).
        default:
          "morphy-liquid bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent-hover)]",
        destructive:
          "morphy-liquid [--liquid-base:var(--app-destructive)] bg-[color:var(--app-destructive)] text-white hover:[background-color:color-mix(in_srgb,var(--app-destructive)_88%,black_12%)] focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40",
        outline:
          "morphy-liquid-neutral border border-[color:var(--app-separator)] bg-[color:var(--app-neutral-fill)] text-foreground hover:bg-[color:var(--app-neutral-fill-strong)] dark:border-[color:var(--app-separator)]",
        secondary:
          "morphy-liquid-neutral bg-[color:var(--app-neutral-fill)] text-foreground hover:bg-[color:var(--app-neutral-fill-strong)]",
        ghost:
          "text-[color:var(--app-accent)] hover:bg-[color:var(--app-accent-tint)]",
        link: "min-h-0 rounded-none text-[color:var(--app-accent)] underline-offset-4 hover:underline",
      },
      size: {
        default:
          "ui-text-button-label min-h-[50px] h-[50px] px-4 py-3 has-[>svg]:px-3",
        xs: "min-h-7 h-7 gap-1 rounded-[var(--app-radius-sm)] px-2 text-[13px] font-semibold leading-[18px] has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "min-h-9 h-9 rounded-[var(--app-radius-md)] gap-1.5 px-3 text-[15px] font-semibold leading-[20px] has-[>svg]:px-2.5",
        lg: "ui-text-button-label min-h-[50px] h-[50px] rounded-full px-6 has-[>svg]:px-4",
        icon: "size-9 rounded-full",
        "icon-xs": "size-6 rounded-full [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
)

export type ButtonVariantProps = VariantProps<typeof buttonVariants>
