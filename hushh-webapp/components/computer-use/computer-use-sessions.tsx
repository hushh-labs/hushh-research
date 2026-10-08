"use client";

import { useId, useState } from "react";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import type { ComputerUseSessionOperation, ComputerUseSnapshot } from "@/lib/computer-use/contracts";
import type { ComputerUseTaskController } from "@/lib/computer-use/task-controller";

/** Explicit owner actions, and only for destinations approved on this task. */
export function ComputerUseSessions({ controller, snapshot, pending }: {
  controller: ComputerUseTaskController;
  snapshot: ComputerUseSnapshot;
  pending: boolean;
}) {
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [selectedOrigin, setOrigin] = useState("");
  const [account, setAccount] = useState("");
  const [forget, setForget] = useState(false);
  const origins = snapshot.approvedOrigins ?? [];
  const origin = origins.includes(selectedOrigin) ? selectedOrigin : origins[0] ?? "";

  function close(): void {
    setOpen(false);
    setAccount("");
    setForget(false);
  }

  function act(operation: ComputerUseSessionOperation): void {
    const work = controller.session(operation, origin, account.trim()).then((receipt) => {
      if (receipt.state === "forgotten" && (!receipt.fenced || !receipt.persisted)) {
        throw new Error("BROWSER_FORGET_INCOMPLETE");
      }
      if (receipt.state === "review_required") {
        // Keep only the owner's label in task memory for an explicit retry.
        // Confirmation never replays the session operation automatically.
        setOpen(false);
        setForget(false);
      } else close();
      return receipt;
    });
    morphyToast.promise(work, {
      loading: operation === "forget" ? "Forgetting this sign-in…" : "Checking sign-in authorization…",
      success: (receipt) => receipt.state === "review_required" ? "Review the sign-in request to continue."
        : receipt.state === "remembered" ? "Sign-in remembered."
          : receipt.state === "restored" ? "Stored sign-in loaded. The website may ask you to sign in again."
            : receipt.state === "not_found" ? "No stored sign-in found for that label."
              : "Sign-in access forgotten. Physical deletion follows your cloud’s retention.",
      error: operation === "forget" ? "Forget couldn’t be fully confirmed. Check again before relying on it."
        : "That sign-in change couldn’t be confirmed. Check the browser and try again.",
    });
    void work.catch(() => undefined);
  }

  return (
    <>
      <ShellActionSurface variant="pill" className="min-h-11" disabled={pending || !origin || Boolean(snapshot.review)}
        onClick={() => setOpen(true)}>Sign-in</ShellActionSurface>
      <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }} modal>
        <DialogContent>
          <DialogHeader className="pr-8 text-left">
            <DialogTitle>{forget ? "Forget this sign-in?" : "Website sign-in"}</DialogTitle>
            <DialogDescription>{forget
              ? "Closes this browser and removes stored sign-in access. Physical deletion follows your cloud’s retention; this does not sign you out of the website."
              : "Remember or reuse sign-in information for this website. Enter credentials in the browser while you’re in control."}</DialogDescription>
          </DialogHeader>
          {origins.length > 1 ? (
            <Select value={origin} onValueChange={setOrigin} disabled={pending || forget}>
              <SelectTrigger className="w-full" aria-label="Website"><SelectValue /></SelectTrigger>
              <SelectContent>{origins.map((site) => <SelectItem key={site} value={site}>{site}</SelectItem>)}</SelectContent>
            </Select>
          ) : <p className="break-all text-sm">{origin}</p>}
          <div className="space-y-[var(--app-form-field-gap)]">
            <label className="text-sm" htmlFor={inputId}>Sign-in label</label>
            <Input id={inputId} value={account} maxLength={256} autoComplete="off" disabled={pending || forget}
              placeholder="Personal" onChange={(event) => setAccount(event.target.value)} />
          </div>
          <DialogFooter className="flex-wrap">
            {forget ? (
              <>
                <ShellActionSurface variant="pill" className="min-h-11" disabled={pending} onClick={() => setForget(false)}>Back</ShellActionSurface>
                <ShellActionSurface variant="pill" className="min-h-11" disabled={pending} onClick={() => act("forget")}>Forget this site</ShellActionSurface>
              </>
            ) : (
              <>
                <ShellActionSurface variant="pill" className="min-h-11" disabled={pending || !account.trim()} onClick={() => setForget(true)}>Forget</ShellActionSurface>
                <ShellActionSurface variant="pill" className="min-h-11" disabled={pending || !account.trim()} onClick={() => act("restore")}>Use stored sign-in</ShellActionSurface>
                <ShellActionSurface variant="pill" className="min-h-11" disabled={pending || !account.trim()} onClick={() => act("remember")}>Remember this site</ShellActionSurface>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
