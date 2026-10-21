import { ContactsBookIcon } from "@/components/icons";
import { cn } from "@/lib/utils";

export function ContactSourceBadge({ className }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label="Connected from your contacts"
      className={cn("inline-flex size-4 shrink-0 items-center justify-center align-middle", className)}
    >
      <ContactsBookIcon className="size-full" aria-hidden="true" />
    </span>
  );
}
