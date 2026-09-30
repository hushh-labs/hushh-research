/** Shared presentation only: live chat and the read-only product introduction. */
export const CHAT_USER_BUBBLE_CLASSNAME =
  "rounded-[22px] rounded-br-[7px] bg-[linear-gradient(145deg,var(--app-accent),var(--app-accent-deep))] px-4 py-2 text-[color:var(--app-accent-fg)] shadow-[0_14px_34px_-24px_var(--app-accent-deep)]";

export const CHAT_ASSISTANT_BODY_CLASSNAME = "px-1 py-2 text-foreground";

/**
 * One's answer bubble (Muse-style, scoped to One's chat; the shared
 * `CHAT_ASSISTANT_BODY_CLASSNAME` stays as it is for the product introduction).
 * Insets sit on the 4pt grid and match left to right, so
 * a code block or table inside lines up with the prose edge on both sides.
 */
export const ONE_CHAT_ASSISTANT_BUBBLE_CLASSNAME =
  "rounded-[24px] bg-[color:var(--one-chat-bubble)] px-4 py-3 text-[15px] leading-6 text-foreground";
