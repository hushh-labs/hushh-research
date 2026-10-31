"use client";

function canUseClipboardApi(): boolean {
  return Boolean(
    typeof navigator !== "undefined" &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === "function",
  );
}

function canUseDocument(): boolean {
  return typeof document !== "undefined" && Boolean(document.body);
}

export async function copyToClipboard(
  value: string,
  isCurrentSession: () => boolean = () => true,
): Promise<boolean> {
  if (!isCurrentSession()) return false;
  if (canUseClipboardApi()) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Fall through to the textarea fallback below.
    }
  }

  // A rejected asynchronous write may outlive the draft that initiated it.
  if (!isCurrentSession() || !canUseDocument()) {
    return false;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";

  try {
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}
