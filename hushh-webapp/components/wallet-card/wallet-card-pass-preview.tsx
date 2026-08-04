"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { WalletCardQr } from "@/components/wallet-card/wallet-card-qr";

/** First letters of the name, used when there is no photo. */
function initialsFrom(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "1";
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase() || "1";
}

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
  avatarUrl,
  shareUrl,
  className,
}: {
  fullName: string;
  headline: string;
  organisation: string;
  locationLabel: string;
  avatarUrl: string | null;
  shareUrl: string | null;
  className?: string;
}) {
  const auxiliary = [organisation, locationLabel].map((value) => value.trim()).filter(Boolean);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-[var(--app-card-radius-compact)] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] shadow-[var(--app-card-shadow-standard)]",
        className,
      )}
      data-testid="wallet-card-pass-preview"
    >
      <div className="flex items-start justify-between gap-4 border-b border-border/60 px-5 py-4">
        <div className="min-w-0">
          <div className="text-[10px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
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
        <Avatar size="lg" className="size-14 rounded-[12px]">
          {avatarUrl ? <AvatarImage src={avatarUrl} alt="" /> : null}
          <AvatarFallback className="rounded-[12px] text-sm font-medium">
            {initialsFrom(fullName)}
          </AvatarFallback>
        </Avatar>
      </div>

      {auxiliary.length > 0 ? (
        <dl className="flex flex-wrap gap-x-8 gap-y-3 px-5 pt-4">
          {organisation.trim() ? (
            <div className="min-w-0">
              <dt className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                Organisation
              </dt>
              <dd className="mt-0.5 truncate text-[13px] text-foreground">
                {organisation.trim()}
              </dd>
            </div>
          ) : null}
          {locationLabel.trim() ? (
            <div className="min-w-0">
              <dt className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                Location
              </dt>
              <dd className="mt-0.5 truncate text-[13px] text-foreground">
                {locationLabel.trim()}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      <div className="px-5 py-4">
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
