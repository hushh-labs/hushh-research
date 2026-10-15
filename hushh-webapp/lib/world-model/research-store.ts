import type {
  PwmPreferences,
  PwmResult,
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
  /** Restarts the reader; pass the switches a preference write just confirmed. */
  reload: (confirmed?: PwmPreferences) => void;
  refresh: () => void;
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
};

type Actions = Pick<WorldModelResearchState, "reload" | "refresh">;

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

const UNMOUNTED: WorldModelResearchState = Object.freeze({
  mounted: false,
  result: null,
  preferences: null,
  failed: false,
  reload,
  refresh,
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
        reload,
        refresh,
      }
    : UNMOUNTED;
  if (
    next.mounted === published.mounted &&
    next.result === published.result &&
    next.preferences === published.preferences &&
    next.failed === published.failed
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
