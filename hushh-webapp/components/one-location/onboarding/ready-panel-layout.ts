/** Shared composition measured by the real-browser layout pack. */
export const READY_SURFACE_CLASSNAME =
  "mx-auto grid h-full min-h-0 w-full max-w-[1120px] flex-1 grid-cols-1 grid-rows-[auto_minmax(0,1fr)] gap-x-6 overflow-hidden bg-[color:var(--app-grouped-background)] px-4 pb-[max(env(safe-area-inset-bottom,0px),12px)] pt-[max(var(--app-safe-area-top-effective,0px),8px)] sm:px-6 md:grid-cols-[minmax(0,1fr)_390px] md:py-6";

export const READY_MAP_CLASSNAME =
  "hidden h-full min-h-0 overflow-hidden rounded-[20px] md:col-start-1 md:row-start-2 md:block";

export const READY_CODE_CLASSNAME =
  "mt-2 select-all whitespace-nowrap font-mono text-[clamp(20px,6vw,28px)] font-bold uppercase leading-[1.15] tracking-[0.12em] text-[color:var(--app-label)]";

export const READY_PANEL_CLASSNAME =
  "relative flex h-full min-h-0 flex-col overflow-hidden md:col-start-2 md:row-start-2";

export const READY_PANEL_DIALOG_MIN_WIDTH_PX = 768;
export const READY_PANEL_DIALOG_WIDTH_PX = 390;
