import type {
  PwmPreferences,
  PwmProgress,
  PwmResult,
  PwmValidatedFact,
} from "@/lib/services/world-model-research-service";

/**
 * What every Personal World Model surface reads. One writer (the app-level
 * WorldModelProvider) prepares and resumes research and publishes here; any
 * reader, including the Profile pane that is mounted beside that provider
 * rather than inside it, subscribes. A module store, not a React context, so
 * where a surface sits in the tree never decides whether it sees the model.
 */
export type WorldModelResearchState = {
  /** False when no app-level provider is mounted. */
  mounted: boolean;
  result: PwmResult | null;
  preferences: PwmPreferences | null;
  failed: boolean;
  /** True after a manual retry, until the next research status arrives. */
  retrying: boolean;
  /** Last progress update; kept as a checkpoint after an unavailable result. */
  progress: PwmProgress | null;
  /** Cited but unapproved findings from this research run. */
  validatedFacts: readonly PwmValidatedFact[];
  /** True while a stream or poll is actively receiving. */
  live: boolean;
  /** When the last progress or result arrived, as Date.now(). */
  lastActivityAt: number | null;
  /**
   * When research will be tried again on its own, as Date.now(), after a
   * result said it is unavailable for a while; null for every other result.
   */
  retryAt: number | null;
  /** Restarts the reader; pass the switches a preference write just confirmed. */
  reload: (confirmed?: PwmPreferences) => void;
  refresh: () => void;
  researchPublicProfiles: (publicProfileUrls: readonly string[]) => void;
};

/** The owner, vault key and token a published value belongs to. */
export type WorldModelResearchAuthority = {
  owner: string;
  key: string;
  token: string;
};

export type WorldModelResearchSnapshot = WorldModelResearchAuthority & {
  result: PwmResult | null;
  preferences: PwmPreferences | null;
  failed: boolean;
  retrying: boolean;
  progress: PwmProgress | null;
  validatedFacts: readonly PwmValidatedFact[];
  live: boolean;
  lastActivityAt: number | null;
  retryAt: number | null;
};

type Actions = Pick<WorldModelResearchState, "reload" | "refresh" | "researchPublicProfiles">;

const sameAuthority = (
  a: WorldModelResearchAuthority | null,
  b: WorldModelResearchAuthority | null,
) => !!a && !!b && a.owner === b.owner && a.key === b.key && a.token === b.token;

let writer: symbol | null = null;
let actions: Actions | null = null;
let authority: WorldModelResearchAuthority | null = null;
let snapshot: WorldModelResearchSnapshot | null = null;
const listeners = new Set<() => void>();

// Stable for the store's life, so readers never re-render for new functions.
const reload = (confirmed?: PwmPreferences) => actions?.reload(confirmed);
const refresh = () => actions?.refresh();
const researchPublicProfiles = (urls: readonly string[]) => actions?.researchPublicProfiles(urls);

const UNMOUNTED: WorldModelResearchState = Object.freeze({
  mounted: false,
  result: null,
  preferences: null,
  failed: false,
  retrying: false,
  progress: null,
  validatedFacts: [],
  live: false,
  lastActivityAt: null,
  retryAt: null,
  reload,
  refresh,
  researchPublicProfiles,
});

let published: WorldModelResearchState = UNMOUNTED;

function publish() {
  // A value is shown only to the owner, key and token it was read for.
  const valid = sameAuthority(snapshot, authority);
  const next: WorldModelResearchState = writer
    ? {
        mounted: true,
        result: valid ? snapshot!.result : null,
        preferences: valid ? snapshot!.preferences : null,
        failed: valid ? snapshot!.failed : false,
        retrying: valid ? snapshot!.retrying : false,
        progress: valid ? snapshot!.progress : null,
        validatedFacts: valid ? snapshot!.validatedFacts : UNMOUNTED.validatedFacts,
        live: valid ? snapshot!.live : false,
        lastActivityAt: valid ? snapshot!.lastActivityAt : null,
        retryAt: valid ? snapshot!.retryAt : null,
        reload,
        refresh,
        researchPublicProfiles,
      }
    : UNMOUNTED;
  if (
    next.mounted === published.mounted &&
    next.result === published.result &&
    next.preferences === published.preferences &&
    next.failed === published.failed &&
    next.retrying === published.retrying &&
    next.progress === published.progress &&
    next.validatedFacts === published.validatedFacts &&
    next.live === published.live &&
    next.lastActivityAt === published.lastActivityAt &&
    next.retryAt === published.retryAt
  )
    return;
  published = next;
  listeners.forEach((listener) => listener());
}

export const worldModelResearchStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot: (): WorldModelResearchState => published,
  /** A sibling can render before the provider's layout effect updates its
   * authority. Never admit the previous owner's snapshot into that frame. */
  getSnapshotFor: (expected: WorldModelResearchAuthority | null): WorldModelResearchState =>
    sameAuthority(expected, authority) ? published : UNMOUNTED,
  getServerSnapshot: (): WorldModelResearchState => UNMOUNTED,

  /**
   * Makes the caller the single writer. Returns a writer handle; writes from
   * any other handle are ignored. Detaching clears everything it published.
   */
  attach(nextActions: Actions) {
    const handle = Symbol("world-model-research-writer");
    writer = handle;
    actions = nextActions;
    authority = null;
    snapshot = null;
    publish();
    return {
      /** The owner whose vault is open now, or null while it is not. */
      setAuthority(next: WorldModelResearchAuthority | null) {
        if (writer !== handle) return;
        authority = next;
        publish();
      },
      setSnapshot(
        update: (
          previous: WorldModelResearchSnapshot | null,
        ) => WorldModelResearchSnapshot | null,
      ) {
        if (writer !== handle) return;
        snapshot = update(snapshot);
        publish();
      },
      detach() {
        if (writer !== handle) return;
        writer = null;
        actions = null;
        authority = null;
        snapshot = null;
        publish();
      },
    };
  },
};

export type WorldModelResearchWriter = ReturnType<
  typeof worldModelResearchStore.attach
>;
