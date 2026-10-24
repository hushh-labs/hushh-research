"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useWorldModelOwnerState } from "./world-model-owner-state";
import { usePathname } from "next/navigation";
import { ProfileResearchCard } from "@/components/agent/profile-research-card";
import { SettingsGroup } from "@/components/profile/settings-ui";
import { Button } from "@/lib/morphy-ux/button";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  FormLabel,
  HelperText,
  RowDescription,
  RowLabel,
} from "@/components/app-ui/typography";
import { WorldModelSourceService } from "@/lib/services/world-model-source-service";
import type { ProfileResearchResult } from "@/lib/services/profile-research-service";
import { createAgentPkmCaptureGuard } from "@/lib/agent/agent-pkm-capture-runtime";

type WorldModelSourcesProps = {
  ownerId: string; vaultKey: string; vaultOwnerToken: string; name: string;
  embedded?: boolean; present?: boolean; backQuery?: Readonly<Record<string, string>>; onSaved?: () => void;
  onResearchPublicProfiles?: (urls: readonly string[]) => void;
  discovery?: boolean;
  initialUrls?: readonly string[];
  onRefresh?: () => void;
};

/** The same source reader/preparer backs the web form and native scene. A
 * prepared review is not a confirmed fact or a successful memory write. */
export function useWorldModelSources({ ownerId, vaultKey, vaultOwnerToken, name, present = true, initialUrls, discovery = false }: WorldModelSourcesProps) {
  const session = useMemo(() => ({ live: false, pending: false, ownerId, vaultKey, vaultOwnerToken }), [ownerId, vaultKey, vaultOwnerToken]);
  useLayoutEffect(() => { session.live = !!ownerId && !!vaultKey && !!vaultOwnerToken; return () => { session.live = false; }; }, [session, ownerId, vaultKey, vaultOwnerToken]);
  const [urls, setUrls] = useWorldModelOwnerState(session, initialUrls?.join("\n") ?? ""), [permitted, setPermitted] = useWorldModelOwnerState(session, false);
  const [result, setResult] = useWorldModelOwnerState<ProfileResearchResult | null>(session, null),
    [busy, setBusy] = useWorldModelOwnerState(session, false), [message, setMessage] = useWorldModelOwnerState(session, "");
  const current = useRef({ ownerId, vaultKey, vaultOwnerToken, present });
  current.current = { ownerId, vaultKey, vaultOwnerToken, present };
  const lifetime = useRef(new AbortController());
  const requestGeneration = useRef(0);
  const authority = useCallback(() => ({ vaultKey, vaultOwnerToken, signal: lifetime.current.signal,
    ...createAgentPkmCaptureGuard({ userId: ownerId, signal: lifetime.current.signal,
      isEnabled: () => session.live && current.current.present && current.current.ownerId === ownerId &&
        current.current.vaultKey === vaultKey && current.current.vaultOwnerToken === vaultOwnerToken }) }),
  [ownerId, vaultKey, vaultOwnerToken, session]);
  useEffect(() => {
    lifetime.current = new AbortController();
    if (discovery || !present || !ownerId || !vaultKey || !vaultOwnerToken) return;
    const guard = authority(), generation = ++requestGeneration.current;
    void WorldModelSourceService.read(guard).then(next => {
      if (guard.isCurrent() && generation === requestGeneration.current) setResult(next);
    }).catch(() => undefined);
    return () => lifetime.current.abort();
  }, [authority, present, ownerId, vaultKey, vaultOwnerToken, setResult, discovery]);
  const canPrepare = present && !busy && permitted && !!name.trim() && !!urls.trim();
  async function prepare(snapshot = { urls, permitted }) {
    if (session.pending || !present || !snapshot.permitted || !name.trim() || !snapshot.urls.trim()) return false;
    const generation = ++requestGeneration.current, guard = authority();
    if (!guard.isCurrent()) return false;
    session.pending = true; setBusy(true); setMessage("");
    try {
      await guard.assertCurrent();
      const next = await WorldModelSourceService.prepare(guard, { name,
        urls: snapshot.urls.split("\n").map(x => x.trim()).filter(Boolean), purpose: "owner", permitted_public_sources: true });
      if (!guard.isCurrent() || generation !== requestGeneration.current) return false;
      setResult(next); return true;
    } catch {
      if (guard.isCurrent()) setMessage("Couldn’t read those pages. Add up to three public links and your name.");
      return false;
    } finally { session.pending = false; setBusy(false); }
  }
  return { urls, setUrls, permitted, setPermitted, result, setResult, busy, message, canPrepare, prepare };
}

