import { AlertTriangle, ShieldCheck } from "lucide-react";

type ConsentExpiryWarningProps = {
  expiresAt?: string | null;
  label?: string;
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function ConsentExpiryWarning({
  expiresAt,
  label = "Consent access",
}: ConsentExpiryWarningProps) {
  if (!expiresAt) return null;

  const expiryTime = new Date(expiresAt).getTime();

  if (Number.isNaN(expiryTime)) return null;

  const now = Date.now();
  const timeLeft = expiryTime - now;

  if (timeLeft > ONE_DAY_MS) return null;

  const isExpired = timeLeft <= 0;

  return (
    <div
      className={
        isExpired
          ? "rounded-2xl border border-red-500/20 bg-red-500/10 p-4"
          : "rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4"
      }
    >
      <div className="flex items-start gap-3">
        {isExpired ? (
          <AlertTriangle className="mt-0.5 h-5 w-5 text-red-600" />
        ) : (
          <ShieldCheck className="mt-0.5 h-5 w-5 text-amber-600" />
        )}

        <div className="space-y-1">
          <p
            className={
              isExpired
                ? "text-sm font-semibold text-red-700"
                : "text-sm font-semibold text-amber-700"
            }
          >
            {isExpired ? `${label} expired` : `${label} expires soon`}
          </p>

          <p className="text-sm text-muted-foreground">
            {isExpired
              ? "This access has expired. Review consent settings to restore access."
              : "This access expires in less than 24 hours. Review consent settings to avoid interruption."}
          </p>
        </div>
      </div>
    </div>
  );
}