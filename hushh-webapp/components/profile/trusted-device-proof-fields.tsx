"use client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { TrustedDevicesModel } from "./use-trusted-devices-model";

export function TrustedDeviceProofFields({ model }: { model: TrustedDevicesModel }) {
  const proof = model.proof;
  const view = proof.view;
  return <div className="space-y-3">
    <div id="trusted-device-revoke-recaptcha" />
    <p className="text-sm text-muted-foreground">Verify your linked phone{view?.phoneHint ? ` (${view.phoneHint})` : ""} for this device.</p>
    {view?.preparing ? <p role="status">Preparing verification…</p> : null}
    {view?.transport === "sms" ? <Button type="button" variant="outline" disabled={model.busy || view.sending || !view.resendReady}
      onClick={() => void proof.send()}>{view.sending ? "Sending…" : view.codeSent ? "Send another code" : "Send code"}</Button> : null}
    {view?.codeSent && !view.resendReady ? <p className="text-sm text-muted-foreground">Wait 30 seconds before resending.</p> : null}
    {view?.codeSent ? <Input aria-label="Device verification code" autoComplete="one-time-code" inputMode="numeric"
      maxLength={6} value={proof.code} disabled={model.busy} onChange={event => proof.setCode(event.target.value.replace(/\D/g, ""))} /> : null}
    {view?.error ? <p role="alert" className="text-sm text-destructive">{view.error}</p> : null}
  </div>;
}
