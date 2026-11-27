import { useSyncExternalStore } from "react";

let generation = 0;
let applying = false;
const listeners = new Set<() => void>();
export const interfacePresentationSnapshot = () => applying ? -1 : generation;
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function setInterfaceApplying(value: boolean) {
  applying = value;
  if (!value) generation++;
  listeners.forEach(listener => listener());
}
/** Only presentation consumers subscribe. Route and vault state keep their lifetimes. */
export function useInterfaceRevision() {
  return useSyncExternalStore(subscribe, interfacePresentationSnapshot, () => 0);
}
