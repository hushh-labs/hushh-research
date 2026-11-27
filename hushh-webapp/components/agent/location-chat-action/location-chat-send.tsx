import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";

/** Keep the action beside the current chat reply as its conversation advances. */
export function LocationChatSend({ host, label, busy, onSend }: {
  host?: HTMLElement | null;
  label: string;
  busy: boolean;
  onSend: () => void;
}) {
  const button = <Button type="button" size="sm" className="min-h-11 rounded-full px-4"
    isLoading={busy} onClick={onSend}>{label}</Button>;
  return host === undefined ? button : host ? createPortal(button, host) : null;
}
