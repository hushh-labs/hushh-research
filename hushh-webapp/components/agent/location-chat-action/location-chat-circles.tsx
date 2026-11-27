"use client";

import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CacheSyncService } from "@/lib/cache/cache-sync-service";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";
import {
  buildCircleJoinUrl,
  formatCircleCodeForDisplay,
  resolveCircleJoinOrigin,
} from "@/lib/one-location/circle-join-url";
import { circleInviteSelectionLimit } from "@/lib/one-location/circle-invite-contract";
import { MAX_CIRCLE_TYPE_LABEL_LENGTH, normalizeCircleTypeLabel } from "@/lib/one-location/circle-types";
import { executeCircleMembership } from "@/lib/one-location/command-circle-membership";
import { readAllCommandPeople } from "@/lib/one-location/command-preparation";
import { oneLocationErrorMessage } from "@/lib/one-location/error-message";
import { normalizeCircleCode } from "@/lib/one-location/pending-circle-join";
import { OneLocationService } from "@/lib/one-location/service";
import {
  buildCircleInviteShareText,
  circleShareLabel,
  isShareCancellationError,
  shareNamedCircleCode,
} from "@/lib/one-location/share-circle-code";
import type {
  OneLocationCircleEligibleConnection,
  OneLocationCircleInvitePreview,
  OneLocationCircleKind,
  OneLocationCircleMember,
  OneLocationCircleMemberInvite,
  OneLocationCircleOverview,
  OneLocationCircleSummary,
} from "@/lib/one-location/types";
import { copyToClipboard } from "@/lib/utils/clipboard";
import { useLocationChatMutation } from "./use-location-chat-mutation";

type CircleProps = {
  token: string;
  ownerId: string;
  suggestedCircleName?: string;
  suggestedPersonName?: string;
  onChanged?: () => void;
};

type CircleList = { circles: OneLocationCircleSummary[]; invites: OneLocationCircleMemberInvite[] };
type CircleDetail = {
  circle: OneLocationCircleOverview;
  members: OneLocationCircleMember[];
  people: OneLocationCircleEligibleConnection[];
  inviteLimit: number;
  pendingInvites: OneLocationCircleMemberInvite[];
};
type Confirmation = {
  summary: string;
  label: string;
  run: (signal: AbortSignal) => Promise<string>;
};

function dateLabel(value: string | null | undefined): string | null {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(time) : null;
}

