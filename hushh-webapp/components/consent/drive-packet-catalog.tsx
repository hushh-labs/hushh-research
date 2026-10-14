"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useAuth } from "@/hooks/use-auth";
import { useVault } from "@/lib/vault/vault-context";
import { isValidatedAuthSessionOwnerCurrent, snapshotValidatedAuthSessionOwner } from "@/lib/auth/session-owner";
import { isVaultSessionEpochCurrent, snapshotVaultSessionEpoch, subscribeVaultSessionEpoch } from "@/lib/vault/session-epoch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { formatDocumentRequestPrice, parseDocumentRequestPrice } from "@/lib/consent/document-request-price";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { DrivePacketService, type DrivePacket, type PacketGuard } from "@/lib/services/drive-packet-service";
import { AuthService } from "@/lib/services/auth-service";

export function useDrivePacketSession(scope: string) {
  const { user } = useAuth();
  const userId = user?.uid ?? null;
  const { vaultOwnerToken, isVaultUnlocked } = useVault();
  const epoch = useSyncExternalStore(subscribeVaultSessionEpoch, snapshotVaultSessionEpoch, () => 0);
  const key = `${userId ?? ""}:${epoch}:${scope}`;
  const identity = useMemo(() => ({ key, token: vaultOwnerToken }), [key, vaultOwnerToken]);
  const current = useRef(identity);
  useLayoutEffect(() => { current.current = identity; }, [identity]);
  const owner = useMemo(() => identity.token ? snapshotValidatedAuthSessionOwner() : null, [identity]);
  const alive = useRef(true);
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const guard = useCallback(() => {
    if (!alive.current || !userId || !isVaultUnlocked || !vaultOwnerToken ||
        current.current.key !== key || current.current.token !== vaultOwnerToken ||
        !isVaultSessionEpochCurrent(epoch) || owner?.userId !== userId ||
        !isValidatedAuthSessionOwnerCurrent(owner)) throw new Error("session_changed");
  }, [epoch, isVaultUnlocked, key, owner, userId, vaultOwnerToken]);
  return { key, guard, token: isVaultUnlocked && userId ? vaultOwnerToken : null };
}

export function DrivePacketCatalog({ ownerPersonRef, refreshKey = 0, preparationPaused = false }: { ownerPersonRef?: string; refreshKey?: number; preparationPaused?: boolean }) {
  const session = useDrivePacketSession(ownerPersonRef ?? "owner-packets");
  if (!session.token) return null;
  return <PacketList key={session.key} token={session.token} guard={session.guard}
    ownerPersonRef={ownerPersonRef} refreshKey={refreshKey} preparationPaused={preparationPaused} />;
}

