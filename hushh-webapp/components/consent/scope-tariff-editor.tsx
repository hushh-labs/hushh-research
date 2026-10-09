"use client";

import { useEffect, useState } from "react";
import { ProfileAccountLink } from "@/components/profile/profile-account-link";
import { useCommerceSession } from "@/components/consent/use-commerce-session";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { REQUEST_DURATION_OPTIONS } from "@/lib/agent/action-directive-summary";
import { ScopeCommerceService, parseCommerceDollarInput, formatCommerceMoney, commerceReadinessCopy, type CommerceReadiness } from "@/lib/services/scope-commerce-service";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

/** Tariffs belong to the exact authored scope handle, independently of its sharing switch. */
export function ScopeTariffEditor({ scopeHandle, machineScope, label, showSavedPrice = false }: { scopeHandle: string; machineScope: string; label: string; showSavedPrice?: boolean }) {
  const { user, capture } = useCommerceSession(`tariff:${scopeHandle}:${machineScope}`);
  const [open, setOpen] = useState(false);
  const [price, setPrice] = useState("0.00");
  const [hours, setHours] = useState("168");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [readiness, setReadiness] = useState<CommerceReadiness | undefined>();
  const [ready, setReady] = useState(false);
  const [savedTariff, setSavedTariff] = useState<{ price: number; hours: number } | null>(null);
  const [review, setReview] = useState<{ amount: number; hours: number; key: string } | null>(null);
  useEffect(() => {
    if ((!open && !showSavedPrice) || !user) return;
    let active = true;
    const sessionCurrent = capture();
    const current = () => active && sessionCurrent();
    setBusy(true); setMessage(null); setReadiness(undefined); setReady(false);
    void user.getIdToken().then(async token => {
      if (!current()) return;
      const [tariff, availability] = await Promise.allSettled([ScopeCommerceService.tariff(token, scopeHandle, machineScope), ScopeCommerceService.readiness(token)]);
      if (!current()) return;
      if (tariff.status !== "fulfilled") throw new Error("Sharing price could not be loaded. Refresh before saving.");
      setSavedTariff({ price: tariff.value?.price_cents ?? 0, hours: (tariff.value?.base_duration_seconds ?? 604800) / 3600 });
      setPrice(((tariff.value?.price_cents ?? 0) / 100).toFixed(2));
      setHours(String((tariff.value?.base_duration_seconds ?? 604800) / 3600));
      if (availability.status !== "fulfilled") throw new Error("Saved terms are shown. Sharing availability could not be checked; refresh before changing them.");
      setReadiness(availability.value);
      setReady(availability.value.capabilities.set_free_tariff || availability.value.capabilities.set_paid_tariff);
    }).catch(error => { if (current()) setMessage(error instanceof Error ? error.message : "Sharing price could not be loaded. Refresh before saving."); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; setReview(null); };
  }, [open, showSavedPrice, user, scopeHandle, machineScope, capture]);
  return <div className="min-w-0 space-y-2">
    <Button variant="ghost" size="sm" className="h-auto min-h-11 max-w-full whitespace-normal text-right" onClick={() => setOpen(value => !value)} aria-label={`Set sharing price for ${label}`}>{showSavedPrice ? savedTariff ? savedTariff.price === 0 ? "Free · Set price" : `${formatCommerceMoney(savedTariff.price)} / ${savedTariff.hours}h` : "Check sharing price" : "Sharing price"}</Button>
    <Dialog open={open} onOpenChange={value => { if (!review && !busy) setOpen(value); }}><DialogContent><DialogHeader><DialogTitle>Price for {label}</DialogTitle><DialogDescription>Set the price and base term for this exact sharing section.</DialogDescription></DialogHeader><div className="space-y-3">
      <label className="block space-y-2 text-sm">USD base price<Input inputMode="decimal" value={price} disabled={busy} onChange={event => setPrice(event.target.value)} /></label>
      <label className="block space-y-2 text-sm">Base access term
        <Select value={hours} onValueChange={setHours} disabled={busy}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{REQUEST_DURATION_OPTIONS.map(option => <SelectItem key={option.hours} value={String(option.hours)}>{option.label}</SelectItem>)}</SelectContent></Select>
      </label>
      <p className="text-xs text-muted-foreground">100 Hussh coins = $1.00. Enter your base price in USD above. Unset pricing is free and still requires your approval. Paid purchases start at 1 coin ($0.01). The server prorates your base price to the approved access term, up to 100,000 coins ($1,000). Processing costs reduce your earnings.</p>
      <p className="text-xs text-muted-foreground">{commerceReadinessCopy(readiness)}</p>
      {!readiness?.capabilities.set_paid_tariff ? <ProfileAccountLink className="inline-flex min-h-11 items-center text-sm underline">{readiness?.capabilities.start_onboarding ? "Set up payouts with Stripe in Account" : "Check payment availability in Account"}</ProfileAccountLink> : null}
      {message ? <p role="status" className="text-sm">{message}</p> : null}
      <Button disabled={busy || !ready} onClick={() => {
        try {
          const amount = parseCommerceDollarInput(price, 0);
          if (amount > 0 && !readiness?.capabilities.set_paid_tariff) throw new Error(commerceReadinessCopy(readiness));
          if (amount === 0 && !readiness?.capabilities.set_free_tariff) throw new Error("Free price controls are unavailable. Refresh before changing saved terms.");
          if (!REQUEST_DURATION_OPTIONS.some(option => option.hours === Number(hours))) throw new Error("Choose a base access term.");
          setReview({ amount, hours: Number(hours), key: crypto.randomUUID() });
        } catch (error) { setMessage(error instanceof Error ? error.message : "Check the price and term."); }
      }}>Review sharing price</Button>
    </div></DialogContent></Dialog>
    <AlertDialog open={Boolean(review)} onOpenChange={value => { if (!value && !busy) setReview(null); }}><AlertDialogContent><AlertDialogHeader>
      <AlertDialogTitle>{review?.amount === 0 ? "Confirm free sharing terms" : "Confirm sharing price"}</AlertDialogTitle>
      <AlertDialogDescription>{label}: {formatCommerceMoney(review?.amount ?? 0)} for {review?.hours} hours. Each requester still needs your approval. {review?.amount === 0 ? "Free sharing does not require payment setup. Existing paid agreements keep their accepted terms." : "Earlier revocation refunds unused paid time; you bear unrecovered processing fees."}</AlertDialogDescription>
    </AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={event => {
      event.preventDefault();
      if (!review || !user) return;
      const current = capture(); const currentView = capture(false); setBusy(true);
      void user.getIdToken().then(token => {
        if (!current()) throw new Error("Your account changed. Review again.");
        return ScopeCommerceService.saveTariff(token, { scope_handle: scopeHandle, machine_scope: machineScope, price_cents: review.amount, base_duration_seconds: review.hours * 3600 }, review.key);
      }).then(() => { if (current()) { setSavedTariff({ price: review.amount, hours: review.hours }); setReview(null); setMessage("Sharing terms saved."); } })
        .catch(error => { if (current()) setMessage(error instanceof Error ? error.message : "Terms could not be saved."); })
        .finally(() => { if (currentView()) setBusy(false); });
    }}>{review?.amount === 0 ? "Confirm free" : "Save price"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </div>;
}
