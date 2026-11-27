import styles from "./connect-row-action.module.css";

/**
 * A directory row's call to action. Both the button target and its visible pill
 * are 44px high. The pill slot keeps local styling independent of Button wrappers.
 * The label takes Profile's action typography through `data-profile-role="action"`
 * on the button, which the pill inherits.
 */
export const CONNECT_ROW_ACTION_CLASSNAME =
  "!h-11 !min-h-11 min-w-[72px] !border-0 !bg-transparent !p-0 !text-[color:var(--app-accent)] disabled:opacity-60";
export const CONNECT_ROW_ACTION_PILL_CLASSNAME =
  `inline-flex h-11 items-center justify-center rounded-full border ${styles.pill}`;
