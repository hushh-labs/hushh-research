/** Compact row actions use the same pill curve as standard Location CTAs. */
export const LOCATION_COMPACT_ACTION_SHAPE = "rounded-full";

/** Connect's ordinary row action, scoped to matched Location actions only. */
export const LOCATION_CONNECT_ACTION_TARGET_CLASSNAME =
  "!h-11 !min-h-11 min-w-[72px] !border-0 !bg-transparent !p-0 !text-[color:var(--app-accent)] !shadow-none hover:!bg-transparent disabled:opacity-60";

export const LOCATION_CONNECT_ACTION_PILL_CLASSNAME =
  "inline-flex h-11 min-w-[88px] items-center justify-center gap-1.5 rounded-full border border-[color:color-mix(in_srgb,var(--app-accent)_32%,var(--app-card-surface-default-solid))] bg-[color:var(--app-card-surface-default-solid)] px-[15px] text-[color:var(--app-accent)] max-[620px]:min-w-[78px] max-[620px]:px-[11px] max-[350px]:min-w-[72px] max-[350px]:px-[9px]";

export const LOCATION_ACTION_SHAPE =
  "rounded-[20px] [corner-shape:superellipse(1.2)]";
