import { cn } from "@/lib/utils";

export function SmsTextIcon({ className }: { className?: string }) {
  return (
    <span
      className={cn("text-[10px] font-semibold leading-none", className)}
      data-one-sms-text-icon=""
    >
      SMS
    </span>
  );
}
