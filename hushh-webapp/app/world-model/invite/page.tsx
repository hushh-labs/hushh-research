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

type Preview = Awaited<ReturnType<typeof WorldModelInvitationsService.preview>>;

export default function WorldModelInvitePage() {
  const router = useRouter();
  const { user, loading, sessionVerificationRequired } = useAuth();
  const { isVaultUnlocked } = useVault();
  const [token, setToken] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [message, setMessage] = useState("Opening your preview…");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const read = () =>
      setToken(
        new URLSearchParams(window.location.hash.slice(1)).get("claim") || "",
      );
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  useEffect(() => {
    let active = true;
    setPreview(null);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      setMessage(
        "This invitation is unavailable. Ask the sender for a new link.",
      );
      return;
    }
    setMessage("Opening your preview…");
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
  }, [token]);
  async function continueToClaim() {
    if (!preview || busy) return;
    const destination = `${ROUTES.WORLD_MODEL_INVITE}#claim=${encodeURIComponent(token)}`;
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
            ? `${ROUTES.PROFILE_WORLD_MODEL}#claim=${encodeURIComponent(token)}`
            : buildProfileVaultRoute(destination),
      );
    } catch {
      setMessage("Couldn’t continue. Please try again.");
    } finally {
      setBusy(false);
    }
  }
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
        title="Your starting profile"
        description="Prepared by the inviter from public professional sources. You decide what belongs to you."
      />
      <div className="mt-5 space-y-4 text-[13px]">
        {preview && (
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
            <HelperText>
              Verify the invited contact to claim or reject this preview.
              Claiming gives the sender no access to your model.
            </HelperText>
            <Button
              size="compact"
              disabled={busy || loading}
              onClick={() => void continueToClaim()}
            >
              Continue to review
            </Button>
          </>
        )}
        {message && <HelperText role="status">{message}</HelperText>}
      </div>
    </AppPageShell>
  );
}
