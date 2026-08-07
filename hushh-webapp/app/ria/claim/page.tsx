"use client";

/**
 * Claim your RIA profile by office phone number.
 *
 * phone → found (SEC firm + advisers at that number) → code (possession OTP)
 * → pick (roster identity, when needed) → done (auto-built profile).
 *
 * The OTP proves the claimant can answer the firm's Form ADV number. Sole
 * advisers reach `verified` on the passcode alone; everyone else lands a
 * provisional (unverified) profile and upgrades later from the profile tab.
 */

import {
  Building2,
  CheckCircle2,
  ChevronLeft,
  Loader2,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { FullscreenFlowShell } from "@/components/app-ui/fullscreen-flow-shell";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { useAuth } from "@/hooks/use-auth";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { toNanpDigits } from "@/lib/ria/ria-claim-entry";
import { Button } from "@/lib/morphy-ux/button";
import { ROUTES } from "@/lib/navigation/routes";
import { usePersonaState } from "@/lib/persona/persona-context";
import { PreVaultUserStateService } from "@/lib/services/pre-vault-user-state-service";
import {
  RiaApiError,
  RiaService,
  type RiaClaimCandidate,
  type RiaClaimCompleteResult,
  type RiaClaimFirm,
  type RiaClaimLookupResult,
  type RiaClaimVerifyResult,
} from "@/lib/services/ria-service";

type ClaimStep = "phone" | "found" | "code" | "pick" | "done";
type ClaimType = "individual" | "firm";

const CONTROL_SHELL_CLASS =
  "h-[54px] overflow-hidden rounded-[15px] border border-black/10 bg-[#f5f5f7]/92 shadow-xs transition-[border-color,box-shadow] focus-within:border-[color:var(--app-accent)] focus-within:ring-4 focus-within:ring-[color:var(--app-accent-ring)] dark:border-white/10 dark:bg-white/[0.08]";

function formatUsPhone(digits: string): string {
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
}

function formatAum(aum: number | null | undefined): string | null {
  if (!aum || aum <= 0) return null;
  if (aum >= 1_000_000_000) return `$${(aum / 1_000_000_000).toFixed(1)}B AUM`;
  if (aum >= 1_000_000) return `$${Math.round(aum / 1_000_000)}M AUM`;
  return `$${Math.round(aum / 1_000)}K AUM`;
}

function titleCase(value: string | null | undefined): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const keepUpper = new Set(["llc", "lp", "llp", "pc", "pa", "ltd", "inc"]);
  return text
    .split(/\s+/)
    .map((word) => {
      const cleaned = word.replace(/[.,]+$/, "").toLowerCase();
      if (keepUpper.has(cleaned)) return word.toLowerCase().replace(cleaned, cleaned.toUpperCase());
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

function FirmCard({ firm, adviserCount }: { firm: RiaClaimFirm; adviserCount?: number | null }) {
  const location = [titleCase(firm.city), firm.state].filter(Boolean).join(", ");
  const aum = formatAum(firm.aum);
  const meta = [
    location || null,
    typeof adviserCount === "number" && adviserCount > 0
      ? `${adviserCount} adviser${adviserCount === 1 ? "" : "s"}`
      : null,
    aum,
  ].filter(Boolean);
  return (
    <div className="rounded-[22px] border border-[color:var(--border)] bg-[color:var(--card)] p-5 shadow-[0_8px_24px_rgba(62,48,30,0.05)]">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] border border-[color:var(--app-card-border-strong)] bg-[color:var(--app-card-surface-compact)] text-[color:var(--app-accent)] shadow-[var(--shadow-xs)]">
          <Building2 className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <p className="text-[17px] font-semibold leading-snug">{titleCase(firm.name)}</p>
          {meta.length > 0 ? (
            <p className="mt-0.5 text-[13px] text-muted-foreground">{meta.join(" · ")}</p>
          ) : null}
          {firm.phone ? (
            <p className="mt-0.5 text-[13px] tabular-nums text-muted-foreground">{firm.phone}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function TargetRadio({ selected }: { selected?: boolean }) {
  return (
    <div
      className="flex h-5 w-5 items-center justify-center rounded-full border-2 transition-colors"
      style={{
        borderColor: selected ? "var(--app-accent)" : "var(--muted-foreground)",
        opacity: selected ? 1 : 0.4,
      }}
    >
      {selected ? (
        <div className="h-2.5 w-2.5 rounded-full bg-[color:var(--app-accent)]" />
      ) : null}
    </div>
  );
}

function CodeCells({
  length,
  value,
  onChange,
  disabled,
}: {
  length: number;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  return (
    <div className="relative">
      <div className="flex gap-2" aria-hidden="true">
        {Array.from({ length }).map((_, index) => {
          const active = index === value.length;
          return (
            <div
              key={index}
              className={`flex h-[58px] flex-1 items-center justify-center rounded-2xl border-[1.5px] text-[24px] font-bold tabular-nums ${
                active
                  ? "border-[color:var(--app-accent)] bg-white shadow-[0_0_0_4px_var(--app-accent-ring)] dark:bg-white/[0.08]"
                  : "border-black/10 bg-black/[0.02] dark:border-white/10 dark:bg-white/[0.04]"
              }`}
            >
              {value[index] ?? (active ? <span className="h-6 w-px animate-pulse bg-[color:var(--app-accent)]" /> : "")}
            </div>
          );
        })}
      </div>
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => {
          const digits = event.target.value.replace(/\D/g, "").slice(0, length);
          onChange(digits);
        }}
        inputMode="numeric"
        autoComplete="one-time-code"
        disabled={disabled}
        aria-label="Verification code"
        className="absolute inset-0 h-full w-full cursor-default opacity-0"
        data-voice-control-id="ria-claim-code-input"
      />
    </div>
  );
}

export default function RiaClaimPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading: authLoading } = useAuth();
  const { refresh: refreshPersonaState } = usePersonaState();
  // Arrives pre-filled when the sign-up phone screen recognised this number.
  // Someone who verified their phone on an earlier visit never sees that
  // screen again, so fall back to the number already on their account — they
  // should be recognised whenever they reach here, not only on first sign-up.
  const seededPhone =
    toNanpDigits(searchParams.get("phone")) || toNanpDigits(user?.phoneNumber);

  const [step, setStep] = useState<ClaimStep>("phone");
  const [phoneDigits, setPhoneDigits] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [lookup, setLookup] = useState<RiaClaimLookupResult | null>(null);
  const [selectedFirm, setSelectedFirm] = useState<RiaClaimFirm | null>(null);
  const [claimType, setClaimType] = useState<ClaimType>("individual");
  const [selectedCandidateCrd, setSelectedCandidateCrd] = useState<number | null>(null);
  // The one thing the user picks on the found screen: which listed entry is
  // theirs — an adviser row, the "I'm an adviser here" row (names withheld
  // until verified), or the firm itself.
  const [selectedTarget, setSelectedTarget] = useState<{
    type: ClaimType;
    individualCrd: number | null;
  } | null>(null);

  const [verificationId, setVerificationId] = useState<string | null>(null);
  const [codeLength, setCodeLength] = useState(5);
  const [code, setCode] = useState("");
  const [otpUnavailable, setOtpUnavailable] = useState(false);
  const [phoneMasked, setPhoneMasked] = useState("");

  const [verifyResult, setVerifyResult] = useState<RiaClaimVerifyResult | null>(null);
  const [pickCrd, setPickCrd] = useState<number | null>(null);
  const [completeResult, setCompleteResult] = useState<RiaClaimCompleteResult | null>(null);

  const submittingRef = useRef(false);

  useEffect(() => {
    if (!authLoading && !user) {
      router.replace(`/login?redirect=${encodeURIComponent(ROUTES.RIA_CLAIM)}`);
    }
  }, [authLoading, user, router]);

  const firm = selectedFirm ?? lookup?.firm ?? null;
  const firmCrd = firm?.crd ?? null;

  const getIdToken = useCallback(async () => {
    if (!user) throw new Error("Not signed in");
    return user.getIdToken();
  }, [user]);

  const describeError = (err: unknown): string => {
    if (err instanceof RiaApiError) return err.message;
    return "Something went wrong. Try again.";
  };

  const handleLookup = useCallback(async (phoneOverride?: string) => {
    const phone = phoneOverride ?? phoneDigits;
    if (phone.length !== 10 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const idToken = await getIdToken();
      const result = await RiaService.claimLookup(idToken, { phone });
      if (result.outcome === "invalid_phone") {
        setError("Enter a valid US phone number.");
        return;
      }
      setLookup(result);
      setSelectedFirm(null);
      // Pre-select when the SEC lists exactly one adviser, so "Is this you?"
      // answers itself and the primary action is live on arrival.
      const soleCandidate =
        result.candidates.length === 1 ? result.candidates[0] : undefined;
      setSelectedCandidateCrd(soleCandidate?.individual_crd ?? null);
      setSelectedTarget(
        soleCandidate?.individual_crd
          ? { type: "individual", individualCrd: soleCandidate.individual_crd }
          : null,
      );
      setStep("found");
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }, [phoneDigits, busy, getIdToken]);

  // Recognised at sign-up: run the lookup immediately so the person lands on
  // their firm instead of retyping the number they just verified.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || !seededPhone || !user || authLoading) return;
    seededRef.current = true;
    setPhoneDigits(seededPhone);
    void handleLookup(seededPhone);
  }, [seededPhone, user, authLoading, handleLookup]);

  const beginClaim = useCallback(
    async (type: ClaimType, candidateCrd: number | null) => {
      if (!firmCrd || busy) return;
      setBusy(true);
      setError(null);
      setClaimType(type);
      setSelectedCandidateCrd(candidateCrd);
      try {
        const idToken = await getIdToken();
        const start = await RiaService.claimOtpStart(idToken, { phone: phoneDigits });
        setPhoneMasked(start.phone_masked ?? "");
        if (start.eligible && start.verification_id) {
          setVerificationId(start.verification_id);
          setCodeLength(start.code_length ?? 6);
          setOtpUnavailable(false);
        } else {
          setVerificationId(null);
          setOtpUnavailable(true);
        }
        setCode("");
        setStep("code");
      } catch (err) {
        setError(describeError(err));
      } finally {
        setBusy(false);
      }
    },
    [firmCrd, busy, phoneDigits, getIdToken],
  );

  const completeClaim = useCallback(
    async (ticket: string, type: ClaimType, individualCrd: number | null) => {
      if (!firmCrd) return;
      const idToken = await getIdToken();
      const result = await RiaService.claimComplete(idToken, {
        phone: phoneDigits,
        claim_ticket: ticket,
        claim_type: type,
        firm_crd: firmCrd,
        individual_crd: type === "individual" ? individualCrd : undefined,
      });
      setCompleteResult(result);
      setStep("done");
      // Clear the stale pre-claim persona/onboarding-status caches, then force a
      // fresh read — otherwise "Open your profile" can bounce the just-claimed
      // adviser back into the onboarding wizard off a 30-min-TTL cache hit.
      if (user) {
        CacheSyncService.onPersonaStateChanged(user.uid);
        // Claiming completes RIA setup just as the wizard does, so the Setup
        // hub must stop listing it as remaining. syncSetupCapabilities REPLACES
        // the stored set, so pass the union.
        try {
          const current = await PreVaultUserStateService.bootstrapState(user.uid);
          if (!current.setupCapabilityIds.includes("ria")) {
            await PreVaultUserStateService.syncSetupCapabilities(
              user.uid,
              Array.from(new Set([...current.setupCapabilityIds, "ria"])).sort(),
            );
          }
        } catch {
          // best-effort; the dashboard reconciles the count on next load.
        }
      }
      await refreshPersonaState({ force: true });
    },
    [firmCrd, phoneDigits, getIdToken, refreshPersonaState, user],
  );

  const handleCodeFilled = useCallback(
    async (filledCode: string) => {
      if (!firmCrd || !verificationId || submittingRef.current) return;
      submittingRef.current = true;
      setBusy(true);
      setError(null);
      try {
        const idToken = await getIdToken();
        const result = await RiaService.claimVerify(idToken, {
          phone: phoneDigits,
          claim_type: claimType,
          firm_crd: firmCrd,
          individual_crd: claimType === "individual" ? selectedCandidateCrd : undefined,
          verification_id: verificationId,
          verification_code: filledCode,
        });
        setVerifyResult(result);
        if (claimType === "firm") {
          await completeClaim(result.claim_ticket, "firm", null);
          return;
        }
        if (selectedCandidateCrd) {
          await completeClaim(result.claim_ticket, "individual", selectedCandidateCrd);
          return;
        }
        const roster = result.roster ?? [];
        const soleEntry = roster.length === 1 ? roster[0] : undefined;
        if (soleEntry?.individual_crd) {
          await completeClaim(result.claim_ticket, "individual", soleEntry.individual_crd);
          return;
        }
        setPickCrd(null);
        setStep("pick");
      } catch (err) {
        setCode("");
        setError(
          err instanceof RiaApiError && err.status === 401
            ? "That code didn't work. Try again."
            : describeError(err),
        );
      } finally {
        submittingRef.current = false;
        setBusy(false);
      }
    },
    [firmCrd, verificationId, phoneDigits, claimType, selectedCandidateCrd, getIdToken, completeClaim],
  );

  useEffect(() => {
    if (step === "code" && code.length === codeLength && !busy) {
      void handleCodeFilled(code);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, codeLength, step]);

  const handlePickClaim = useCallback(async () => {
    if (!verifyResult || !pickCrd || busy) return;
    setBusy(true);
    setError(null);
    try {
      await completeClaim(verifyResult.claim_ticket, "individual", pickCrd);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }, [verifyResult, pickCrd, busy, completeClaim]);

  const resetToPhone = useCallback(() => {
    setStep("phone");
    setLookup(null);
    setSelectedFirm(null);
    setSelectedCandidateCrd(null);
    setSelectedTarget(null);
    setVerifyResult(null);
    setVerificationId(null);
    setOtpUnavailable(false);
    setCode("");
    setError(null);
  }, []);

  const outcome = lookup?.outcome ?? null;
  const candidates: RiaClaimCandidate[] = lookup?.candidates ?? [];
  const adviserCount = lookup?.current_adviser_count ?? null;

  const nativeDataState = useMemo(() => {
    if (authLoading) return "loading";
    return "loaded";
  }, [authLoading]);

  const header = (() => {
    switch (step) {
      case "phone":
        return { title: "Claim your profile", description: "Enter your office number." };
      case "found":
        if (outcome === "no_match") {
          return { title: "No match", description: "No SEC firm files this number." };
        }
        if (outcome === "ambiguous_firm" && !selectedFirm) {
          return { title: "Which firm?", description: "Several firms share this line." };
        }
        if (outcome === "single_person") {
          return { title: "Is this you?", description: null };
        }
        return { title: "Listed at this number", description: "Tap what's yours." };
      case "code":
        return {
          title: "Verify the number",
          description: otpUnavailable ? null : `Enter the code sent to ${phoneMasked || "your line"}.`,
        };
      case "pick":
        return { title: "Which adviser are you?", description: null };
      case "done":
        return { title: "Profile claimed", description: null };
    }
  })();

  if (authLoading || !user) {
    return (
      <FullscreenFlowShell width="reading" className="px-0">
        <div className="flex min-h-[40vh] items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      </FullscreenFlowShell>
    );
  }

  const verified = completeResult?.profile_verified === true;

  return (
    <>
      <NativeTestBeacon
        routeId="/ria/claim"
        marker="native-route-ria-claim"
        authState={user ? "authenticated" : "anonymous"}
        dataState={nativeDataState}
      />
      <FullscreenFlowShell width="reading" className="px-0">
        <div className="mx-auto flex w-full max-w-[34rem] flex-col gap-6 px-6 pb-[var(--app-scroll-bottom-pad)] pt-4">
          {step !== "phone" && step !== "done" ? (
            <button
              type="button"
              onClick={() => (step === "found" ? resetToPhone() : setStep("found"))}
              className="flex h-10 w-10 items-center justify-center rounded-full bg-muted/20 transition-transform active:scale-95"
              aria-label="Back"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
          ) : null}

          <header className="space-y-1.5">
            <p className="text-[12px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              RIA
            </p>
            <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{header.title}</h1>
            {header.description ? (
              <p className="text-[16px] leading-[1.5] text-muted-foreground">
                {header.description}
              </p>
            ) : null}
          </header>

          {error ? (
            <p className="text-[14px] text-red-600 dark:text-red-400" role="alert">
              {error}
            </p>
          ) : null}

          {step === "phone" ? (
            <div className="space-y-5">
              <div className={`${CONTROL_SHELL_CLASS} flex items-center px-4`}>
                <span className="mr-2 text-[17px] text-muted-foreground">+1</span>
                <input
                  value={formatUsPhone(phoneDigits)}
                  onChange={(event) =>
                    setPhoneDigits(event.target.value.replace(/\D/g, "").slice(0, 10))
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void handleLookup();
                  }}
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel-national"
                  placeholder="(555) 000-0000"
                  aria-label="Office phone number"
                  className="h-full w-full bg-transparent text-[17px] tabular-nums outline-none placeholder:text-muted-foreground/60"
                  data-voice-control-id="ria-claim-phone-input"
                />
              </div>
              <div className="mx-auto w-full sm:max-w-[22rem]">
                <Button
                  variant="blue-gradient"
                  effect="fill"
                  size="lg"
                  fullWidth
                  className="h-12 text-base"
                  loading={busy}
                  disabled={phoneDigits.length !== 10}
                  onClick={() => void handleLookup()}
                  data-voice-control-id="ria-claim-lookup"
                >
                  Look up
                </Button>
              </div>
            </div>
          ) : null}

          {step === "found" && outcome === "no_match" ? (
            <div className="space-y-5">
              <div className="mx-auto w-full sm:max-w-[22rem]">
                <Button
                  variant="blue-gradient"
                  effect="fill"
                  size="lg"
                  fullWidth
                  className="h-12 text-base"
                  onClick={resetToPhone}
                >
                  Try another number
                </Button>
              </div>
            </div>
          ) : null}

          {step === "found" && outcome === "ambiguous_firm" && !selectedFirm ? (
            <SettingsGroup embedded separatorInset>
              {(lookup?.firms ?? []).map((candidateFirm) => (
                <SettingsRow
                  key={String(candidateFirm.crd)}
                  icon={Building2}
                  iconTone="gray"
                  title={titleCase(candidateFirm.name)}
                  description={[titleCase(candidateFirm.city), candidateFirm.state]
                    .filter(Boolean)
                    .join(", ")}
                  chevron
                  onClick={() => setSelectedFirm(candidateFirm)}
                />
              ))}
            </SettingsGroup>
          ) : null}

          {step === "found" && firm && !(outcome === "ambiguous_firm" && !selectedFirm) && outcome !== "no_match" ? (
            <div className="space-y-5">
              <FirmCard firm={firm} adviserCount={adviserCount} />

              {/* Everything the SEC lists at this number, each row claimable:
                  the advisers, then the firm itself. The user finds themselves
                  in the list — no individual-vs-firm buttons to decode. */}
              <SettingsGroup embedded separatorInset>
                {candidates.map((candidate) => {
                  const selected =
                    selectedTarget?.type === "individual" &&
                    selectedTarget.individualCrd === candidate.individual_crd;
                  return (
                    <SettingsRow
                      key={String(candidate.individual_crd)}
                      icon={UserRound}
                      iconTone={selected ? "blue" : "gray"}
                      title={titleCase(candidate.name)}
                      description={[titleCase(candidate.branch_city), candidate.branch_state]
                        .filter(Boolean)
                        .join(", ")}
                      onClick={() =>
                        setSelectedTarget({
                          type: "individual",
                          individualCrd: candidate.individual_crd ?? null,
                        })
                      }
                      trailing={<TargetRadio selected={selected} />}
                    />
                  );
                })}
                {candidates.length === 0 ? (
                  <SettingsRow
                    icon={UserRound}
                    iconTone={
                      selectedTarget?.type === "individual" ? "blue" : "gray"
                    }
                    title="I'm an adviser here"
                    description="Names appear after you verify."
                    onClick={() =>
                      setSelectedTarget({ type: "individual", individualCrd: null })
                    }
                    trailing={
                      <TargetRadio selected={selectedTarget?.type === "individual"} />
                    }
                  />
                ) : null}
                <SettingsRow
                  icon={Building2}
                  iconTone={selectedTarget?.type === "firm" ? "blue" : "gray"}
                  title={titleCase(firm.name)}
                  description="The firm itself"
                  onClick={() =>
                    setSelectedTarget({ type: "firm", individualCrd: null })
                  }
                  trailing={<TargetRadio selected={selectedTarget?.type === "firm"} />}
                />
              </SettingsGroup>

              <div className="mx-auto w-full sm:max-w-[22rem]">
                <Button
                  variant="blue-gradient"
                  effect="fill"
                  size="lg"
                  fullWidth
                  className="h-12 text-base"
                  loading={busy}
                  disabled={!selectedTarget}
                  onClick={() =>
                    selectedTarget &&
                    void beginClaim(selectedTarget.type, selectedTarget.individualCrd)
                  }
                  data-voice-control-id="ria-claim-continue"
                >
                  Continue
                </Button>
              </div>
            </div>
          ) : null}

          {step === "code" ? (
            otpUnavailable ? (
              <div className="space-y-5">
                <p className="text-[15px] leading-relaxed text-muted-foreground">
                  Codes aren&apos;t available for this number yet.
                </p>
                <div className="mx-auto w-full sm:max-w-[22rem]">
                  <Button
                    variant="none"
                    effect="fade"
                    size="lg"
                    fullWidth
                    className="h-12 text-base"
                    onClick={resetToPhone}
                  >
                    Use a different number
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-5">
                <CodeCells length={codeLength} value={code} onChange={setCode} disabled={busy} />
                {busy ? (
                  <div className="flex justify-center">
                    <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  </div>
                ) : null}
                <div className="text-center">
                  <button
                    type="button"
                    onClick={resetToPhone}
                    className="text-[14px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                  >
                    Use a different number
                  </button>
                </div>
              </div>
            )
          ) : null}

          {step === "pick" && (verifyResult?.roster ?? []).length === 0 ? (
            <div className="space-y-5">
              <p className="text-[15px] leading-relaxed text-muted-foreground">
                We couldn&apos;t load the advisers for this firm.
              </p>
              <div className="mx-auto w-full space-y-3 sm:max-w-[22rem]">
                <Button
                  variant="blue-gradient"
                  effect="fill"
                  size="lg"
                  fullWidth
                  className="h-12 text-base"
                  loading={busy}
                  onClick={() =>
                    verifyResult &&
                    void completeClaim(verifyResult.claim_ticket, "firm", null)
                  }
                  data-voice-control-id="ria-claim-firm-fallback"
                >
                  Claim the firm instead
                </Button>
                <Button
                  variant="none"
                  effect="fade"
                  size="lg"
                  fullWidth
                  className="h-12 text-base"
                  disabled={busy}
                  onClick={() => setStep("found")}
                >
                  Back
                </Button>
              </div>
            </div>
          ) : null}

          {step === "pick" && (verifyResult?.roster ?? []).length > 0 ? (
            <div className="space-y-5">
              <SettingsGroup embedded separatorInset>
                {(verifyResult?.roster ?? []).map((entry) => {
                  const selected = pickCrd === entry.individual_crd;
                  return (
                    <SettingsRow
                      key={String(entry.individual_crd)}
                      icon={UserRound}
                      iconTone={selected ? "blue" : "gray"}
                      title={titleCase(entry.name)}
                      description={[titleCase(entry.branch_city), entry.branch_state]
                        .filter(Boolean)
                        .join(", ")}
                      onClick={() => setPickCrd(entry.individual_crd ?? null)}
                      trailing={<TargetRadio selected={selected} />}
                    />
                  );
                })}
              </SettingsGroup>
              <div className="mx-auto w-full sm:max-w-[22rem]">
                <Button
                  variant="blue-gradient"
                  effect="fill"
                  size="lg"
                  fullWidth
                  className="h-12 text-base"
                  loading={busy}
                  disabled={!pickCrd}
                  onClick={() => void handlePickClaim()}
                  data-voice-control-id="ria-claim-pick"
                >
                  Claim profile
                </Button>
              </div>
            </div>
          ) : null}

          {step === "done" && completeResult ? (
            <div className="space-y-5">
              <div
                className={`rounded-[18px] border p-5 ${
                  verified
                    ? "border-[rgba(18,161,80,0.35)] bg-[rgba(18,161,80,0.08)]"
                    : "border-[rgba(201,139,46,0.3)] bg-[rgba(201,139,46,0.08)]"
                }`}
              >
                <div className="flex items-start gap-3">
                  {verified ? (
                    <CheckCircle2 className="h-6 w-6 shrink-0 text-[#12A150]" />
                  ) : (
                    <ShieldCheck className="h-6 w-6 shrink-0 text-[color:var(--ria-gold,#C8923A)]" />
                  )}
                  <div className="min-w-0">
                    <p className="text-[16px] font-semibold">
                      {completeResult.profile.display_name}
                    </p>
                    {completeResult.profile.firm_name ? (
                      <p className="mt-0.5 text-[13px] text-muted-foreground">
                        {titleCase(completeResult.profile.firm_name)}
                      </p>
                    ) : null}
                    <p className="mt-1 text-[13px] font-medium">
                      {verified ? "Verified" : "Pending verification"}
                    </p>
                  </div>
                </div>
              </div>
              {!verified ? (
                <p className="text-[13px] leading-relaxed text-muted-foreground">
                  Finish verification anytime from your profile.
                </p>
              ) : null}
              <div className="mx-auto w-full sm:max-w-[22rem]">
                <Button
                  variant="blue-gradient"
                  effect="fill"
                  size="lg"
                  fullWidth
                  className="h-12 text-base"
                  onClick={() => router.replace(ROUTES.RIA_PROFILE)}
                  data-voice-control-id="ria-claim-open-profile"
                >
                  Open your profile
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </FullscreenFlowShell>
    </>
  );
}
