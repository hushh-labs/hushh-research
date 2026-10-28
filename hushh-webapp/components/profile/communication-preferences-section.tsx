"use client";

/**
 * Profile > Preferences: "How One writes to you".
 *
 * The owner's standing style settings, stored encrypted in the reserved
 * `identity.communication_preferences` branch. This is the only place they are
 * edited: chat can only propose a change (its offer card hands the values here
 * in memory), and the owner commits with Save, through the Settings writer.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { morphyToast as toast } from "@/lib/morphy-ux/morphy";

import { NativeWritingStyleEditor } from "@/components/profile/native-writing-style-editor";
import { SettingsGroup, SettingsRow } from "@/components/profile/settings-ui";
import { LockedRowIcon } from "@/components/icons/agents";
import {
  OWNER_STYLE_BRANCH,
  OWNER_STYLE_DOMAIN,
  OWNER_STYLE_PROPOSAL_EVENT,
  ownerStyleFromBranch,
  readOwnerStyleProposal,
  clearOwnerStyleProposal,
  type OwnerStyleProposal,
  type OwnerStyleSettings,
} from "@/lib/agent/owner-style-settings";
import { saveOwnerStyleSettings } from "@/lib/agent/owner-style-settings-writer";
import { PkmDomainResourceService } from "@/lib/pkm/pkm-domain-resource";
import paneStyles from "./communication-preferences-pane.module.css";

function sameSettings(left: OwnerStyleSettings, right: OwnerStyleSettings): boolean {
  return JSON.stringify(ownerStyleFromBranch(left)) === JSON.stringify(ownerStyleFromBranch(right));
}

export type CommunicationPreferencesProps = {
  userId: string | null;
  vaultKey: string | null;
  vaultOwnerToken: string | null;
  onRequestUnlock: () => void;
  nativeScene?: boolean;
};
export type CommunicationSaveOutcome = "saved" | "failed" | "stale" | "busy" | "refused";

/** The one encrypted Settings writer stays in React. A native scene may hold
 * ordinary preference replicas, never the credentials returned to this hook. */
