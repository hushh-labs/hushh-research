import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { cn } from "@/lib/utils";

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

type OneChatBubbleProps = Omit<ComponentPropsWithoutRef<"div">, "children"> & {
  children: ReactNode;
  tone: "user" | "assistant" | "plain";
};

/**
 * The exact bubble primitive used by One's transcript and connection messages.
 * Data surfaces may differ, but visual chat grammar must have one source.
 */
export function OneChatBubble({
  children,
  className,
  tone,
  ...props
}: OneChatBubbleProps) {
  return (
    <div
      className={cn(
        "text-sm leading-6",
        tone === "user"
          ? CHAT_USER_BUBBLE_CLASSNAME
          : tone === "assistant"
            ? ONE_CHAT_ASSISTANT_BUBBLE_CLASSNAME
            : "px-0 py-1 text-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

/** The centered date/time marker that starts a One chat message group. */
export function OneChatTimeSeparator({
  dateTime,
  label,
  accessibleLabel = label,
}: {
  accessibleLabel?: string;
  dateTime?: string;
  label: string;
}) {
  const content = (
    <>
      <span aria-hidden="true">{label}</span>
      <span className="sr-only">{accessibleLabel}</span>
    </>
  );

  return (
    <div className="flex justify-center whitespace-nowrap pb-0.5 pt-2 first:pt-0">
      {dateTime ? (
        <time
          dateTime={dateTime}
          title={accessibleLabel}
          className="whitespace-nowrap text-[12.5px] font-medium tabular-nums text-[color:var(--one-chat-meta)]"
        >
          {content}
        </time>
      ) : (
        <span className="whitespace-nowrap text-[12.5px] font-medium tabular-nums text-[color:var(--one-chat-meta)]">
          {content}
        </span>
      )}
    </div>
  );
}