export function WorldModelSources({
  ownerId,
  vaultKey,
  vaultOwnerToken,
  name,
  embedded = false,
  present = true,
  backQuery,
  onSaved,
  onResearchPublicProfiles,
  discovery = false,
  initialUrls,
  onRefresh,
}: WorldModelSourcesProps) {
  const { urls, setUrls, permitted, setPermitted, result, setResult, busy, message, prepare } =
    useWorldModelSources({ ownerId, vaultKey, vaultOwnerToken, name, present, initialUrls, discovery });
  const pathname = usePathname();
  return (
    <>
      <SettingsGroup title="Pages you choose">
        <div className="space-y-3 px-4 py-3">
          <HelperText>
            {discovery ? "Choose public links from details you confirmed, or add your own. Your saved choices stay unchanged. New findings arrive in To review. Existing search details reuse your name, verified contacts and previously approved links." : "Add your website or public profiles. You review every detail before it’s saved."}
          </HelperText>
          <div className="block space-y-1">
            <FormLabel as="span">Your name</FormLabel>
            <RowLabel as="p" data-testid="pwm-sources-name">
              {name.trim() || "Not added"}
            </RowLabel>
          </div>
          <label className="block space-y-1">
            <FormLabel as="span">Page links, one per line</FormLabel>
            <Textarea
              aria-label="Page links, one per line"
              value={urls}
              onChange={(e) => setUrls(e.target.value)}
              maxLength={6144}
            />
          </label>
          <label className="flex min-h-11 items-center gap-3">
            <Checkbox
              checked={permitted}
              onCheckedChange={(v) => setPermitted(v === true)}
            />
            <RowDescription as="span">
              {discovery ? "I approve using these public links for this research." : "These are public pages I chose myself, not search results."}
            </RowDescription>
          </label>
          {!discovery ? <Button
            size="compact"
            data-voice-control-id="pwm_sources_prepare"
            disabled={busy || !permitted || !name.trim() || !urls.trim()}
            onClick={() => void prepare()}
          >
            {busy ? "Reading pages…" : "Read these pages"}
          </Button> : null}
          {onResearchPublicProfiles && <>
            <HelperText>Use these profiles as starting links for GPT-5 mini research. Azure and the search provider shown in Research and email receive the public links. You review findings before saving.</HelperText>
            <Button size="compact" data-voice-control-id="pwm_public_profiles_research"
              disabled={busy || !permitted || !name.trim() || !urls.trim() || !present}
              onClick={() => {
                if (present && !busy && permitted && name.trim() && urls.trim())
                  onResearchPublicProfiles(urls.split("\n").map(value => value.trim()).filter(Boolean));
              }}>
              {discovery ? "Find more about me" : "Research these profiles"}
            </Button>
          </>}
          {discovery && onRefresh ? (
            <Button type="button" size="compact" variant="none"
              data-voice-control-id="pwm_refresh" disabled={busy || !name.trim() || !present}
              onClick={() => { if (present && !busy && name.trim()) onRefresh(); }}>
              Use my existing search details
            </Button>
          ) : null}
          {message && <HelperText role="status">{message}</HelperText>}
        </div>
      </SettingsGroup>
      {!discovery && result?.status === "offered" && (
        <ProfileResearchCard
          key={result.draft_id}
          initialResult={result}
          sourceReview
          ownerId={ownerId}
          vaultKey={vaultKey}
          vaultOwnerToken={vaultOwnerToken}
          enabled
          pathname={pathname}
          embedded={embedded}
          present={present}
          backQuery={backQuery}
          onSaved={() => {
            setResult(null);
            onSaved?.();
          }}
          onDiscarded={() => setResult(null)}
        />
      )}
    </>
  );
}
