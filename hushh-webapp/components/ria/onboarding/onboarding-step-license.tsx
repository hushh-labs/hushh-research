"use client";

import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const SUPPORTED_REGULATORS = ["SEBI", "SEC", "DFSA", "FCA", "MAS"];

export function OnboardingStepLicense({
  licenseNumber,
  onLicenseNumberChange,
  verificationStatus,
  onVerify,
  onBypassVerification,
  verificationBypassEnabled = false,
}: {
  licenseNumber: string;
  onLicenseNumberChange: (value: string) => void;
  verificationStatus: "idle" | "verifying" | "found" | "not_found" | "error";
  onVerify: () => void;
  onBypassVerification?: () => void;
  verificationBypassEnabled?: boolean;
}) {
  const canVerify =
    licenseNumber.trim().length > 0 && verificationStatus !== "verifying";

  return (
    <div className="space-y-5">
      <div className="overflow-hidden rounded-[24px] border border-border/60 bg-card/80 shadow-[0_12px_34px_rgba(15,23,42,0.06)] backdrop-blur dark:bg-card/55 dark:shadow-none">
        <label
          htmlFor="ria-license-number"
          className="flex min-h-[58px] items-center gap-4 px-4 sm:px-5"
        >
          <span className="w-28 shrink-0 text-[15px] text-muted-foreground">
            Licence
          </span>
          <input
            id="ria-license-number"
            type="text"
            value={licenseNumber}
            onChange={(event) => onLicenseNumberChange(event.target.value)}
            placeholder="INA00123456 or 7413463"
            className={cn(
              "min-w-0 flex-1 bg-transparent py-3 text-right text-[17px] text-foreground placeholder:text-muted-foreground/55 outline-none",
              verificationStatus === "not_found" &&
                "text-amber-600 dark:text-amber-300",
              verificationStatus === "error" && "text-red-600 dark:text-red-300"
            )}
          />
        </label>
      </div>

      <button
        type="button"
        disabled={!canVerify}
        onClick={onVerify}
        className={cn(
          "inline-flex min-h-[52px] w-full items-center justify-center gap-2 rounded-full bg-primary px-6 text-[17px] font-semibold text-primary-foreground shadow-[0_12px_32px_rgba(0,113,227,0.22)] transition-opacity dark:shadow-none",
          !canVerify && "cursor-not-allowed opacity-40"
        )}
      >
        {verificationStatus === "verifying" ? (
          <>
            <Loader2 className="h-5 w-5 animate-spin" />
            Verifying...
          </>
        ) : (
          "Verify licence"
        )}
      </button>

      {verificationBypassEnabled && onBypassVerification ? (
        <button
          type="button"
          disabled={!licenseNumber.trim() || verificationStatus === "verifying"}
          onClick={onBypassVerification}
          className={cn(
            "inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full border border-[#0071E3]/35 bg-[#0071E3]/10 px-6 text-[15px] font-semibold text-[#0071E3] transition-opacity",
            (!licenseNumber.trim() || verificationStatus === "verifying") &&
              "opacity-40 cursor-not-allowed"
          )}
        >
          Bypass for dev/UAT
        </button>
      ) : null}

      {verificationStatus !== "idle" ? (
        <div className="space-y-3">
          {verificationStatus === "verifying" ? (
            <div className="flex items-center gap-3 rounded-[18px] border border-border/60 bg-card/70 px-4 py-3 backdrop-blur dark:bg-card/45">
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
              <p className="text-[15px] text-muted-foreground">
                Checking regulatory databases...
              </p>
            </div>
          ) : null}

          {verificationStatus === "found" ? (
            <div className="flex items-center gap-3 rounded-[18px] border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              <p className="text-[15px] font-medium text-emerald-700 dark:text-emerald-300">
                Registration verified
              </p>
            </div>
          ) : null}

          {verificationStatus === "not_found" ? (
            <div className="rounded-[18px] border border-amber-500/30 bg-amber-500/10 px-4 py-3">
              <div className="flex items-center gap-3">
                <AlertCircle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <p className="text-[15px] font-medium text-amber-700 dark:text-amber-300">
                  No matching registration found.
                </p>
              </div>
              <p className="mt-1 pl-7 text-sm text-muted-foreground">
                Try a different licence number.
              </p>
            </div>
          ) : null}

          {verificationStatus === "error" ? (
            <div className="flex items-center gap-3 rounded-[18px] border border-red-500/30 bg-red-500/10 px-4 py-3">
              <AlertCircle className="h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
              <p className="text-[15px] font-medium text-red-700 dark:text-red-300">
                Something went wrong. Please try again.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-3">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Supported Regulators
        </p>
        <div className="flex flex-wrap gap-2">
          {SUPPORTED_REGULATORS.map((regulator) => (
            <span
              key={regulator}
              className="rounded-full border border-border/60 bg-card/60 px-3 py-1 text-xs font-medium text-muted-foreground dark:bg-card/40"
            >
              {regulator}
            </span>
          ))}
        </div>
        <p className="text-sm leading-6 text-muted-foreground">
          {verificationBypassEnabled
            ? "Development and UAT can bypass live verification for testing only."
            : "Kai verifies your identity against FINRA and SEC records before unlocking the advisory workflow."}
        </p>
      </div>
    </div>
  );
}
