import { ContactRound } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function ContactSourceBadge({ className }: { className?: string }) {
  return (
    <Badge
      variant="secondary"
      className={cn(
        "h-5 max-w-full gap-1 bg-[color:var(--app-neutral-fill)] px-1.5 text-[10px] font-medium leading-none text-[color:var(--app-secondary-label)]",
        className,
      )}
      aria-label="Connected from your contacts"
    >
      <ContactRound className="h-3 w-3" aria-hidden="true" />
      <span>From contacts</span>
    </Badge>
  );
}
