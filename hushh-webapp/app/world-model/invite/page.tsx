"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { AppPageShell } from "@/components/app-ui/app-page-shell";
import { PageHeader } from "@/components/app-ui/page-sections";
import { HelperText } from "@/components/app-ui/typography";
import { Button } from "@/lib/morphy-ux/button";
import { useAuth } from "@/lib/firebase/auth-context";
import { useVault } from "@/lib/vault/vault-context";
import { ROUTES, buildProfileVaultRoute } from "@/lib/navigation/routes";
import { PostAuthRouteService } from "@/lib/services/post-auth-route-service";
import { WorldModelInvitationsService } from "@/lib/services/world-model-invitations-service";
import {
  createWorldModelInvitationHandoff,
  needsWorldModelInvitationAccountSwitch,
  readWorldModelInvitationHandoff,
  switchWorldModelInvitationHandoffAccount,
  worldModelInvitationClaimRoute,
  worldModelInvitationHandoffRoute,
} from "@/lib/world-model/invitation-handoff";

type Preview = Awaited<ReturnType<typeof WorldModelInvitationsService.preview>>;

export default function WorldModelInvitePage() {
  const router = useRouter();
  const { user, loading, sessionVerificationRequired } = useAuth();
  const { isVaultUnlocked } = useVault();
  const [token, setToken] = useState<string | null>(null);
  const [accountSwitchHandoff, setAccountSwitchHandoff] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [message, setMessage] = useState("Checking your invitation…");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const read = () => {
      const fromFragment = new URLSearchParams(window.location.hash.slice(1)).get("claim");
      if (fromFragment) {
        setAccountSwitchHandoff(null);
        setToken(fromFragment);
        return;
      }
      const handoff = new URLSearchParams(window.location.search).get("handoff");
      if (handoff && loading) {
        setAccountSwitchHandoff(null);
        setToken(null);
        return;
      }
      const ownerId = sessionVerificationRequired ? null : user?.uid ?? null;
      const recovered = handoff
        ? readWorldModelInvitationHandoff(handoff, ownerId)
        : null;
      setAccountSwitchHandoff(
        handoff && !recovered && needsWorldModelInvitationAccountSwitch(handoff, ownerId)
          ? handoff
          : null,
      );
      setToken(recovered || "");
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, [loading, sessionVerificationRequired, user?.uid]);
  useEffect(() => {
    let active = true;
    setPreview(null);
    if (token === null) return;
    if (accountSwitchHandoff) {
      setMessage(
        "This invitation was opened with another account. Continue with this account to verify the invited contact.",
      );
      return;
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      setMessage(
        "This invitation is unavailable. Ask the sender for a new link.",
      );
      return;
    }
    setMessage("Checking your invitation…");
    void WorldModelInvitationsService.preview(token)
      .then((value) => {
        if (active) {
          setPreview(value);
          setMessage("");
        }
      })
      .catch(() => {
        if (active)
          setMessage(
            "This invitation is unavailable or has expired. Ask the sender for a new link.",
          );
      });
    return () => {
      active = false;
    };
  }, [accountSwitchHandoff, token]);
  function continueWithThisAccount() {
    if (!accountSwitchHandoff || !user || loading || sessionVerificationRequired) return;
    const recovered = switchWorldModelInvitationHandoffAccount(
      accountSwitchHandoff,
      user.uid,
    );
    setAccountSwitchHandoff(null);
    setToken(recovered || "");
    if (!recovered) {
      setMessage("This invitation is unavailable. Ask the sender for a new link.");
    }
  }
  async function continueToClaim() {
    if (!preview || !token || busy) return;
    const id = createWorldModelInvitationHandoff(
      token,
      user && !sessionVerificationRequired ? user.uid : null,
    );
    if (!id) {
      setMessage("Couldn’t keep this invitation through sign-in. Please try again in this tab.");
      return;
    }
    const destination = worldModelInvitationHandoffRoute(id);
    if (!user || sessionVerificationRequired) {
      router.push(
        `${ROUTES.LOGIN}?redirect=${encodeURIComponent(destination)}`,
      );
      return;
    }
    setBusy(true);
    try {
      const next = await PostAuthRouteService.resolveAfterLogin({
        userId: user.uid,
        redirectPath: destination,
      });
      router.push(
        next !== destination
          ? next
          : isVaultUnlocked
            ? worldModelInvitationClaimRoute(id)
            : buildProfileVaultRoute(destination),
      );
    } catch {
      setMessage("Couldn’t continue. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  const hasPreparedPreview = preview !== null && "report" in preview;
  return (
    <AppPageShell
      width="reading"
      className="py-6"
      style={{ maxWidth: "30rem" }}
    >
      <NativeTestBeacon
        marker="native-route-pwm-invite"
        routeId="/world-model/invite"
        authState={user ? "authenticated" : "anonymous"}
        dataState={preview ? "loaded" : "unavailable-valid"}
      />
      <PageHeader
        eyebrow="Personal World Model"
        title={hasPreparedPreview ? "Your starting profile" : "Your invitation"}
        description={
          hasPreparedPreview
            ? "Prepared by the inviter from public professional sources. You decide what belongs to you."
            : "You decide whether to claim this invitation."
        }
      />
      <div className="mt-5 space-y-4 text-[13px]">
        {preview && (
          <>
            {"report" in preview ? (
              <>
                {preview.introduction && <p>{preview.introduction}</p>}
                {preview.report.sections.map((section) => (
                  <section key={section.kind} className="space-y-2">
                    {section.facts.map((fact, index) => (
                      <div
                        key={index}
                        className="rounded-lg border border-border p-3"
                      >
                        <p>{fact.statement}</p>
                        {fact.sources.map((source) => (
                          <a
                            key={source.url}
                            href={source.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex min-h-11 items-center text-xs underline"
                          >
                            {source.title}
                          </a>
                        ))}
                      </div>
                    ))}
                  </section>
                ))}
              </>
            ) : (
              <p>
                This invitation does not include a prepared preview. Continue
                to verify the invited contact, then choose whether to claim or
                reject it.
              </p>
            )}
            <HelperText>
              {hasPreparedPreview &&
                "Verify the invited contact to claim or reject this preview. "}
              Claiming gives the sender no access to your model.
            </HelperText>
            <Button
              size="compact"
              disabled={busy || loading}
              onClick={() => void continueToClaim()}
            >
              {hasPreparedPreview ? "Continue to review" : "Continue to verify"}
            </Button>
          </>
        )}
        {message && <HelperText role="status">{message}</HelperText>}
        {accountSwitchHandoff && user && !loading && !sessionVerificationRequired && (
          <Button size="compact" onClick={continueWithThisAccount}>
            Continue with this account
          </Button>
        )}
      </div>
    </AppPageShell>
  );
}
