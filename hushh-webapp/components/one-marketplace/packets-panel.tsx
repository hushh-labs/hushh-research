"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/lib/morphy-ux/morphy";
import {
  OneMarketplaceService,
  type PacketCatalogEntry,
  type PacketDetail,
  type PkmPacket,
} from "@/lib/one-marketplace/service";

/** A PKM detail the owner can put in a packet: a reference, never a value. */
export interface PacketDetailOption extends PacketDetail {
  domainTitle: string;
}

function dollars(cents: number | null): string {
  return cents == null ? "" : (cents / 100).toFixed(2);
}

function statusLine(packet: PkmPacket | undefined): string {
  if (!packet) return "Not added";
  if (!packet.forSale) return `${packet.contents.length} detail${packet.contents.length === 1 ? "" : "s"} · not for sale`;
  return `$${dollars(packet.priceCents)} · ${packet.creditCost} credit${packet.creditCost === 1 ? "" : "s"}`;
}

/**
 * Owner's packets: the ten standard ones plus custom. Each bundles PKM details
 * the owner picks, priced in dollars and credits, or marked not for sale.
 * Selling still needs the owner's yes on every buyer request.
 */
export function PacketsPanel({ token, details }: { token?: string; details: PacketDetailOption[] }) {
  const [packets, setPackets] = useState<PkmPacket[]>([]);
  const [catalog, setCatalog] = useState<PacketCatalogEntry[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const res = await OneMarketplaceService.listPackets({ vaultOwnerToken: token });
      setPackets(res.packets);
      setCatalog(res.catalog);
    } catch {
      toast.error("Couldn't load your packets");
    } finally {
      setLoaded(true);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const byKind = useMemo(() => new Map(packets.filter((p) => p.kind !== "custom").map((p) => [p.kind, p])), [packets]);
  const custom = packets.filter((p) => p.kind === "custom");

  if (!token) return null;

  return (
    <section className="rounded-2xl border p-5" aria-labelledby="packets-heading">
      <h2 id="packets-heading" className="text-lg font-semibold">
        Packets
      </h2>
      <p className="mt-0.5 text-sm text-muted-foreground">
        Bundle your details, set a price. You approve every buyer.
      </p>

      {!loaded ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
      ) : (
        <ul className="mt-3 divide-y">
          {catalog.map((entry) => (
            <PacketRow
              key={entry.kind}
              rowKey={entry.kind}
              title={entry.title}
              packet={byKind.get(entry.kind)}
              kind={entry.kind}
              open={open === entry.kind}
              onToggle={() => setOpen(open === entry.kind ? null : entry.kind)}
              token={token}
              details={details}
              onSaved={load}
            />
          ))}
          {custom.map((packet) => (
            <PacketRow
              key={packet.id}
              rowKey={packet.id}
              title={packet.title}
              packet={packet}
              kind="custom"
              open={open === packet.id}
              onToggle={() => setOpen(open === packet.id ? null : packet.id)}
              token={token}
              details={details}
              onSaved={load}
            />
          ))}
          <PacketRow
            rowKey="new-custom"
            title="New custom packet"
            kind="custom"
            open={open === "new-custom"}
            onToggle={() => setOpen(open === "new-custom" ? null : "new-custom")}
            token={token}
            details={details}
            onSaved={async () => {
              setOpen(null);
              await load();
            }}
          />
        </ul>
      )}
    </section>
  );
}

function PacketRow(props: {
  rowKey: string;
  title: string;
  kind: string;
  packet?: PkmPacket;
  open: boolean;
  onToggle: () => void;
  token: string;
  details: PacketDetailOption[];
  onSaved: () => Promise<void> | void;
}) {
  const { packet, open, onToggle, token, details, kind, onSaved } = props;
  const isNewCustom = kind === "custom" && !packet;
  return (
    <li className="py-3">
      <button type="button" onClick={onToggle} className="flex w-full items-center justify-between gap-3 text-left" aria-expanded={open}>
        <span className="font-medium">{props.title}</span>
        <span className="shrink-0 text-sm text-muted-foreground">{isNewCustom ? "+" : statusLine(packet)}</span>
      </button>
      {open ? (
        <PacketEditor
          key={packet?.id ?? props.rowKey}
          kind={kind}
          packet={packet}
          token={token}
          details={details}
          askTitle={kind === "custom"}
          onSaved={onSaved}
        />
      ) : null}
    </li>
  );
}

