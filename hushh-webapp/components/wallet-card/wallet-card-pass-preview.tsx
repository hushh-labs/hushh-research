"use client";

import { cn } from "@/lib/utils";
import { WalletCardQr } from "@/components/wallet-card/wallet-card-qr";

/**
 * A faithful-but-static rendering of the pass face.
 *
 * The real pass is built and signed server-side; this is the owner's preview of
 * the same field budget (one primary, one secondary, up to two auxiliary), so
 * what they approve here is what Apple Wallet shows.
 */
export function WalletCardPassPreview({
  fullName,
  headline,
  organisation,
  locationLabel,
  shareUrl,
  className,
}: {
  fullName: string;
  headline: string;
  organisation: string;
  locationLabel: string;
  shareUrl: string | null;
  className?: string;
}) {
  const auxiliary = [organisation, locationLabel].map((value) => value.trim()).filter(Boolean);

  return (
    <div
      className={cn(
        "mx-auto grid w-full max-w-md grid-cols-[minmax(0,1fr)_128px] overflow-hidden rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] shadow-[var(--app-card-shadow-standard)]",
        className,
      )}
      data-testid="wallet-card-pass-preview"
    >
      <div className="col-start-1 min-w-0 px-4 pt-4 pb-2">
        <div className="min-w-0">
          <div className="app-metadata-label text-[10px] font-normal uppercase tracking-[0.22em] text-muted-foreground">
            Hussh One
          </div>
          <div className="mt-2 truncate text-[19px] font-semibold leading-tight text-foreground">
            {fullName.trim() || "Your name"}
          </div>
          {headline.trim() ? (
            <div className="mt-1 truncate text-[13px] text-muted-foreground">
              {headline.trim()}
            </div>
          ) : null}
        </div>
      </div>

      {auxiliary.length > 0 ? (
        <dl className="col-start-1 flex min-w-0 flex-wrap gap-x-4 gap-y-2 px-4 pb-4">
          {organisation.trim() ? (
            <div className="min-w-0">
              <dt className="text-[10px] font-normal uppercase tracking-[0.18em] text-muted-foreground">
                Organisation
              </dt>
              <dd className="mt-0.5 truncate text-[13px] text-foreground">
                {organisation.trim()}
              </dd>
            </div>
          ) : null}
          {locationLabel.trim() ? (
            <div className="min-w-0">
              <dt className="text-[10px] font-normal uppercase tracking-[0.18em] text-muted-foreground">
                Location
              </dt>
              <dd className="mt-0.5 truncate text-[13px] text-foreground">
                {locationLabel.trim()}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      <div className="col-start-2 row-start-1 row-span-2 self-center py-4 pr-4">
        {shareUrl ? (
          <div className="mx-auto w-full max-w-[184px]">
            <WalletCardQr value={shareUrl} label="Your Wallet Profile QR code" />
          </div>
        ) : (
          <div className="mx-auto flex aspect-square w-full max-w-[184px] items-center justify-center rounded-2xl border border-dashed p-4 text-center text-[12px] text-muted-foreground">
            Your QR appears here once the profile is saved.
          </div>
        )}
      </div>
    </div>
  );
}
