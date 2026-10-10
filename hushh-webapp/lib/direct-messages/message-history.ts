/** Only server-encrypted navigation tokens belong in browser history. */
const KEY = "directMessageSelection";
const EVENT = "direct-message-selection-change";
export function readMessageHistory(): string {
  const selection = window.history.state?.[KEY];
  return window.location.pathname.replace(/\/+$/, "") === "/one/messages" &&
    typeof selection?.owner === "string" && typeof selection?.token === "string"
    ? JSON.stringify({ owner: selection.owner, token: selection.token }) : "";
}
export function subscribeMessageHistory(listener: () => void): () => void {
  window.addEventListener("popstate", listener);
  window.addEventListener(EVENT, listener);
  return () => {
    window.removeEventListener("popstate", listener);
    window.removeEventListener(EVENT, listener);
  };
}
export function replaceMessageHistory(selection: { owner: string; token: string } | null): void {
  const state = { ...window.history.state, [KEY]: selection };
  // Let Next's supported History API patch update its canonical URL/tree.
  delete state.__NA;
  delete state._N;
  window.history.replaceState(state, "", "/one/messages");
  window.dispatchEvent(new Event(EVENT));
}
