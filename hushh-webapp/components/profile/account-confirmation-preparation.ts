/** Confirmation admission only. Authentication, reset and erasure remain with
 * their existing operation owners. No account identifier or credential lives
 * in this process-local visit fence. */
export class AccountConfirmationPreparation {
  private generation = 0;

  invalidate(): void { this.generation += 1; }

  async request(port: {
    hasVault: boolean | null;
    ownerIsCurrent: () => boolean;
    checkVault: () => Promise<boolean>;
    vaultKnown: (hasVault: boolean) => void;
    canMutate: () => boolean;
    confirm: () => void;
    unlock: () => void;
  }): Promise<void> {
    const generation = ++this.generation;
    const current = () => generation === this.generation && port.ownerIsCurrent();
    if (!current()) return;
    let hasVault = port.hasVault;
    if (hasVault === null) {
      try { hasVault = await port.checkVault(); }
      catch { hasVault = true; } // Never infer a vaultless account from a failed probe.
    }
    if (!current()) return;
    port.vaultKnown(hasVault);
    if (!hasVault || port.canMutate()) port.confirm();
    else port.unlock();
  }
}
