/** Owner-only, memory-only diagnostics. Never a read or consent authority. */
export type PublicationState = "current" | "source_changed" | "unavailable";
const states = new Map<string, Map<string, PublicationState>>();
const listeners = new Set<() => void>();
let revision = 0;
const changed = () => { revision++; listeners.forEach(listener => listener()); };
export const subscribeFinancePublication = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const financePublicationRevision = () => revision;
export function financePublicationState(owner: string, grant: string) { return states.get(owner)?.get(grant); }
export function setFinancePublicationState(owner: string, grant: string, state: PublicationState) {
  const values = states.get(owner) ?? new Map<string, PublicationState>();
  if (values.get(grant) === state) return;
  values.set(grant, state); states.set(owner, values); changed();
}
export function clearFinancePublication(owner: string) { if (states.delete(owner)) changed(); }
