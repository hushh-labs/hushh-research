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
    if (message) {
      const timer = setTimeout(() => setDebouncedMessage(message), 50);
      return () => clearTimeout(timer);
    }
    setDebouncedMessage("");
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