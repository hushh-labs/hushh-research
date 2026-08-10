"use client";

import { AlertCircle, CheckCircle2, Loader2, Plus } from "lucide-react";
import { Button } from "@/lib/morphy-ux/button";
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
      <div className="overflow-hidden rounded-[18px] border-[1.5px] border-border bg-background/80 shadow-md backdrop-blur-md">
        <label
          htmlFor="ria-license-number"
          className="flex min-h-[60px] items-center gap-4 px-5"
        >
          <span className="shrink-0 text-[16px] text-muted-foreground">
            Licence
          </span>
          <input
            id="ria-license-number"
            type="text"
            value={licenseNumber}
            onChange={(event) => onLicenseNumberChange(event.target.value)}
            placeholder="INA00123456 or 7413463"
            className={cn(
              "min-w-0 flex-1 bg-transparent py-3 text-right text-[17px] font-medium tabular-nums text-foreground placeholder:text-muted-foreground/50 outline-none",
              verificationStatus === "not_found" &&
                "text-amber-600 dark:text-amber-300",
              verificationStatus === "error" && "text-red-600 dark:text-red-300"
            )}
          />
        </label>
      </div>

      <Button
        type="button"
        disabled={!canVerify}
        loading={verificationStatus === "verifying"}
        onClick={onVerify}
        className="w-full text-base font-semibold"
        variant="blue-gradient"
        size="lg"
      >
        Verify licence
      </Button>

      {verificationBypassEnabled && onBypassVerification ? (
        <Button
          type="button"
          disabled={!licenseNumber.trim() || verificationStatus === "verifying"}
          onClick={onBypassVerification}
          className="w-full text-base"
          variant="none"
          effect="fade"
          size="lg"
        >
          Bypass for dev / UAT
        </Button>
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
        <p className="ui-text-section-label px-[6px]">Supported Regulators</p>
        <div className="flex flex-wrap gap-2">
          {SUPPORTED_REGULATORS.map((regulator) => (
            <span
              key={regulator}
              className="inline-flex h-[34px] items-center rounded-xl border border-border bg-muted/20 px-3.5 text-[13px] font-medium text-foreground"
            >
              {regulator}
            </span>
          ))}
        </div>
        <p className="text-[13px] leading-[1.45] text-muted-foreground">
          {verificationBypassEnabled
            ? "Development and UAT can bypass live verification for testing only."
            : "Kai verifies your identity against FINRA and SEC records before unlocking the advisory workflow."}
        </p>
      </div>
    </div>
  );
}
