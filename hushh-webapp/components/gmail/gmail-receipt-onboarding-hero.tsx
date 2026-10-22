import {
  AirplaneTilt,
  ChevronRight,
  ForkKnife,
  ShoppingBag,
  type LucideIcon,
} from "@/components/icons";
import { Progress } from "@/components/ui/progress";
import mailStyles from "./mail-workspace.module.css";
import { MailActionButton as Button } from "./mail-action-button";

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
      <div className="grid w-full grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] items-center gap-3 overflow-hidden rounded-[24px] bg-[color:var(--app-card-surface-default-solid)] p-4 @md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] @md:gap-8 @md:p-8 @lg:p-10">
        <div className="min-w-0 @md:py-2">
          <h2
            // Derived from the page title's own token (not an independent
            // breakpoint) so this stays smaller than "Mail" at every viewport
            // by construction, including the transition width between them,
            // instead of two clamps that happen to agree at today's sampled
            // widths. Inside .app-page-shell, `h2` itself reads the title3
            // variables (not title2) for font-size/line/weight, so both
            // families are set here -- dropping either one lets that more
            // specific shell rule silently override the other back to the
            // small default title3 scale.
            className={mailStyles.sectionTitle}
            id="receipt-sync-hero-title"
          >
            Your receipts
          </h2>
          <p
            className={`${mailStyles.support} mt-3 max-w-[22rem] text-muted-foreground`}
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
              aria-busy={syncing}
              onClick={onStartReceiptSync}
              size="prominent"
              type="button"
            >
              Start sync
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
          {/* No @md max-width: the preview fills its grid column instead of
              floating at a fixed small width inside the space the equal-width
              desktop grid already gives it. */}
          <div className="mx-auto w-full max-w-none rounded-[20px] bg-[color:var(--app-neutral-fill)] p-2.5 @md:mx-0 @md:rounded-[24px] @md:p-6 @lg:rounded-[28px] @lg:p-7">
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
                    className="flex items-center gap-1.5 py-2.5 first:pt-1 last:pb-1 @md:gap-4 @md:py-3.5 @md:first:pt-2 @md:last:pb-2"
                    data-testid={`receipt-sync-category-${label.toLowerCase()}`}
                    key={label}
                  >
                    <span
                      aria-hidden="true"
                      className={`flex size-8 shrink-0 items-center justify-center rounded-xl ${iconClassName} @md:size-12 @md:rounded-2xl @lg:size-14`}
                    >
                      <Icon
                        aria-hidden="true"
                        className="size-4 @md:size-6"
                        weight={iconWeight}
                      />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="whitespace-nowrap text-[11px] font-semibold text-foreground @md:text-base">
                        {label}
                      </p>
                      <div
                        aria-hidden="true"
                        className="mt-1 h-1 w-full overflow-hidden rounded-full bg-slate-100 @md:mt-2 @md:h-2 @md:w-28"
                      >
                        <div
                          className={`h-full rounded-full ${progressClassName} ${progressWidthClassName}`}
                        />
                      </div>
                    </div>
                    <ChevronRight
                      aria-hidden="true"
                      className="size-3 shrink-0 text-muted-foreground/60 @md:size-5"
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
