"use client";

import * as React from "react";

type AccessibilityStatusAnnouncerProps = {
  message: string;
  assertive?: boolean;
};

export function AccessibilityStatusAnnouncer({
  message,
  assertive = false,
}: AccessibilityStatusAnnouncerProps) {
  const [debouncedMessage, setDebouncedMessage] = React.useState("");

  // Small debounce to ensure screen readers register the new text
  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (message) {
      timer = setTimeout(() => setDebouncedMessage(message), 50);
    } else {
      setDebouncedMessage("");
    }
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [message]);

  if (!debouncedMessage) return null;

  return (
    <div
      role="status"
      aria-live={assertive ? "assertive" : "polite"}
      aria-atomic="true"
      className="sr-only"
    >
      {debouncedMessage}
    </div>
  );
}