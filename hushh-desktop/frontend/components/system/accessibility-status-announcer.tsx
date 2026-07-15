"use client";

type AccessibilityStatusAnnouncerProps = {
  message: string;
  assertive?: boolean;
};

export function AccessibilityStatusAnnouncer({
  message,
  assertive = false,
}: AccessibilityStatusAnnouncerProps) {
  if (!message) return null;

  return (
    <div
      role="status"
      aria-live={assertive ? "assertive" : "polite"}
      aria-atomic="true"
      className="sr-only"
    >
      {message}
    </div>
  );
}