export function useCommunicationPreferencesEditor({ userId, vaultKey, vaultOwnerToken }: Omit<CommunicationPreferencesProps, "onRequestUnlock">) {
  const unlocked = Boolean(userId && vaultKey && vaultOwnerToken);
  // A renewed token is compatible; a changed owner/key or lock is not.
  const owner = useMemo(() => ({ userId, vaultKey, unlocked }), [userId, vaultKey, unlocked]);
  const committedOwner = useRef(owner);
  const credentials = useRef({ owner, vaultOwnerToken });
  const mounted = useRef(true);
  const [stateOwner, setStateOwner] = useState(owner);
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState<OwnerStyleSettings | null>(null);
  const [draft, setDraft] = useState<OwnerStyleSettings>({});
  const [suggested, setSuggested] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftRevision, setDraftRevision] = useState(0);
  const revision = useRef(0);
  const draftRef = useRef(draft);
  const savedRef = useRef(saved);
  const appliedProposal = useRef<OwnerStyleProposal | null>(null);
  const pending = useRef<{ owner: typeof owner; revision: number } | null>(null);
  const ownerMatches = stateOwner === owner;
  const ready = ownerMatches && loaded && unlocked;
  useLayoutEffect(() => {
    if (committedOwner.current !== owner) pending.current = null;
    committedOwner.current = owner;
    credentials.current = { owner, vaultOwnerToken };
  }, [owner, vaultOwnerToken]);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const isCurrent = useCallback(() => mounted.current && committedOwner.current === owner && owner.unlocked, [owner]);
  const replaceDraft = useCallback((value: OwnerStyleSettings) => {
    draftRef.current = value;
    revision.current += 1;
    setDraftRevision(revision.current);
    setDraft(value);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStateOwner(owner);
    setLoaded(false);
    setSaved(null);
    savedRef.current = null;
    appliedProposal.current = null;
    replaceDraft({});
    setSuggested(false);
    setSaving(false);
    setError(null);
    setLoadFailed(false);
    if (!owner.userId || !owner.unlocked) return;
    void (async () => {
      try {
        const snapshot = await PkmDomainResourceService.getStaleFirst({
          userId: owner.userId!,
          domain: OWNER_STYLE_DOMAIN,
          vaultKey: owner.vaultKey,
          vaultOwnerToken: credentials.current.vaultOwnerToken,
          backgroundRefresh: false,
        });
        if (cancelled || !isCurrent()) return;
        const stored = ownerStyleFromBranch(snapshot?.data?.[OWNER_STYLE_BRANCH]);
        // A chat offer is applied over what is stored, and only shown here.
        const proposal = readOwnerStyleProposal(owner.userId!);
        appliedProposal.current = proposal;
        savedRef.current = stored;
        setSaved(stored);
        replaceDraft(proposal ? { ...stored, ...proposal } : stored);
        setSuggested(Boolean(proposal));
      } catch {
        // Saving over a branch that could not be read would erase it.
        if (!cancelled && isCurrent()) setLoadFailed(true);
      } finally {
        if (!cancelled && isCurrent()) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [owner, isCurrent, replaceDraft]);

  useEffect(() => {
    if (!owner.userId || !ready || saved === null) return;
    const apply = () => {
      if (!isCurrent()) return;
      const proposal = readOwnerStyleProposal(owner.userId!);
      if (!proposal) return;
      appliedProposal.current = proposal;
      replaceDraft({ ...draftRef.current, ...proposal });
      setSuggested(true);
    };
    window.addEventListener(OWNER_STYLE_PROPOSAL_EVENT, apply);
    return () => window.removeEventListener(OWNER_STYLE_PROPOSAL_EVENT, apply);
  }, [owner, ready, saved, isCurrent, replaceDraft]);

  const dirty = ready && saved !== null && !sameSettings(saved, draft);
  const changeDraft = (next: OwnerStyleSettings) => {
    if (!isCurrent() || !ready || pending.current?.owner === owner) return;
    replaceDraft(next);
    setSuggested(false);
    setError(null);
  };
  const changeField = <K extends keyof OwnerStyleSettings>(key: K, value: OwnerStyleSettings[K]) => {
    const next = { ...draftRef.current };
    if (value === undefined || value === "") delete next[key];
    else if (key === "owner_style_note" && typeof value === "string") next.owner_style_note = value.replace(/[\r\n]+/g, " ");
    else next[key] = value;
    changeDraft(next);
  };
  const save = async (): Promise<CommunicationSaveOutcome> => {
    if (!isCurrent() || credentials.current.owner !== owner || revision.current !== draftRevision) return "stale";
    if (pending.current) return "busy";
    if (!ready || loadFailed || savedRef.current === null || sameSettings(savedRef.current, draftRef.current) || !owner.userId) return "refused";
    const settings = ownerStyleFromBranch(draftRef.current);
    const ticket = { owner, revision: revision.current, proposal: appliedProposal.current };
    pending.current = ticket;
    setSaving(true);
    setError(null);
    try {
      const ok = await saveOwnerStyleSettings({ userId: owner.userId, vaultKey: owner.vaultKey,
        vaultOwnerToken: credentials.current.vaultOwnerToken, settings });
      if (!isCurrent()) return "stale";
      if (!ok) throw new Error("save failed");
      if (ticket.proposal) clearOwnerStyleProposal(owner.userId, ticket.proposal);
      if (appliedProposal.current === ticket.proposal) appliedProposal.current = null;
      savedRef.current = settings;
      setSaved(settings);
      if (revision.current === ticket.revision) { replaceDraft(settings); setSuggested(false); }
      toast.success("Writing style saved");
      return "saved";
    } catch {
      if (!isCurrent()) return "stale";
      const message = "Couldn't save your writing style. Please try again.";
      setError(message);
      toast.error(message);
      return "failed";
    } finally {
      if (pending.current === ticket) {
        pending.current = null;
        if (isCurrent()) setSaving(false);
      }
    }
  };
  return { userId, unlocked, ready, loading: unlocked && !ready, draft: ownerMatches ? draft : {},
    dirty, saving: ownerMatches && saving, unavailable: ownerMatches && loadFailed,
    suggested: ownerMatches && suggested && dirty, error: ownerMatches ? error : null,
    draftRevision, changeDraft, changeField, save };
}

export function CommunicationPreferencesSection(props: CommunicationPreferencesProps) {
  const model = useCommunicationPreferencesEditor(props);

  if (!model.unlocked) {
    return (
      <SettingsGroup title="How One writes to you" className={paneStyles.paneTypography} testId="style-settings-group">
        <SettingsRow
          icon={LockedRowIcon}
          iconTone="capability"
          title="Unlock to edit"
          description="Your writing style is stored in your vault."
          onClick={props.onRequestUnlock}
          chevron
        />
      </SettingsGroup>
    );
  }

  return (
    <NativeWritingStyleEditor model={model} eligible={props.nativeScene === true} />
  );
}
