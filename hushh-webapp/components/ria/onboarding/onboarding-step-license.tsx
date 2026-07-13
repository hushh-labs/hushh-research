"use client";

import { AlertCircle, CheckCircle2, Loader2, Plus } from "lucide-react";
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
      <div className="overflow-hidden rounded-[18px] border-[1.5px] border-[color:rgba(201,139,46,0.4)] bg-[color:var(--card)] shadow-[0_0_0_4px_rgba(201,139,46,0.06)]">
        <label
          htmlFor="ria-license-number"
          className="flex min-h-[60px] items-center gap-4 px-5"
        >
          <span className="shrink-0 text-[17px] text-[color:var(--ria-muted)]">
            Licence
          </span>
          <input
            id="ria-license-number"
            type="text"
            value={licenseNumber}
            onChange={(event) => onLicenseNumberChange(event.target.value)}
            placeholder="INA00123456 or 7413463"
            className={cn(
              "min-w-0 flex-1 bg-transparent py-3 text-right text-[17px] font-medium tabular-nums text-[color:var(--ria-ink)] placeholder:text-[color:var(--ria-faint)] outline-none",
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
          "ria-cta w-full text-[17px]",
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
            "ria-secondary w-full text-[15px]",
            (!licenseNumber.trim() || verificationStatus === "verifying") &&
              "opacity-40 cursor-not-allowed"
          )}
        >
          Bypass for dev / UAT
        </button>
      ) : null}

      {verificationStatus !== "idle" ? (
        <div className="space-y-3">
          {verificationStatus === "verifying" ? (
            <div className="flex items-center gap-3 rounded-[18px] border border-[color:var(--ria-divider-outer)] bg-white px-4 py-3">
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[color:var(--ria-gold)]" />
              <p className="text-[15px] text-[color:var(--ria-muted)]">
                Checking regulatory databases...
              </p>
            </div>
          ) : null}

          {verificationStatus === "found" ? (
            <div
              className="flex min-h-[58px] items-center justify-between gap-3 rounded-[18px] border px-4 py-3.5"
              style={{
                borderColor: "var(--ria-success-border)",
                backgroundColor: "var(--ria-success-bg)",
              }}
            >
              <span className="flex items-center gap-3">
                <CheckCircle2
                  className="h-5 w-5 shrink-0"
                  style={{ color: "var(--ria-success)" }}
                />
                <span
                  className="text-[16px] font-semibold"
                  style={{ color: "var(--ria-success-text)" }}
                >
                  Registration verified
                </span>
              </span>
              <Plus
                className="h-4 w-4 shrink-0"
                style={{ color: "var(--ria-gold)" }}
              />
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
        <p className="ria-sublabel">Supported Regulators</p>
        <div className="flex flex-wrap gap-2">
          {SUPPORTED_REGULATORS.map((regulator) => (
            <span
              key={regulator}
              className="inline-flex h-9 items-center rounded-[14px] border border-[color:var(--ria-divider-outer)] bg-[color:var(--card)] px-4 text-[14px] font-medium text-[color:var(--ria-ink)]"
            >
              {regulator}
            </span>
          ))}
        </div>
        <p className="text-[13px] leading-[1.45] text-[color:var(--ria-sublabel)]">
          {verificationBypassEnabled
            ? "Development and UAT can bypass live verification for testing only."
            : "Kai verifies your identity against FINRA and SEC records before unlocking the advisory workflow."}
        </p>
      </div>
    </div>
  );
}
