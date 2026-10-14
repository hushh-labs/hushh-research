"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { ProfileResearchCard } from "@/components/agent/profile-research-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/lib/morphy-ux/card";
import { Button } from "@/lib/morphy-ux/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { HelperText } from "@/components/app-ui/typography";
import { WorldModelSourceService } from "@/lib/services/world-model-source-service";
import type { ProfileResearchResult } from "@/lib/services/profile-research-service";
import { createAgentPkmCaptureGuard } from "@/lib/agent/agent-pkm-capture-runtime";

export function WorldModelSources({
  ownerId,
  vaultKey,
  vaultOwnerToken,
  name: initialName,
}: {
  ownerId: string;
  vaultKey: string;
  vaultOwnerToken: string;
  name: string;
}) {
  const [name, setName] = useState(initialName),
    [urls, setUrls] = useState(""),
    [permitted, setPermitted] = useState(false);
  const [result, setResult] = useState<ProfileResearchResult | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const pathname = usePathname();
  const current = useRef({ ownerId, vaultKey, vaultOwnerToken });
  current.current = { ownerId, vaultKey, vaultOwnerToken };
  const lifetime = useRef(new AbortController());
  const requestGeneration = useRef(0);
  const authority = useCallback(
    () => ({
      vaultKey,
      vaultOwnerToken,
      signal: lifetime.current.signal,
      ...createAgentPkmCaptureGuard({
        userId: ownerId,
        signal: lifetime.current.signal,
        isEnabled: () =>
          current.current.ownerId === ownerId &&
          current.current.vaultKey === vaultKey &&
          current.current.vaultOwnerToken === vaultOwnerToken,
      }),
    }),
    [ownerId, vaultKey, vaultOwnerToken],
  );
  useEffect(() => {
    lifetime.current = new AbortController();
    const guard = authority();
    const generation = ++requestGeneration.current;
    void WorldModelSourceService.read(guard)
      .then((next) => {
        if (guard.isCurrent() && generation === requestGeneration.current)
          setResult(next);
      })
      .catch(() => {});
    return () => lifetime.current.abort();
  }, [authority]);
  async function prepare() {
    if (busy) return;
    const generation = ++requestGeneration.current;
    const guard = authority();
    setBusy(true);
    setMessage("");
    try {
      const next = await WorldModelSourceService.prepare(guard, {
        name,
        urls: urls
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean),
        purpose: "owner",
        permitted_public_sources: true,
      });
      if (guard.isCurrent() && generation === requestGeneration.current)
        setResult(next);
    } catch {
      if (guard.isCurrent())
        setMessage(
          "Couldn’t read those sources. Use up to three public pages and your account name.",
        );
    } finally {
      if (guard.isCurrent()) setBusy(false);
    }
  }
  return (
    <>
      <Card preset="compact">
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-sm">Add your own sources</CardTitle>
          <HelperText>
            Bring your website or public profiles. Review the supported details
            before saving them.
          </HelperText>
        </CardHeader>
        <CardContent className="space-y-3 p-4 pt-0">
          <label className="block space-y-1 text-xs">
            Your account name
            <Input
              aria-label="Your account name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={160}
            />
          </label>
          <label className="block space-y-1 text-xs">
            Public source links, one per line
            <Textarea
              aria-label="Public source links, one per line"
              value={urls}
              onChange={(e) => setUrls(e.target.value)}
              maxLength={6144}
            />
          </label>
          <label className="flex min-h-11 items-center gap-3 text-xs">
            <Checkbox
              checked={permitted}
              onCheckedChange={(v) => setPermitted(v === true)}
            />
            These are public sources I can use, supplied independently of Google
            research results.
          </label>
          <Button
            size="compact"
            data-voice-control-id="pwm_sources_prepare"
            disabled={busy || !permitted || !name.trim() || !urls.trim()}
            onClick={() => void prepare()}
          >
            {busy ? "Reading your sources…" : "Prepare details to review"}
          </Button>
          {message && <HelperText role="status">{message}</HelperText>}
        </CardContent>
      </Card>
      {result?.status === "offered" && (
        <ProfileResearchCard
          key={result.draft_id}
          initialResult={result}
          sourceReview
          ownerId={ownerId}
          vaultKey={vaultKey}
          vaultOwnerToken={vaultOwnerToken}
          enabled
          pathname={pathname}
          onSaved={() => setResult(null)}
          onDiscarded={() => setResult(null)}
        />
      )}
    </>
  );
}
