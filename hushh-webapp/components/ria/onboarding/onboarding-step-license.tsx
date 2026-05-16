"use client";

import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const SUPPORTED_REGULATORS = ["SEBI", "SEC", "DFSA", "FCA", "MAS"];

export function OnboardingStepLicense({
  licenseNumber,
  onLicenseNumberChange,
  verificationStatus,
  onVerify,
}: {
  licenseNumber: string;
  onLicenseNumberChange: (value: string) => void;
  verificationStatus: "idle" | "verifying" | "found" | "not_found" | "error";
  onVerify: () => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="space-y-3">
        <label className="block text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          Licence Number
        </label>
        <input
          type="text"
          value={licenseNumber}
          onChange={(e) => onLicenseNumberChange(e.target.value)}
          placeholder="e.g. INA00123456 or 7413463"
          className={cn(
            "w-full rounded-[22px] border bg-background/75 px-5 py-3.5 text-[15px] text-foreground placeholder:text-muted-foreground/60 outline-none transition-colors backdrop-blur-xl",
            verificationStatus === "not_found"
              ? "border-amber-500/60 focus:border-amber-500"
              : verificationStatus === "error"
                ? "border-red-500/60 focus:border-red-500"
                : "border-border/70 focus:border-[#0071E3]"
          )}
        />
      </div>

      <button
        type="button"
        disabled={!licenseNumber.trim() || verificationStatus === "verifying"}
        onClick={onVerify}
        className={cn(
          "inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-[#0071E3] px-6 text-[15px] font-semibold text-white transition-opacity",
          (!licenseNumber.trim() || verificationStatus === "verifying") &&
            "opacity-40 cursor-not-allowed"
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

      {verificationStatus === "verifying" && (
        <div className="flex items-center gap-2.5 rounded-[18px] border border-border/50 bg-muted/20 px-4 py-3 backdrop-blur-xl">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[#0071E3]" />
          <p className="text-sm text-muted-foreground">
            Checking regulatory databases...
          </p>
        </div>
      )}

      {verificationStatus === "found" && (
        <div className="flex items-center gap-2.5 rounded-[18px] border border-emerald-500/40 bg-emerald-500/5 px-4 py-3 backdrop-blur-xl">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
          <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
            Registration verified
          </p>
        </div>
      )}

      {verificationStatus === "not_found" && (
        <div className="flex flex-col gap-1.5 rounded-[18px] border border-amber-500/40 bg-amber-500/5 px-4 py-3 backdrop-blur-xl">
          <div className="flex items-center gap-2.5">
            <AlertCircle className="h-4 w-4 shrink-0 text-amber-500" />
            <p className="text-sm font-medium text-amber-600 dark:text-amber-400">
              No matching registration found for this licence number.
            </p>
          </div>
          <p className="pl-[26px] text-xs text-muted-foreground">
            Try a different number
          </p>
        </div>
      )}

      {verificationStatus === "error" && (
        <div className="flex items-center gap-2.5 rounded-[18px] border border-red-500/40 bg-red-500/5 px-4 py-3 backdrop-blur-xl">
          <AlertCircle className="h-4 w-4 shrink-0 text-red-500" />
          <p className="text-sm font-medium text-red-600 dark:text-red-400">
            Something went wrong. Please try again.
          </p>
        </div>
      )}

      <div className="mt-2 space-y-3">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          Supported Regulators
        </p>
        <div className="flex flex-wrap gap-2">
          {SUPPORTED_REGULATORS.map((reg) => (
            <span
              key={reg}
              className="rounded-full border border-border/50 px-2.5 py-1 text-xs text-muted-foreground"
            >
              {reg}
            </span>
          ))}
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground/80">
          Kai verifies your identity against FINRA and SEC records before
          unlocking the advisory workflow.
        </p>
      </div>
    </div>
  );
}
