import { Phone } from "lucide-react";

/** US-only emergency action. Opens the dialer; the user still confirms the call. */
export function LocalEmergencyDialerRow() {
  return (
    <a
      href="tel:911"
      aria-label="Call 911"
      className="flex min-h-16 items-center gap-3 rounded-[14px] px-3 py-3 transition-colors hover:bg-black/[0.025] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e0342c]/45 dark:hover:bg-white/[0.04]"
    >
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#fdeeec] dark:bg-[#e0342c]/15">
        <Phone className="h-[18px] w-[18px] text-[#e0342c]" strokeWidth={1.8} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-bold text-foreground">
          Emergency services
        </span>
        <span className="mt-px block truncate text-[13px] text-black/45 dark:text-white/45">
          United States
        </span>
      </span>
      <span
        aria-hidden
        className="flex shrink-0 items-center gap-1.5 rounded-full bg-[#fdeeec] px-[15px] py-[9px] text-[14px] font-semibold text-[#d92c24] dark:bg-[#e0342c]/15 dark:text-[#ff6f66]"
      >
        <Phone className="h-3.5 w-3.5" strokeWidth={2} />
        Call 911
      </span>
    </a>
  );
}
