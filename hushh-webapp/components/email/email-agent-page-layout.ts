/**
 * A connection screen must grow and scroll on short phones. Do not replace this
 * min-height shell with a fixed viewport height and overflow-hidden: doing so
 * clips the final connect or chat action behind persistent app chrome.
 */
export const EMAIL_AGENT_SETUP_SHELL_CLASSNAME =
  "motion-step-enter flex min-h-[calc(100dvh-var(--top-shell-reserved-height,4rem)-var(--app-bottom-inset,2rem))] w-full flex-col items-center justify-center gap-4 pb-[calc(var(--app-bottom-inset)+1rem)]";

export const EMAIL_AGENT_SETUP_REGION_CLASSNAME = "w-full max-w-md mx-auto";
