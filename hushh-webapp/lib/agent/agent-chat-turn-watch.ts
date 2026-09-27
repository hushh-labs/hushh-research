"use client";

// One chat turns keep running on the server after the app stops listening:
// the person switches to another screen, or the native app goes to the
// background. The server seals the answer into history either way. This store
// tracks those turns so the app can reattach, and tells the app shell when one
// settles so it can say so.
//
// Memory only, and identifiers only: an owner id, a conversation id and a time.
// Never message text, a token, a vault key or a chat key.

/** Abort reason for a stream the app stops reading while the turn continues. */
export const AGENT_TURN_DETACH_REASON = "hussh:agent-turn-detached";

/** The server's bound on a detached turn (its chat key's 300 s ceiling), plus a margin. */
export const AGENT_TURN_WATCH_WINDOW_MS = 310_000;

const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;

export function isAgentConversationId(value: unknown): value is string {
  return typeof value === "string" && CONVERSATION_ID.test(value);
}

type AttachedTurn = {
  ownerId: string;
  conversationId: string;
  detach: () => void;
};

export type WatchedAgentTurn = {
  ownerId: string;
  conversationId: string;
  startedAtMs: number;
  /** The app was in the background after the turn detached: the server's push owns the notice. */
  backgroundedSinceDetach: boolean;
};

export type AgentTurnSettled = WatchedAgentTurn & { answered: boolean };

const attached = new Set<AttachedTurn>();
// A native-background detach registers its watch only after the stream has
// wound down, so the background state lives here for new watches to inherit.
let appBackgrounded = false;
const watched = new Map<string, WatchedAgentTurn>();
const watchListeners = new Set<() => void>();
const settledListeners = new Set<(turn: AgentTurnSettled) => void>();
const openListeners = new Set<(request: { ownerId: string; conversationId: string }) => void>();

const keyOf = (ownerId: string, conversationId: string) => `${ownerId}\u0000${conversationId}`;

function emitWatchChange(): void {
  for (const listener of watchListeners) listener();
}

/** A stream that is reading a turn right now. Returns its unregister function. */
export function registerAttachedAgentTurn(turn: AttachedTurn): () => void {
  attached.add(turn);
  return () => {
    attached.delete(turn);
  };
}

/**
 * Stop reading every in-flight turn without cancelling it on the server. Used
 * when the native app goes to the background: a closed stream is what tells
 * the server nobody saw the answer, so it sends the push when the turn ends.
 */
export function detachAttachedAgentTurns(): number {
  const turns = [...attached];
  for (const turn of turns) turn.detach();
  return turns.length;
}

export function watchDetachedAgentTurn(turn: {
  ownerId: string;
  conversationId: string;
  startedAtMs: number;
  backgrounded?: boolean;
}): void {
  if (!turn.ownerId || !isAgentConversationId(turn.conversationId)) return;
  watched.set(keyOf(turn.ownerId, turn.conversationId), {
    ownerId: turn.ownerId,
    conversationId: turn.conversationId,
    startedAtMs: turn.startedAtMs,
    backgroundedSinceDetach: turn.backgrounded === true || appBackgrounded,
  });
  emitWatchChange();
}

export function listWatchedAgentTurns(): WatchedAgentTurn[] {
  return [...watched.values()];
}

export function isAgentTurnWatched(ownerId: string | null | undefined, conversationId: string | null | undefined): boolean {
  return Boolean(ownerId && conversationId && watched.has(keyOf(ownerId, conversationId)));
}

export function setAgentTurnAppBackgrounded(backgrounded: boolean): void {
  appBackgrounded = backgrounded;
  if (!backgrounded) return;
  for (const turn of watched.values()) turn.backgroundedSinceDetach = true;
}

/**
 * The turn was seen still running while the app is in the foreground, so it
 * will settle where a push shows no banner: the in-app notice owns it again.
 */
export function markWatchedAgentTurnForeground(ownerId: string, conversationId: string): void {
  if (appBackgrounded) return;
  const turn = watched.get(keyOf(ownerId, conversationId));
  if (turn) turn.backgroundedSinceDetach = false;
}

export function settleWatchedAgentTurn(ownerId: string, conversationId: string, answered: boolean): void {
  const key = keyOf(ownerId, conversationId);
  const turn = watched.get(key);
  if (!turn) return;
  watched.delete(key);
  emitWatchChange();
  for (const listener of settledListeners) listener({ ...turn, answered });
}

/** Drop watches for anyone but ``ownerId`` (sign-out, account switch), or all. */
export function clearWatchedAgentTurns(keepOwnerId?: string | null): void {
  let changed = false;
  for (const [key, turn] of watched) {
    if (keepOwnerId && turn.ownerId === keepOwnerId) continue;
    watched.delete(key);
    changed = true;
  }
  if (changed) emitWatchChange();
}

export function subscribeWatchedAgentTurns(listener: () => void): () => void {
  watchListeners.add(listener);
  return () => {
    watchListeners.delete(listener);
  };
}

export function subscribeAgentTurnSettled(listener: (turn: AgentTurnSettled) => void): () => void {
  settledListeners.add(listener);
  return () => {
    settledListeners.delete(listener);
  };
}

/**
 * Resolves once no watched turn is running in this conversation (it settled, or
 * its watch was cleared). A new prompt waits on this so two runs never share a
 * conversation at once.
 */
export function waitForWatchedAgentTurn(
  ownerId: string | null | undefined,
  conversationId: string | null | undefined,
): Promise<void> {
  if (!isAgentTurnWatched(ownerId, conversationId)) return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (isAgentTurnWatched(ownerId, conversationId)) return;
      unsubscribeWatch();
      resolve();
    };
    const unsubscribeWatch = subscribeWatchedAgentTurns(check);
  });
}

/** Ask the mounted chat to open a conversation (a notice's Open, a push tap). */
export function requestOpenAgentConversation(ownerId: string, conversationId: string): void {
  if (!ownerId || !isAgentConversationId(conversationId)) return;
  for (const listener of openListeners) listener({ ownerId, conversationId });
}

export function subscribeOpenAgentConversation(
  listener: (request: { ownerId: string; conversationId: string }) => void,
): () => void {
  openListeners.add(listener);
  return () => {
    openListeners.delete(listener);
  };
}

export type AgentTurnNotice = "none" | "toast" | "defer";

/**
 * How the app says a detached turn settled. The person looking at that chat
 * already sees the answer; a turn that settled while the native app was in the
 * background was announced by the server's push; a hidden browser tab waits
 * until it is visible again and then decides.
 */
export function decideAgentTurnNotice(input: {
  viewingConversation: boolean;
  pageVisible: boolean;
  pushOwnsNotice: boolean;
}): AgentTurnNotice {
  if (input.pushOwnsNotice) return "none";
  if (!input.pageVisible) return "defer";
  return input.viewingConversation ? "none" : "toast";
}
