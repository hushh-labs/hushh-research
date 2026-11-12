import { cn } from "@/lib/utils";
import {
  COMPACT_ONBOARDING_COLUMNS_CLASSNAME,
  COMPACT_ONBOARDING_DIALOG_SIZE_CLASSNAME,
  COMPACT_ONBOARDING_INSETS_CLASSNAME,
  SAVE_LOCATION_SURFACE_BORDER_CLASSNAME,
  SAVE_LOCATION_SURFACE_SHADOW_CLASSNAME,
} from "./save-location-sheet-layout";

export const READY_SURFACE_CLASSNAME = cn(
  "grid min-h-0 w-full grid-cols-1 grid-rows-[auto_minmax(0,1fr)] gap-y-3 overflow-hidden bg-[color:var(--app-grouped-background)]",
  "max-sm:!h-full max-sm:!max-h-full sm:rounded-[20px] sm:border",
  COMPACT_ONBOARDING_DIALOG_SIZE_CLASSNAME,
  COMPACT_ONBOARDING_INSETS_CLASSNAME,
  COMPACT_ONBOARDING_COLUMNS_CLASSNAME,
  SAVE_LOCATION_SURFACE_BORDER_CLASSNAME,
  SAVE_LOCATION_SURFACE_SHADOW_CLASSNAME,
);

export const READY_MAP_CLASSNAME =
  "hidden h-full min-h-0 overflow-hidden rounded-[20px] md:col-start-1 md:row-start-2 md:block";

export const READY_CODE_CLASSNAME =
  "mt-2 select-all whitespace-nowrap font-mono text-[clamp(20px,6vw,28px)] font-bold uppercase leading-[1.15] tracking-[0.12em] text-[color:var(--app-label)]";

export const READY_PANEL_CLASSNAME =
  "relative flex h-full min-h-0 flex-col overflow-hidden md:col-start-2 md:row-start-2 md:self-center md:h-auto md:max-h-full";

export const READY_PANEL_DIALOG_MIN_WIDTH_PX = 768;
export const READY_PANEL_DIALOG_WIDTH_PX = 390;