function PacketEditor(props: {
  kind: string;
  packet?: PkmPacket;
  token: string;
  details: PacketDetailOption[];
  askTitle: boolean;
  onSaved: () => Promise<void> | void;
}) {
  const { packet, token, details, kind, askTitle, onSaved } = props;
  const keyOf = (d: PacketDetail) => `${d.domain}::${d.scopeHandle}`;
  const [title, setTitle] = useState(packet?.title ?? "");
  const [chosen, setChosen] = useState<Set<string>>(() => new Set((packet?.contents ?? []).map(keyOf)));
  const [price, setPrice] = useState(dollars(packet?.priceCents ?? null));
  const [credits, setCredits] = useState(packet?.creditCost == null ? "" : String(packet.creditCost));
  const [forSale, setForSale] = useState(packet?.forSale ?? false);
  const [busy, setBusy] = useState(false);

  const toggle = (k: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const save = async () => {
    const priceCents = price.trim() ? Math.round(Number(price) * 100) : null;
    const creditCost = credits.trim() ? Math.round(Number(credits)) : null;
    if ((priceCents != null && !Number.isFinite(priceCents)) || (creditCost != null && !Number.isFinite(creditCost))) {
      toast.error("Enter a number for the price and credits");
      return;
    }
    const contents = details
      .filter((d) => chosen.has(keyOf(d)))
      .map(({ domain, scopeHandle, label }) => ({ domain, scopeHandle, label }));
    const write = { contents, priceCents, creditCost, forSale, ...(askTitle ? { title: title.trim() } : {}) };
    setBusy(true);
    try {
      if (packet) await OneMarketplaceService.updatePacket({ vaultOwnerToken: token, packetId: packet.id, patch: write });
      else await OneMarketplaceService.createPacket({ vaultOwnerToken: token, packet: { kind, ...write } });
      toast.success("Saved");
      await onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't save this packet");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!packet) return;
    setBusy(true);
    try {
      await OneMarketplaceService.deletePacket({ vaultOwnerToken: token, packetId: packet.id });
      await onSaved();
    } catch {
      toast.error("Couldn't delete this packet");
    } finally {
      setBusy(false);
    }
  };

  const field = "h-10 w-full rounded-xl border bg-background px-3 text-sm";

  return (
    <div className="mt-3 space-y-4">
      {askTitle ? (
        <label className="block text-sm">
          <span className="text-muted-foreground">Name</span>
          <input className={`${field} mt-1`} value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />
        </label>
      ) : null}

      <fieldset>
        <legend className="text-sm text-muted-foreground">What's inside</legend>
        {details.length === 0 ? (
          <p className="mt-1 text-sm text-muted-foreground">Add to your Memory first, then pick details here.</p>
        ) : (
          <div className="mt-2 flex flex-wrap gap-2">
            {details.map((d) => {
              const k = keyOf(d);
              const on = chosen.has(k);
              return (
                <button
                  key={k}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(k)}
                  className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${on ? "border-foreground bg-foreground text-background" : "bg-background"}`}
                >
                  {d.label}
                </button>
              );
            })}
          </div>
        )}
      </fieldset>

      <div className="grid grid-cols-2 gap-3">
        <label className="block text-sm">
          <span className="text-muted-foreground">Price ($)</span>
          <input className={`${field} mt-1`} inputMode="decimal" placeholder="4.69" value={price} onChange={(e) => setPrice(e.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="text-muted-foreground">Credits</span>
          <input className={`${field} mt-1`} inputMode="numeric" placeholder="3" value={credits} onChange={(e) => setCredits(e.target.value)} />
        </label>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={forSale} onChange={(e) => setForSale(e.target.checked)} />
        For sale
      </label>

      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={busy} onClick={save}>
          Save
        </Button>
        {packet ? (
          <Button type="button" size="sm" variant="none" effect="fade" disabled={busy} onClick={remove}>
            Delete
          </Button>
        ) : null}
      </div>
    </div>
  );
}
