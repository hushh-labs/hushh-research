"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { WalletService, type WalletBankChoice, type WalletNetworkContext } from "@/lib/services/wallet-service";
import type { WalletArtworkVariant, WalletCardArtwork } from "@/lib/wallet/card-artwork";
import type { CardBrand } from "@/lib/wallet/card-validation";
import { TYPOGRAPHY_CLASSNAMES } from "@/components/app-ui/typography";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { WalletCardArtworkTile } from "./wallet-card-artwork-tile";

export function WalletBankDesignPicker({ context, network, country, active, draftRevision, onChange, onModeChange, suggest, hasPhoto }: {
  context: WalletNetworkContext | null; network: CardBrand; country?: string; active: boolean; draftRevision: number;
  onChange: (value: WalletCardArtwork) => void; onModeChange: (enabled: boolean) => void;
  suggest?: (variants: readonly WalletArtworkVariant[], signal: AbortSignal) => Promise<WalletArtworkVariant | null>;
  hasPhoto?: boolean;
}) {
  const id = useId(), { userId, vaultOwnerToken } = context ?? {};
  const [banks, setBanks] = useState<WalletBankChoice[]>([]), [bankKey, setBankKey] = useState("");
  const [designs, setDesigns] = useState<WalletArtworkVariant[]>([]), [version, setVersion] = useState("");
  const [notice, setNotice] = useState(""), [selected, setSelected] = useState("");
  const operation = useRef<AbortController | null>(null), manual = useRef(false);
  const chosen = useRef<WalletArtworkVariant | null>(null);
  const handlers = useRef({ onChange, suggest }); handlers.current = { onChange, suggest };
  useLayoutEffect(() => { manual.current = false; chosen.current = null; operation.current?.abort(); setSelected(""); }, [draftRevision]);
  useEffect(() => {
    if (!active || !userId || !vaultOwnerToken) return;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
    void Promise.resolve().then(() => WalletService.bankArtwork({ userId, vaultOwnerToken }, { network, ...(country ? { country } : {}) }, controller.signal))
      .then(reply => { if (!controller.signal.aborted) setBanks(reply.banks); }).catch(() => { if (!controller.signal.aborted) setBanks([]); })
      .finally(() => clearTimeout(timer));
    return () => { controller.abort(); clearTimeout(timer); };
  }, [active, userId, vaultOwnerToken, network, country]);
  useEffect(() => {
    if (!active || !userId || !vaultOwnerToken || !bankKey || (manual.current && !chosen.current)) return;
    const restore = chosen.current;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 8000);
    operation.current?.abort(); operation.current = controller; setNotice("Finding a bank design…");
    void (async () => {
      const variants: WalletArtworkVariant[] = []; let offset: number | null = 0, catalogVersion = "";
      do {
        const reply = await WalletService.bankArtwork({ userId, vaultOwnerToken }, { network, ...(country ? { country } : {}), bankKey, offset }, controller.signal);
        if (catalogVersion && catalogVersion !== reply.catalogVersion) throw new Error("Catalog changed.");
        catalogVersion = reply.catalogVersion; variants.push(...reply.variants); offset = reply.nextOffset;
        if (variants.length > 256) throw new Error("Bank collection is too large.");
      } while (offset !== null);
      if (controller.signal.aborted) return;
      setDesigns(variants); setVersion(catalogVersion);
      const choice = restore ? variants.find(row => row.assetId === restore.assetId && row.digest === restore.digest && row.issuerId === restore.issuerId && row.productId === restore.productId && row.variantId === restore.variantId) : handlers.current.suggest ? await handlers.current.suggest(variants, controller.signal) : variants[0];
      if (controller.signal.aborted) return;
      if (!choice) throw new Error("Design unavailable.");
      const artwork = await WalletService.selectCardArtwork({ userId, vaultOwnerToken }, choice, catalogVersion, controller.signal);
      if (!controller.signal.aborted && (!manual.current || restore)) { handlers.current.onChange(artwork); chosen.current = { ...choice }; setSelected(choice.assetId); setNotice(restore ? "Bank design selected." : "Suggested bank design. You can choose another."); }
    })().catch(() => { if (!controller.signal.aborted) { handlers.current.onChange({ source: "neutral", version: 1 }); setSelected(""); setNotice("Bank design unavailable. You can still add your card."); } })
      .finally(() => { clearTimeout(timer); if (operation.current === controller && controller.signal.aborted) setNotice(""); });
    return () => { controller.abort(); clearTimeout(timer); };
  }, [active, userId, vaultOwnerToken, network, country, bankKey, draftRevision]);
  useEffect(() => () => operation.current?.abort(), [active, userId, vaultOwnerToken, network, country]);
  const choose = async (variant: WalletArtworkVariant) => {
    if (!context || !active) return;
    manual.current = true; operation.current?.abort(); const controller = new AbortController(); operation.current = controller;
    const timer = setTimeout(() => controller.abort(), 8000);
    try { const artwork = await WalletService.selectCardArtwork(context, variant, version, controller.signal); if (!controller.signal.aborted) { handlers.current.onChange(artwork); chosen.current = { ...variant }; setSelected(variant.assetId); setNotice("Bank design selected."); } }
    catch { if (!controller.signal.aborted) setNotice("This design is unavailable. Try another."); }
    finally { clearTimeout(timer); }
  };
  if (!active || !banks.length) return null;
  return <section aria-label="Bank card design" className="flex flex-col gap-3">
    <Label htmlFor={id}>Bank (optional)</Label>
    <Select value={bankKey || "none"} onValueChange={value => {
      operation.current?.abort(); manual.current = false; chosen.current = null; setDesigns([]); setSelected("");
      setBankKey(value === "none" ? "" : value); onModeChange(value !== "none"); handlers.current.onChange({ source: "neutral", version: 1 });
    }}><SelectTrigger id={id} className="min-h-11 rounded-full"><SelectValue placeholder="Choose your bank" /></SelectTrigger>
      <SelectContent><SelectItem value="none">Choose your bank</SelectItem>{banks.map(bank => <SelectItem key={bank.bankKey} value={bank.bankKey}>{bank.name} · {bank.country}</SelectItem>)}</SelectContent>
    </Select>
    {bankKey ? <><p className={TYPOGRAPHY_CLASSNAMES.helperText}>Adapted bank artwork. It may differ from your physical card.</p>
      <div className="flex snap-x gap-3 overflow-x-auto p-1" aria-label="Bank designs">{context ? designs.map(variant => <WalletCardArtworkTile key={variant.assetId} context={context} variant={variant} catalogVersion={version} selected={selected === variant.assetId} onSelect={() => void choose(variant)} />) : null}</div>
      {hasPhoto ? <Button type="button" size="compact" variant="ghost" onClick={() => { operation.current?.abort(); manual.current = false; chosen.current = null; setBankKey(""); setSelected(""); setDesigns([]); onModeChange(false); handlers.current.onChange({ source: "neutral", version: 1 }); }}>Use your card photo</Button> : null}
    </> : null}
    {notice ? <p role="status" className={TYPOGRAPHY_CLASSNAMES.helperText}>{notice}</p> : null}
  </section>;
}