function PacketList({ token, guard, ownerPersonRef, refreshKey, preparationPaused }: {
  token: string; guard: PacketGuard; ownerPersonRef?: string; refreshKey: number; preparationPaused: boolean;
}) {
  const [packets, setPackets] = useState<DrivePacket[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const serial = useRef(0);
  const load = useCallback(async (next?: string | null) => {
    const attempt = ++serial.current;
    setBusy(true); setError(false);
    const current = () => { guard(); if (attempt !== serial.current) throw new Error("superseded"); };
    try {
      const result = await DrivePacketService.packets(token, current, ownerPersonRef, next);
      current();
      setPackets(previous => next ? [...previous.filter(packet => !result.packets.some(p => p.packetId === packet.packetId)), ...result.packets] : result.packets);
      setCursor(result.nextCursor); setLoaded(true);
    } catch { try { current(); setError(true); } catch { /* Superseded private view. */ } }
    finally { try { current(); setBusy(false); } catch { /* Superseded private view. */ } }
  }, [guard, ownerPersonRef, token]);
  useEffect(() => { void load(); return () => { serial.current += 1; }; }, [load, refreshKey]);
  return <section aria-label={ownerPersonRef ? "Available document packets" : "Your document packets"}>
    <SettingsGroup density="compact" title={ownerPersonRef ? "Available packets" : "Prepared packets"}>
    {packets.map(packet => <PacketCard key={`${packet.packetId}:${packet.version}:${packet.listingRevision}`} packet={packet}
      owner={!ownerPersonRef} token={token} guard={guard} onChanged={() => void load()} />)}
    {loaded && !packets.length && !error && <SettingsRow title={ownerPersonRef ? "No packets available yet" : preparationPaused ? "Preparation paused" : "Agent One is preparing your packets."} />}
    {error && <SettingsRow title="Couldn’t load packets." trailing={<Button variant="ghost" size="compact" disabled={busy} onClick={() => void load()}>Retry packets</Button>} />}
    {busy && !loaded && <SettingsRow title="Loading packets…" />}
    {cursor && <Button variant="outline" size="compact" disabled={busy} onClick={() => void load(cursor)}>More packets</Button>}
    </SettingsGroup>
  </section>;
}

function PacketCard({ packet, owner, token, guard, onChanged }: {
  packet: DrivePacket; owner: boolean; token: string; guard: PacketGuard; onChanged: () => void;
}) {
  const { user } = useAuth();
  const [price, setPrice] = useState((packet.priceCents / 100).toFixed(2));
  const [editingPrice, setEditingPrice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [needsGoogle, setNeedsGoogle] = useState(false);
  const [request, setRequest] = useState<{ requestId: string; existingAccess: boolean } | null>(null);
  const attemptId = useRef<string | null>(null);
  const lock = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const current = () => { guard(); if (!alive.current) throw new Error("unmounted"); };
  const amount = parseDocumentRequestPrice(price);
  const act = async (decision?: "allow" | "deny") => {
    if (lock.current || owner && decision === "allow" && amount === null) return;
    try { current(); } catch { return; }
    lock.current = true; setBusy(true); setMessage("");
    try {
      if (owner && decision) {
        await DrivePacketService.listing(token, packet, decision, decision === "deny" ? packet.priceCents : amount!, current);
        current(); onChanged();
      } else if (!owner) {
        attemptId.current ??= crypto.randomUUID();
        const isCurrent = () => { try { current(); return true; } catch { return false; } };
        const firebaseToken = await (needsGoogle
          ? AuthService.linkGoogleIdentity(user?.uid ?? "", isCurrent)
          : AuthService.documentRequestIdentityToken(user?.uid ?? "", isCurrent));
        current(); setNeedsGoogle(false);
        const result = await DrivePacketService.request(token, firebaseToken, packet, attemptId.current, current);
        current(); setRequest(result);
      }
    } catch (cause) { try {
      current();
      const code = cause instanceof Error ? "code" in cause ? String(cause.code) : cause.message : "";
      if (["verify_google_identity_required", "google_identity_required"].includes(code)) {
        setNeedsGoogle(true); setMessage("Add a Google account once to receive original files.");
      } else if (["packet_changed", "listing_changed", "price_changed", "packet_unavailable"].includes(code)) {
        setMessage("This packet changed. Refresh it before continuing."); onChanged();
      } else if (code === "connection_required") setMessage("Connect with this person before requesting files.");
      else if (["identity_cancelled", "identity_popup_blocked", "identity_already_linked"].includes(code)) setMessage(code === "identity_cancelled" ? "Google verification was cancelled. No request was sent." : code === "identity_popup_blocked" ? "Allow the Google verification popup, then retry." : "That Google account belongs to another One account. Choose another.");
      else setMessage("Couldn’t finish. Retry to check the latest status.");
    } catch { /* No stale private output. */ } }
    finally { lock.current = false; try { current(); setBusy(false); } catch { /* Unmounted. */ } }
  };
  const state = packet.freshness === "paused" ? "Paused" : packet.freshness === "stale" ? "Update needed" :
    packet.state === "ready" ? "Ready" : packet.state === "incomplete" ? "Incomplete" : "Unable to verify";
  return <article className="min-w-0 text-sm">
    <SettingsRow title={packet.title} description={`${packet.coverageSummary} · ${packet.documentCount} ${packet.documentCount === 1 ? "document" : "documents"}`}
      trailing={<span className="tabular-nums">{formatDocumentRequestPrice(owner && amount !== null ? amount : packet.priceCents)}</span>} />
    <div className="space-y-2 px-4 pb-2">
    {(state !== "Ready" || packet.gaps.length > 0) && <p className="text-xs text-muted-foreground">{state}{packet.gaps.length > 0 ? ` · ${packet.gaps[0]}` : ""}</p>}
    {owner ? <>
      {editingPrice && <label className="block text-xs text-muted-foreground">Price
        <div className="mt-1 flex items-center gap-2"><span aria-hidden="true">$</span><Input aria-label={`Price for ${packet.title}`} inputMode="decimal" value={price} onChange={event => setPrice(event.target.value)} disabled={busy} className="min-h-11 max-w-40" /></div>
      </label>}
      {amount === null && <p className="text-xs" role="status">Enter $0.50–$500, up to two decimal places.</p>}
      <div className="flex flex-wrap gap-2"><Button size="compact" disabled={busy || !packet.canList || amount === null} onClick={() => void act("allow")}>Allow</Button>
        <Button size="compact" variant="outline" disabled={busy} onClick={() => void act("deny")}>Deny</Button>
        <Button size="compact" variant="ghost" disabled={busy} aria-expanded={editingPrice} onClick={() => setEditingPrice(value => !value)}>Edit price</Button></div>
    </> : request ? <Button asChild size="compact" variant="outline"><Link href={buildConsentCenterHref("pending", { requestId: `document_share_request:${request.requestId}`, requestView: "sent" })}>{request.existingAccess ? "View access" : "View request"}</Link></Button> :
      <Button size="compact" disabled={busy || !packet.canRequest} onClick={() => void act()}>{busy ? "Requesting…" : needsGoogle ? "Add Google account" : `Request packet · ${formatDocumentRequestPrice(packet.priceCents)}`}</Button>}
    <details className="text-xs text-muted-foreground"><summary className="min-h-11 cursor-pointer py-3">View details</summary>
      <p className="break-words">{packet.description}</p>
      <p>{packet.verifiedAt ? `Verified ${new Date(packet.verifiedAt).toLocaleString()}` : "Not yet verified"} · {state}</p>
      {packet.gaps.length > 0 && <ul className="list-inside list-disc">{packet.gaps.map((gap, index) => <li key={index} className="break-words">{gap}</li>)}</ul>}
      <p>Agent One assessment {packet.assessmentScore}/100 · Importance {packet.importance}/500</p>
      <p>The assessment is not a measured probability of correctness.</p>
      {owner && <p>{packet.listingEnabled ? "Summary visible to your connections." : "Allow makes this summary visible to your connections."} Each buyer needs your approval.</p>}
    </details>
    {message && <p role="status" className="text-xs">{message}</p>}
    </div>
  </article>;
}
