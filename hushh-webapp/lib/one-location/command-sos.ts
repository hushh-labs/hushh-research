/** Synchronous exclusion while an SOS starts/stops, before React paints busy.
 * Owner changes invalidate the old lease; late cleanup cannot release a new one. */
export class OwnerOperationGate {
  private owner: string | null = null;
  private lease: symbol | null = null;
  begin(owner: string): symbol | null {
    if (this.owner !== owner) {
      this.owner = owner;
      this.lease = null;
    }
    if (this.lease) return null;
    return (this.lease = Symbol("sos-operation"));
  }
  finish(owner: string, lease: symbol): boolean {
    if (this.owner !== owner || this.lease !== lease) return false;
    this.lease = null;
    return true;
  }
}

/** Stop only this incident's shares. A failed/lost response remains unresolved;
 * it never removes the incident or claims that a live grant was revoked. */
export async function stopSosShares(input: {
  grantIds: readonly string[];
  signal?: AbortSignal;
  revoke(id: string): Promise<{ id: string; status: string }>;
}) {
  const revoked: string[] = [];
  const unresolved: string[] = [];
  for (const id of new Set(input.grantIds)) {
    if (input.signal?.aborted) {
      unresolved.push(id);
      continue;
    }
    try {
      const grant = await input.revoke(id);
      if (grant.id === id && ["revoked", "expired"].includes(grant.status))
        revoked.push(id);
      else unresolved.push(id);
    } catch {
      unresolved.push(id);
    }
  }
  return { revoked, unresolved };
}

// Compatibility name for the SOS owner.
export { OwnerOperationGate as SosOperationGate };
