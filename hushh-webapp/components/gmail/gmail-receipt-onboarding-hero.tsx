import {
  AirplaneTilt,
  ChevronRight,
  ForkKnife,
  Loader2,
  ShoppingBag,
  type LucideIcon,
} from "@/components/icons";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/lib/morphy-ux/button";

type ReceiptCategory = {
  label: string;
  icon: LucideIcon;
  iconClassName: string;
  progressClassName: string;
  progressWidthClassName: string;
  iconWeight?: "fill" | "regular";
};

const RECEIPT_CATEGORIES: ReadonlyArray<ReceiptCategory> = [
  {
    label: "Shopping",
    icon: ShoppingBag,
    iconClassName:
      "bg-[color:var(--app-accent-tint)] text-[color:var(--app-accent)]",
    progressClassName: "bg-[color:var(--app-accent)]",
    progressWidthClassName: "w-4/5",
    iconWeight: "regular",
  },
  {
    label: "Dining",
    icon: ForkKnife,
    iconClassName: "bg-emerald-50 text-emerald-600",
    progressClassName: "bg-emerald-500",
    progressWidthClassName: "w-3/5",
    iconWeight: "regular",
  },
  {
    label: "Travel",
    icon: AirplaneTilt,
    iconClassName: "bg-indigo-50 text-indigo-500",
    progressClassName: "bg-indigo-500",
    progressWidthClassName: "w-2/3",
    iconWeight: "fill",
  },
];

/**
 * First-visit orientation for the Mail receipts workspace. The category card
 * is a visual preview only; the primary action keeps the existing receipt
 * sync flow supplied by the parent.
 */
export function GmailReceiptOnboardingHero({
  onStartReceiptSync,
  syncAvailable = false,
  syncing = false,
  statusMessage = null,
  statusTone = "neutral",
  progressPercent = null,
}: {
  onStartReceiptSync: () => void;
  syncAvailable?: boolean;
  syncing?: boolean;
  statusMessage?: string | null;
  statusTone?: "neutral" | "success" | "error";
  progressPercent?: number | null;
}) {
  return (
    <section
      aria-labelledby="receipt-sync-hero-title"
      className="@container w-full"
      data-testid="receipt-sync-hero"
    >
      <div className="grid w-full grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] items-center gap-3 overflow-hidden rounded-[24px] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] p-4 shadow-[var(--app-card-shadow-feature)] @md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] @md:gap-8 @md:p-8 @lg:p-10">
        <div className="min-w-0 @md:py-2">
          <h2
            className="text-foreground [--foundation-title2-size:clamp(1.75rem,8.2vw,2.125rem)] [--foundation-title3-size:var(--foundation-title2-size)] [--foundation-title2-line:1.08] [--foundation-title3-line:1.08] [--foundation-title2-weight:800] [--foundation-title3-weight:800] sm:[--foundation-title2-size:44px]"
            id="receipt-sync-hero-title"
          >
            Your receipts
          </h2>
          <p
            className="mt-3 max-w-[22rem] text-[12px] leading-[17px] text-muted-foreground @md:mt-4 @md:text-[17px] @md:leading-7"
            data-testid="receipt-sync-description"
          >
            Find receipts in your mail.
            <span className="hidden @md:inline">
              {" "}
              Automatically organized into smart categories.
            </span>
          </p>
          <div className="mx-auto mt-5 w-full max-w-[244px] @md:mx-0 @md:mt-7">
            <Button
              className="w-full justify-center"
              data-voice-action-id="profile.gmail.sync_now"
              data-voice-control-id="sync_gmail_receipts"
              data-voice-label="Start sync"
              data-voice-purpose="starts or refreshes Mail receipt sync."
              disabled={!syncAvailable || syncing}
              onClick={onStartReceiptSync}
              size="prominent"
              type="button"
            >
              {syncing ? (
                <Loader2
                  aria-hidden="true"
                  className="mr-0.5 size-2.5 shrink-0 animate-spin motion-reduce:animate-none @xs:mr-1 @xs:size-3 @md:mr-2 @md:size-4"
                />
              ) : null}
              {syncing ? "Scanning" : "Start sync"}
            </Button>
          </div>
          {statusMessage ? (
            <div
              aria-live="polite"
              className={`mt-2.5 max-w-[25rem] text-[11px] leading-4 @md:text-sm @md:leading-5 ${
                statusTone === "error"
                  ? "text-destructive"
                  : statusTone === "success"
                    ? "text-emerald-700"
                    : "text-muted-foreground"
              }`}
              data-testid="receipt-sync-inline-status"
            >
              <p>{statusMessage}</p>
              {syncing && progressPercent !== null ? (
                <Progress
                  aria-label="Receipt sync progress"
                  aria-valuetext="Scanning"
                  className="mt-2 h-1.5 bg-[color:var(--app-accent-tint)]"
                  indicatorClassName="bg-[color:var(--app-accent)] opacity-60 duration-500 ease-out motion-reduce:transition-none"
                  value={progressPercent}
                />
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="min-w-0 @md:justify-self-end">
          <div className="mx-auto w-full max-w-none rounded-[20px] border border-border/50 bg-card p-2.5 shadow-[0_20px_40px_-15px_rgba(28,55,90,0.12),0_0_1px_1px_rgba(0,0,0,0.03)] @md:mx-0 @md:max-w-xs @md:rounded-[24px] @md:p-5">
            <ul
              aria-label="Receipt categories"
              className="divide-y divide-slate-100/80"
            >
              {RECEIPT_CATEGORIES.map(
                ({
                  label,
                  icon: Icon,
                  iconClassName,
                  iconWeight,
                  progressClassName,
                  progressWidthClassName,
                }) => (
                  <li
                    className="flex items-center gap-1.5 py-2.5 first:pt-1 last:pb-1 @md:gap-3.5 @md:py-3 @md:first:pt-1.5 @md:last:pb-1.5"
                    data-testid={`receipt-sync-category-${label.toLowerCase()}`}
                    key={label}
                  >
                    <span
                      aria-hidden="true"
                      className={`flex size-8 shrink-0 items-center justify-center rounded-xl ${iconClassName} @md:size-11 @md:rounded-2xl`}
                    >
                      <Icon
                        aria-hidden="true"
                        className="size-4 @md:size-5"
                        weight={iconWeight}
                      />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="whitespace-nowrap text-[11px] font-semibold text-foreground @md:text-sm">
                        {label}
                      </p>
                      <div
                        aria-hidden="true"
                        className="mt-1 h-1 w-full overflow-hidden rounded-full bg-slate-100 @md:mt-1.5 @md:h-1.5 @md:w-24"
                      >
                        <div
                          className={`h-full rounded-full ${progressClassName} ${progressWidthClassName}`}
                        />
                      </div>
                    </div>
                    <ChevronRight
                      aria-hidden="true"
                      className="size-3 shrink-0 text-muted-foreground/60 @md:size-4"
                      weight="regular"
                    />
                  </li>
                ),
              )}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}