export function LocationChatCircles({ token, ownerId, suggestedCircleName, suggestedPersonName, onChanged }: CircleProps) {
  const id = useId();
  const { busy, error, notice, run } = useLocationChatMutation();
  const [revision, setRevision] = useState(0);
  const [list, setList] = useState<CircleList | null>(null);
  const [listError, setListError] = useState("");
  const [detail, setDetail] = useState<CircleDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  const [selectedCircleId, setSelectedCircleId] = useState<string | null>(null);
  const [editor, setEditor] = useState<"create" | "edit" | "join" | "people" | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [editSource, setEditSource] = useState<OneLocationCircleOverview | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<OneLocationCircleKind>("family");
  const [customType, setCustomType] = useState("");
  const [code, setCode] = useState("");
  const [preview, setPreview] = useState<OneLocationCircleInvitePreview | null>(null);
  const [circleQuery, setCircleQuery] = useState(suggestedCircleName ?? "");
  const [peopleQuery, setPeopleQuery] = useState(suggestedPersonName ?? "");
  const [selectedPeople, setSelectedPeople] = useState<string[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      OneLocationService.listCircles(token),
      OneLocationService.listNamedCircleMemberInvites({ vaultOwnerToken: token, direction: "incoming" }),
    ]).then(([circles, invites]) => {
      if (controller.signal.aborted) return;
      setList({ circles, invites });
      setListError("");
    }).catch((caught: unknown) => {
      if (!controller.signal.aborted) setListError(oneLocationErrorMessage(caught, "Could not load your Circles."));
    });
    return () => controller.abort();
  }, [token, revision]);

  useEffect(() => {
    if (!selectedCircleId) return;
    const circleId = selectedCircleId;
    const controller = new AbortController();
    setDetail(null);
    setDetailError("");
    async function load() {
      const circle = await OneLocationService.getCircleOverview({ vaultOwnerToken: token, circleId });
      controller.signal.throwIfAborted();
      const canInvite = circle.viewerCapabilities?.canInviteMembers ?? circle.role === "owner";
      let inviteLimit = 0;
      const pendingInvites = new Map<string, OneLocationCircleMemberInvite>();
      const [members, people] = await Promise.all([
        readAllCommandPeople((page) => {
          controller.signal.throwIfAborted();
          return OneLocationService.listCircleMembersPage({ vaultOwnerToken: token, circleId, page, limit: 100 });
        }),
        canInvite ? readAllCommandPeople(async (page) => {
          controller.signal.throwIfAborted();
          const result = await OneLocationService.listNamedCircleEligibleConnectionsPage({
            vaultOwnerToken: token, circleId, page, limit: 100,
          });
          if (page === 1) inviteLimit = circleInviteSelectionLimit(result.remainingCapacity);
          result.pendingInvites.forEach((invite) => pendingInvites.set(invite.id, invite));
          return { ...result, items: result.eligibleConnections };
        }) : Promise.resolve([]),
      ]);
      if (controller.signal.aborted) return;
      setDetail({ circle, members, people, inviteLimit, pendingInvites: [...pendingInvites.values()] });
    }
    void load().catch((caught: unknown) => {
      if (!controller.signal.aborted) setDetailError(oneLocationErrorMessage(caught, "Could not load this Circle."));
    });
    return () => controller.abort();
  }, [token, selectedCircleId, revision]);

  const refresh = () => setRevision((value) => value + 1);
  const changed = (notificationType: string, circleId: string, memberUserId?: string) => {
    CacheSyncService.onOneLocationStateMutated(ownerId, ["circles", "workspace", "sms_roster"], { notificationType, circleId, memberUserId });
    refresh();
    onChanged?.();
  };
  const selectCircle = (circleId: string | null) => {
    setSelectedCircleId(circleId);
    setDetail(null);
    setEditor(null);
    setConfirmation(null);
  };
  useBackLayer(ROUTES.HOME, confirmation || editor || selectedCircleId || busy ? 3 : 0, () => {
    if (busy) return true;
    if (confirmation) setConfirmation(null);
    else if (editor) setEditor(null);
    else if (selectedCircleId) selectCircle(null);
    else return false;
    return true;
  });
  const circle = detail?.circle;
  const canManage = !!circle && (circle.viewerCapabilities?.canManageCircle ?? circle.role === "owner");
  const canLeave = !!circle && (circle.viewerCapabilities?.canLeaveCircle ?? circle.role === "member");
  const canDelete = canManage && (circle.viewerCapabilities?.canDeleteCircle ?? !circle.isSystem);
  const canRotate = canManage && (circle.viewerCapabilities?.canRotateInviteCode ?? true);
  const liveCode = circle?.activeInviteCode;
  const showCode = circle && liveCode && Date.parse(liveCode.expiresAt) > Date.now()
    && (circle.viewerCapabilities?.canViewInviteCode ?? true);
  const canInvite = !!circle && (circle.viewerCapabilities?.canInviteMembers ?? circle.role === "owner");

  function requireFreshReview(): never {
    setEditor(null);
    setSelectedPeople([]);
    refresh();
    throw new Error("This Circle changed. Review the current details before trying again.");
  }

  async function verifyReviewedCircle(reviewed: OneLocationCircleOverview, signal: AbortSignal) {
    const fresh = await OneLocationService.getCircleOverview({ vaultOwnerToken: token, circleId: reviewed.id });
    signal.throwIfAborted();
    if (fresh.id !== reviewed.id || fresh.updatedAt !== reviewed.updatedAt ||
        fresh.name !== reviewed.name || fresh.kind !== reviewed.kind ||
        fresh.customTypeLabel !== reviewed.customTypeLabel || fresh.role !== reviewed.role) {
      requireFreshReview();
    }
    return fresh;
  }

  function readMembers(circleId: string, signal: AbortSignal) {
    return readAllCommandPeople((page) => {
      signal.throwIfAborted();
      return OneLocationService.listCircleMembersPage({ vaultOwnerToken: token, circleId, page, limit: 100 });
    });
  }

  async function verifyReviewedMembers(circleId: string, reviewed: OneLocationCircleMember[], signal: AbortSignal, wholeRoster = false) {
    const current = await readMembers(circleId, signal);
    signal.throwIfAborted();
    const byId = new Map(current.map((member) => [member.userId, member]));
    if ((wholeRoster && current.length !== reviewed.length) || reviewed.some((member) => {
      const fresh = byId.get(member.userId);
      return !member.joinedAt || !fresh || fresh.joinedAt !== member.joinedAt ||
        fresh.role !== member.role || fresh.displayName !== member.displayName;
    })) requireFreshReview();
  }

  async function verifyReviewedInvite(invite: OneLocationCircleMemberInvite, direction: "incoming" | "outgoing", signal: AbortSignal) {
    const list = await OneLocationService.listNamedCircleMemberInvites({ vaultOwnerToken: token, direction });
    signal.throwIfAborted();
    const fresh = list.find((candidate) => candidate.id === invite.id);
    if (!fresh || fresh.status !== "pending" || fresh.circleId !== invite.circleId || fresh.circleName !== invite.circleName ||
        fresh.inviterUserId !== invite.inviterUserId || fresh.inviterDisplayName !== invite.inviterDisplayName ||
        fresh.inviteeUserId !== invite.inviteeUserId || fresh.inviteeDisplayName !== invite.inviteeDisplayName ||
        fresh.createdAt !== invite.createdAt || fresh.expiresAt !== invite.expiresAt ||
        (fresh.expiresAt && Date.parse(fresh.expiresAt) <= Date.now())) requireFreshReview();
  }

  async function verifyReviewedCode(reviewed: OneLocationCircleOverview, signal: AbortSignal) {
    const fresh = await verifyReviewedCircle(reviewed, signal);
    if (!(fresh.viewerCapabilities?.canRotateInviteCode ?? fresh.role === "owner") ||
        fresh.activeInviteCode?.id !== reviewed.activeInviteCode?.id ||
        fresh.activeInviteCode?.expiresAt !== reviewed.activeInviteCode?.expiresAt ||
        fresh.inviteCodeNeedsOwnerRotation !== reviewed.inviteCodeNeedsOwnerRotation) requireFreshReview();
  }

  const startCreate = () => {
    setName(suggestedCircleName ?? "");
    setKind("family");
    setCustomType("");
    setEditor("create");
  };

  const saveCircle = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const customTypeLabel = kind === "other" ? normalizeCircleTypeLabel(customType) : "";
    const source = editor === "edit" ? editSource : null;
    if (editor === "edit" && !source) return;
    const changedName = trimmed !== source?.name;
    const changedType = kind !== source?.kind || customTypeLabel !== (source?.customTypeLabel ?? "");
    if (source && !changedName && !changedType) { setEditor(null); return; }
    const success = await run(async (signal) => {
      if (source) {
        const fresh = await verifyReviewedCircle(source, signal);
        if (!(fresh.viewerCapabilities?.canManageCircle ?? fresh.role === "owner")) requireFreshReview();
      }
      signal.throwIfAborted();
      const result = source
        ? await OneLocationService.updateNamedCircle({
          vaultOwnerToken: token, circleId: source.id,
          ...(changedName ? { name: trimmed } : {}),
          ...(changedType ? { kind, customTypeLabel } : {}),
        })
        : await OneLocationService.createNamedCircle({ vaultOwnerToken: token, name: trimmed, kind, customTypeLabel });
      if (!signal.aborted) {
        selectCircle(result.id);
        changed(source ? "location_circle_renamed" : "location_circle_created", result.id);
      }
      return source ? `Saved ${result.name}.` : `Created ${result.name}.`;
    }, "Could not verify the Circle change. Refresh your Circles before trying again.");
    if (success) setEditor(null);
  };

  const reviewCircleChange = (summary: string, label: string, perform: Confirmation["run"]) => {
    setConfirmation({ summary, label, run: perform });
  };

  const answerInvite = (invite: OneLocationCircleMemberInvite, accept: boolean) => {
    const label = accept ? "Accept invitation" : "Decline invitation";
    reviewCircleChange(`${accept ? "Accept" : "Decline"} the invitation from ${invite.inviterDisplayName} to ${invite.circleName}?`, label, async (signal) => {
      await verifyReviewedInvite(invite, "incoming", signal);
      if (accept) {
        const joined = await OneLocationService.acceptNamedCircleMemberInvite({ vaultOwnerToken: token, inviteId: invite.id });
        if (!signal.aborted) selectCircle(joined.id);
      } else {
        await OneLocationService.declineNamedCircleMemberInvite({ vaultOwnerToken: token, inviteId: invite.id });
      }
      if (!signal.aborted) changed(accept ? "location_circle_member_invite_accepted" : "location_circle_member_invite_declined", invite.circleId);
      return accept ? `Joined ${invite.circleName}.` : `Declined the invitation to ${invite.circleName}.`;
    });
  };

  const invitePeople = () => {
    if (!detail || !canInvite) return;
    const { circle: target, people, inviteLimit } = detail;
    const selected = people.filter((person) => selectedPeople.includes(person.userId));
    if (!selected.length || selected.length > inviteLimit) return;
    reviewCircleChange(`Add ${selected.map((person) => person.displayName).join(", ")} to ${target.name}?`, "Add people", async (signal) => {
      const fresh = await verifyReviewedCircle(target, signal);
      if (!(fresh.viewerCapabilities?.canInviteMembers ?? fresh.role === "owner")) requireFreshReview();
      let remainingCapacity = 0;
      const eligible = await readAllCommandPeople(async (page) => {
        signal.throwIfAborted();
        const result = await OneLocationService.listNamedCircleEligibleConnectionsPage({
          vaultOwnerToken: token, circleId: target.id, page, limit: 100,
        });
        if (page === 1) remainingCapacity = result.remainingCapacity;
        return { ...result, items: result.eligibleConnections };
      });
      signal.throwIfAborted();
      const current = new Map(eligible.map((person) => [person.userId, person.displayName]));
      if (selected.length > remainingCapacity || selected.some((person) => current.get(person.userId) !== person.displayName)) {
        requireFreshReview();
      }
      const result = await executeCircleMembership({
        binding: { owner: ownerId, circleId: target.id, circleName: target.name, people: selected, sourceReceipt: null },
        signal,
        add: (inviteeUserIds) => OneLocationService.addNamedCircleMembers({ vaultOwnerToken: token, circleId: target.id, inviteeUserIds }),
      });
      const parts = [
        result.added.length ? `${result.added.length} added.` : "",
        result.invited.length ? `${result.invited.length} invited.` : "",
        result.skipped.length ? `${result.skipped.length} skipped.` : "",
        result.unknown.length || result.notAttempted.length ? "Some outcomes need review. Check the updated roster." : "",
      ];
      if (!signal.aborted) {
        setEditor(null);
        setSelectedPeople([]);
        changed("location_circle_member_added", target.id);
      }
      return parts.filter(Boolean).join(" ");
    });
  };

  const previewCode = () => {
    const candidate = normalizeCircleCode(code);
    void run(async (signal) => {
      const result = await OneLocationService.resolveNamedCircleCode({ vaultOwnerToken: token, code: candidate });
      if (!signal.aborted) setPreview(result);
      return result.alreadyMember ? `You already belong to ${result.name}.` : "";
    }, "Could not find a Circle for that code.");
  };

  const join = () => {
    if (!preview || preview.alreadyMember) return;
    const reviewedCode = normalizeCircleCode(code);
    const reviewedName = preview.name;
    reviewCircleChange(`Join ${reviewedName}, owned by ${preview.ownerDisplayName}?`, "Join Circle", async (signal) => {
      const result = await OneLocationService.joinNamedCircle({ vaultOwnerToken: token, code: reviewedCode });
      if (!signal.aborted) {
        selectCircle(result.circle.id);
        setPreview(null);
        setCode("");
        changed("location_circle_code_joined", result.circle.id);
      }
      return result.joined ? `Joined ${result.circle.name}.` : `You already belong to ${result.circle.name}.`;
    });
  };

  const shareCode = async () => {
    if (!circle || !showCode || !liveCode) return;
    await run(async () => {
      const origin = resolveCircleJoinOrigin();
      const url = origin ? buildCircleJoinUrl(origin, liveCode.code) : undefined;
      try {
        const delivery = await shareNamedCircleCode({
          title: `Join ${circle.name} on One`,
          dialogTitle: "Share Circle invite",
          text: buildCircleInviteShareText({ circleLabel: circleShareLabel(circle.name), code: liveCode.code, hasJoinLink: Boolean(url) }),
          url,
        });
        return delivery === "copied" ? "Circle invite copied." : "Circle invite handed to the share sheet.";
      } catch (caught) {
        if (isShareCancellationError(caught)) return "";
        throw caught;
      }
    }, "Could not share this Circle invite.");
  };

  const matches = (value: string, query: string) => value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());

  return <div className="space-y-4" aria-busy={busy || undefined}>
    {notice ? <p role="status" className="text-sm">{notice}</p> : null}
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    {confirmation ? <div className="space-y-3 rounded-lg border p-3">
      <p className="text-sm">{confirmation.summary}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => {
          const reviewed = confirmation;
          setConfirmation(null);
          void run(reviewed.run, "Could not verify the change. Refresh before trying again.");
        }}>{confirmation.label}</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirmation(null)}>Cancel</Button>
      </div>
    </div> : editor === "create" || editor === "edit" ? (
      <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void saveCircle(); }}>
        <label className="block space-y-1 text-sm" htmlFor={`${id}-name`}>Circle name
          <Input id={`${id}-name`} value={name} maxLength={80} onChange={(event) => setName(event.target.value)} required disabled={busy} />
        </label>
        <label className="block space-y-1 text-sm" htmlFor={`${id}-kind`}>Circle type
          <select className="block rounded-md border bg-background p-2" id={`${id}-kind`} value={kind} onChange={(event) => setKind(event.target.value as OneLocationCircleKind)} disabled={busy}>
            <option value="family">Family</option><option value="friends">Friends</option><option value="other">Other</option>
          </select>
        </label>
        {kind === "other" ? <label className="block space-y-1 text-sm" htmlFor={`${id}-type`}>Custom type (optional)
          <Input id={`${id}-type`} maxLength={MAX_CIRCLE_TYPE_LABEL_LENGTH} value={customType} onChange={(event) => setCustomType(event.target.value)} disabled={busy} />
        </label> : null}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={busy || !name.trim()}>{editor === "create" ? "Create Circle" : "Save changes"}</Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditor(null)}>Cancel</Button>
        </div>
      </form>
    ) : editor === "join" ? <div className="space-y-3">
      <label className="block space-y-1 text-sm" htmlFor={`${id}-code`}>Invite code
        <Input id={`${id}-code`} value={code} maxLength={28} onChange={(event) => { setCode(event.target.value); setPreview(null); }} disabled={busy} />
      </label>
      {preview ? <p className="text-sm">{preview.name} · {preview.ownerDisplayName}</p> : null}
      <div className="flex flex-wrap gap-2">
        {preview && !preview.alreadyMember
          ? <Button size="sm" disabled={busy} onClick={join}>Review joining</Button>
          : <Button size="sm" disabled={busy || !normalizeCircleCode(code)} onClick={previewCode}>Check invite code</Button>}
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditor(null)}>Cancel</Button>
      </div>
    </div> : editor === "people" && detail ? <div className="space-y-3">
      <label className="block space-y-1 text-sm" htmlFor={`${id}-person`}>Search eligible Connections
        <Input id={`${id}-person`} value={peopleQuery} onChange={(event) => setPeopleQuery(event.target.value)} disabled={busy} />
      </label>
      <div className="max-h-52 space-y-2 overflow-auto">
        {detail.people.filter((person) => matches(person.displayName, peopleQuery)).map((person) => {
          const checked = selectedPeople.includes(person.userId);
          return <label key={person.userId} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={checked} disabled={busy || (!checked && selectedPeople.length >= detail.inviteLimit)}
              onChange={(event) => setSelectedPeople(event.target.checked
                ? [...selectedPeople, person.userId]
                : selectedPeople.filter((userId) => userId !== person.userId))} />
            <span className="min-w-0 break-words">
              {person.displayName}
              {person.connectedFromContacts ? <span className="ml-2 text-muted-foreground">From contacts</span> : null}
              {dateLabel(person.connectedAt) ? <span className="ml-2 text-muted-foreground">Connected {dateLabel(person.connectedAt)}</span> : null}
            </span>
          </label>;
        })}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy || !selectedPeople.length} onClick={invitePeople}>Review {selectedPeople.length || ""} selected</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditor(null)}>Cancel</Button>
      </div>
    </div> : selectedCircleId ? <div className="space-y-4">
      <Button size="sm" variant="outline" disabled={busy} onClick={() => selectCircle(null)}>All Circles</Button>
      {detailError ? <div className="space-y-2"><p role="alert" className="text-sm">{detailError}</p><Button size="sm" variant="outline" onClick={refresh}>Retry</Button></div> : null}
      {!detail && !detailError ? <p role="status" className="text-sm">Getting Circle details…</p> : null}
      {detail && circle ? <>
        <h4 className="break-words text-base font-semibold">{circle.name}</h4>
        <div className="flex flex-wrap gap-2">
          {canManage ? <Button size="sm" variant="outline" disabled={busy} onClick={() => {
            setEditSource(circle); setName(circle.name); setKind(circle.kind); setCustomType(circle.customTypeLabel ?? ""); setEditor("edit");
          }}>Edit name or type</Button> : null}
          {canInvite ? <Button size="sm" variant="outline" disabled={busy || detail.inviteLimit === 0} onClick={() => {
            setPeopleQuery(suggestedPersonName ?? ""); setSelectedPeople([]); setEditor("people");
          }}>Add people</Button> : null}
          {canDelete || canLeave ? <Button size="sm" variant="outline" disabled={busy} onClick={() => {
            reviewCircleChange(canDelete ? `Delete ${circle.name} for everyone in the Circle?` : `Leave ${circle.name}?`,
              canDelete ? "Delete Circle" : "Leave Circle", async (signal) => {
                const fresh = await verifyReviewedCircle(circle, signal);
                if (canDelete) {
                  if (!(fresh.viewerCapabilities?.canDeleteCircle ?? (fresh.role === "owner" && !fresh.isSystem))) requireFreshReview();
                  await verifyReviewedMembers(circle.id, detail.members, signal, true);
                } else {
                  if (!(fresh.viewerCapabilities?.canLeaveCircle ?? fresh.role === "member")) requireFreshReview();
                  const member = detail.members.find((person) => person.userId === ownerId);
                  if (!member) return requireFreshReview();
                  await verifyReviewedMembers(circle.id, [member], signal);
                }
                signal.throwIfAborted();
                const operation = canDelete ? OneLocationService.deleteNamedCircle : OneLocationService.leaveNamedCircle;
                await operation({ vaultOwnerToken: token, circleId: circle.id });
                if (!signal.aborted) {
                  selectCircle(null);
                  changed(canDelete ? "location_circle_deleted" : "location_circle_member_left", circle.id, ownerId);
                }
                return canDelete ? `Deleted ${circle.name}.` : `Left ${circle.name}.`;
              });
          }}>{canDelete ? "Delete Circle" : "Leave Circle"}</Button> : null}
        </div>
        <section aria-label="Circle members" className="space-y-2">
          <h5 className="text-sm font-medium">Members</h5>
          <ul className="max-h-52 space-y-2 overflow-auto">
            {detail.members.map((member) => <li className="flex flex-wrap items-center justify-between gap-2 border-t pt-2 text-sm" key={member.userId}>
              <span className="min-w-0 break-words">
                {member.displayName}{member.role === "owner" ? " · Owner" : ""}{member.userId === ownerId ? " · You" : ""}
                {dateLabel(member.joinedAt) ? <span className="ml-2 text-muted-foreground">Joined {dateLabel(member.joinedAt)}</span> : null}
              </span>
              {canManage && member.role !== "owner" && member.userId !== ownerId ? (
                <Button size="sm" variant="outline" disabled={busy} aria-label={`Remove ${member.displayName}${dateLabel(member.joinedAt) ? `, joined ${dateLabel(member.joinedAt)}` : ""}`} onClick={() => {
                  reviewCircleChange(`Remove ${member.displayName} from ${circle.name}?`, "Remove member", async (signal) => {
                    const fresh = await verifyReviewedCircle(circle, signal);
                    if (!(fresh.viewerCapabilities?.canManageCircle ?? fresh.role === "owner")) requireFreshReview();
                    await verifyReviewedMembers(circle.id, [member], signal);
                    signal.throwIfAborted();
                    await OneLocationService.removeNamedCircleMember({ vaultOwnerToken: token, circleId: circle.id, memberUserId: member.userId });
                    if (!signal.aborted) changed("location_circle_member_removed", circle.id, member.userId);
                    return `Removed ${member.displayName} from ${circle.name}.`;
                  });
                }}>Remove</Button>
              ) : null}
            </li>)}
          </ul>
        </section>
        {detail.pendingInvites.length ? <section aria-label="Sent Circle invitations" className="space-y-2">
          <h5 className="text-sm font-medium">Sent invitations</h5>
          {detail.pendingInvites.map((invite) => <div key={invite.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>{invite.inviteeDisplayName || "Pending invitation"}</span>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => {
              reviewCircleChange(`Cancel the pending invitation${invite.inviteeDisplayName ? ` for ${invite.inviteeDisplayName}` : ""}?`, "Cancel invitation", async (signal) => {
                await verifyReviewedInvite(invite, "outgoing", signal);
                await OneLocationService.cancelNamedCircleMemberInvite({ vaultOwnerToken: token, inviteId: invite.id });
                if (!signal.aborted) changed("location_circle_member_invite_cancelled", circle.id);
                return "Invitation cancelled.";
              });
            }}>Cancel invitation</Button>
          </div>)}
        </section> : null}
        {showCode || canRotate ? <section aria-label="Circle invite code" className="space-y-2">
          <h5 className="text-sm font-medium">Invite code</h5>
          {showCode ? <p className="font-mono text-sm">{formatCircleCodeForDisplay(liveCode.code)}</p> : null}
          <div className="flex flex-wrap gap-2">
            {showCode ? <>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async (signal) => {
                if (!await copyToClipboard(liveCode.code, () => !signal.aborted)) throw new Error("Could not copy the invite code.");
                return "Invite code copied.";
              }, "Could not copy the invite code.")}>Copy code</Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void shareCode()}>Share invite</Button>
            </> : null}
            {canRotate ? <Button size="sm" variant="outline" disabled={busy} onClick={() => {
              const rotate = !!showCode || circle.inviteCodeNeedsOwnerRotation === true;
              reviewCircleChange(rotate ? "Replace this code? The current code will stop working." : `Create an invite code for ${circle.name}?`,
                rotate ? "Replace code" : "Create code", async (signal) => {
                  await verifyReviewedCode(circle, signal);
                  signal.throwIfAborted();
                  await OneLocationService.createNamedCircleInviteCode({ vaultOwnerToken: token, circleId: circle.id, rotate });
                  if (!signal.aborted) changed("location_circle_invite_created", circle.id);
                  return rotate ? "Invite code replaced." : "Invite code created.";
                });
            }}>{showCode || circle.inviteCodeNeedsOwnerRotation ? "Replace code" : "Create code"}</Button> : null}
            {canRotate && showCode ? <Button size="sm" variant="outline" disabled={busy} onClick={() => {
              reviewCircleChange("Revoke this code? People will need a fresh invitation to join.", "Revoke code", async (signal) => {
                await verifyReviewedCode(circle, signal);
                signal.throwIfAborted();
                await OneLocationService.revokeNamedCircleInviteCode({ vaultOwnerToken: token, circleId: circle.id });
                if (!signal.aborted) changed("location_circle_invite_revoked", circle.id);
                return "Invite code revoked.";
              });
            }}>Revoke code</Button> : null}
          </div>
        </section> : null}
      </> : null}
    </div> : <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={startCreate} disabled={busy}>Create Circle</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => { setCode(""); setPreview(null); setEditor("join"); }}>Join with code</Button>
      </div>
      {listError ? <div className="space-y-2"><p role="alert" className="text-sm">{listError}</p><Button size="sm" variant="outline" onClick={refresh}>Retry</Button></div> : null}
      {!list && !listError ? <p role="status" className="text-sm">Getting your Circles…</p> : null}
      {list ? <>
        <label className="block space-y-1 text-sm" htmlFor={`${id}-search`}>Find a Circle
          <Input id={`${id}-search`} value={circleQuery} onChange={(event) => setCircleQuery(event.target.value)} disabled={busy} />
        </label>
        <ul className="max-h-52 space-y-2 overflow-auto">
          {list.circles.filter((item) => matches(item.name, circleQuery)).map((item) => (
            <li key={item.id}><Button className="w-full justify-start" size="sm" variant="outline" disabled={busy} onClick={() => selectCircle(item.id)}>{item.name}</Button></li>
          ))}
        </ul>
        {list.invites.length ? <section aria-label="Incoming Circle invitations" className="space-y-2">
          <h4 className="text-sm font-medium">Invitations</h4>
          {list.invites.map((invite) => <div key={invite.id} className="flex flex-wrap items-center justify-between gap-2 border-t pt-2 text-sm">
            <span>{invite.circleName} · {invite.inviterDisplayName}</span>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={busy} onClick={() => answerInvite(invite, true)}>Accept</Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => answerInvite(invite, false)}>Decline</Button>
            </div>
          </div>)}
        </section> : null}
      </> : null}
    </div>}
  </div>;
}
