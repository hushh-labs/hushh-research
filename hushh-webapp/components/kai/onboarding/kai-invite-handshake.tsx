"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { HushhLoader } from "@/components/app-ui/hushh-loader";
import {
  SurfaceCard,
  SurfaceCardContent,
  SurfaceInset,
} from "@/components/app-ui/surfaces";
import { useAuth } from "@/hooks/use-auth";
import { ROUTES } from "@/lib/navigation/routes";
import { RiaService, type RiaInviteResolution } from "@/lib/services/ria-service";

const STEPS = ["Welcome", "Confirm", "About You", "Permissions", "Ready"] as const;
const PERMISSION_OPTIONS: Array<{
  key: keyof ReturnType<typeof defaultPermissions>;
  label: string;
  required: boolean;
}> = [
  { key: "holdings", label: "Managed account holdings", required: true },
  { key: "performance", label: "Performance reports", required: true },
  { key: "goals", label: "Financial goals", required: false },
  { key: "outsideAccounts", label: "Outside account summaries", required: false },
  { key: "liabilities", label: "Debt and liabilities", required: false },
];

function defaultPermissions() {
  return {
    holdings: true,
    performance: true,
    goals: true,
    outsideAccounts: false,
    liabilities: false,
  };
}

export function KaiInviteHandshake({ inviteToken }: { inviteToken: string }) {
  const router = useRouter();
  const { user } = useAuth();
  const [step, setStep] = useState(0);
  const [invite, setInvite] = useState<RiaInviteResolution | null>(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [permissions, setPermissions] = useState(defaultPermissions);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setLoading(true);
        setError(null);
        const next = await RiaService.resolveInvite(inviteToken);
        if (!cancelled) setInvite(next);
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load invite");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [inviteToken]);

  const title = useMemo(() => {
    if (!invite) return "Kai invite";
    return invite.ria.display_name;
  }, [invite]);

  async function acceptInvite() {
    if (!user) {
      router.replace(`/login?redirect=${encodeURIComponent(`${ROUTES.KAI_ONBOARDING}?invite=${inviteToken}`)}`);
      return;
    }

    try {
      setAccepting(true);
      setError(null);
      await RiaService.acceptInvite(await user.getIdToken(), inviteToken);
      setStep(STEPS.length - 1);
    } catch (acceptError) {
      setError(acceptError instanceof Error ? acceptError.message : "Failed to accept invite");
    } finally {
      setAccepting(false);
    }
  }

  if (loading) {
    return <HushhLoader label="Loading invite..." variant="fullscreen" />;
  }

  if (!invite) {
    return (
      <div className="mx-auto flex min-h-[70vh] w-full max-w-md items-center px-5">
        <SurfaceCard className="w-full">
          <SurfaceCardContent className="p-6 text-center">
          <p className="text-sm text-muted-foreground">{error || "Invite not found."}</p>
          </SurfaceCardContent>
        </SurfaceCard>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 pb-24 pt-4">
      <SurfaceCard tone="feature">
        <SurfaceCardContent className="space-y-8 p-6">
        <div className="flex flex-wrap gap-2">
          {STEPS.map((label, index) => (
            <div
              key={label}
              className={`min-h-10 rounded-full px-4 py-2 text-xs font-semibold uppercase tracking-[0.2em] ${
                index === step
                  ? "bg-foreground text-background"
                  : index < step
                    ? "bg-amber-500/15 text-amber-100"
                    : "border border-border text-muted-foreground"
              }`}
            >
              {label}
            </div>
          ))}
        </div>

        <div className="mt-8">
          {step === 0 ? (
            <>
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-amber-700/90 dark:text-amber-300/90">
                Invited by {title}
              </p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight text-foreground">
                Your finances, quietly understood
              </h1>
              <p className="mt-3 text-sm leading-7 text-muted-foreground">
                Kai works in the background to connect you and your advisor without exposing more
                than you approve.
              </p>
            </>
          ) : null}

          {step === 1 ? (
            <div className="space-y-4">
              <h2 className="text-2xl font-semibold text-foreground">Confirm your advisor</h2>
              <SurfaceInset className="p-5">
                <p className="text-lg font-semibold text-foreground">{invite.ria.display_name}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {invite.ria.headline || invite.ria.strategy_summary || "Verified public profile"}
                </p>
                <p className="mt-3 text-xs uppercase tracking-[0.18em] text-amber-700 dark:text-amber-300">
                  {invite.ria.verification_status}
                </p>
              </SurfaceInset>
              <p className="text-sm leading-7 text-muted-foreground">
                Your advisor only sees data you explicitly approve. Everything else stays private to
                you and Kai.
              </p>
            </div>
          ) : null}

          {step === 2 ? (
            <div className="space-y-4">
              <h2 className="text-2xl font-semibold text-foreground">A little about you</h2>
              <input
                type="text"
                autoComplete="name"
                autoCapitalize="words"
                value={name}
                onChange={(event) => setName(event.target.value)}
                aria-label="Preferred name"
                className="min-h-12 w-full rounded-2xl border border-border bg-background px-4 text-sm"
                placeholder="How should Kai address you?"
              />
              <textarea
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
                aria-label="Financial goals"
                className="min-h-28 w-full rounded-2xl border border-border bg-background px-4 py-3 text-sm"
                placeholder="Optional: what matters most to you financially right now?"
              />
            </div>
          ) : null}

          {step === 3 ? (
            <div className="space-y-4">
              <h2 className="text-2xl font-semibold text-foreground">Advisor permissions</h2>
              <p className="text-sm leading-7 text-muted-foreground">
                The current flow requests one consent template under the hood. These switches make
                the trust model explicit before you continue into Kai.
              </p>
              {PERMISSION_OPTIONS.map(({ key, label, required }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() =>
                    !required &&
                    setPermissions((current) => ({
                      ...current,
                      [key]: !current[key],
                    }))
                  }
                  className="flex min-h-14 w-full items-center justify-between rounded-2xl border border-border bg-background px-4 text-left"
                >
                  <span className="text-sm text-foreground">
                    {label} {required ? <span className="text-amber-200">required</span> : null}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {permissions[key] ? "On" : "Off"}
                  </span>
                </button>
              ))}
            </div>
          ) : null}

          {step === 4 ? (
            <div className="space-y-4 text-center">
              <h2 className="text-3xl font-semibold tracking-tight text-foreground">
                Invite accepted
              </h2>
              <p className="text-sm leading-7 text-muted-foreground">
                Your advisor request is now staged. Review and approve the access request from
                Consents after your Kai setup is complete.
              </p>
            </div>
          ) : null}
        </div>

        {error ? <p className="mt-6 text-sm text-red-500">{error}</p> : null}

        <div className="mt-8 flex flex-wrap justify-between gap-3">
          <button
            type="button"
            disabled={step === 0 || accepting}
            onClick={() => setStep((value) => Math.max(0, value - 1))}
            className="inline-flex min-h-11 items-center justify-center rounded-full border border-border px-4 text-sm font-medium text-foreground disabled:opacity-50"
          >
            Back
          </button>

          {step < STEPS.length - 2 ? (
            <button
              type="button"
              onClick={() => setStep((value) => value + 1)}
              className="inline-flex min-h-11 items-center justify-center rounded-full bg-foreground px-4 text-sm font-medium text-background"
            >
              Continue
            </button>
          ) : null}

          {step === STEPS.length - 2 ? (
            <button
              type="button"
              disabled={accepting}
              onClick={() => void acceptInvite()}
              className="inline-flex min-h-11 items-center justify-center rounded-full bg-foreground px-4 text-sm font-medium text-background disabled:opacity-60"
            >
              {accepting ? "Accepting..." : "Accept invite"}
            </button>
          ) : null}

          {step === STEPS.length - 1 ? (
            <button
              type="button"
              onClick={() => router.replace(ROUTES.CONSENTS)}
              className="inline-flex min-h-11 items-center justify-center rounded-full bg-foreground px-4 text-sm font-medium text-background"
            >
              Review in Consents
            </button>
          ) : null}
        </div>
        </SurfaceCardContent>
      </SurfaceCard>
    </div>
  );
}
