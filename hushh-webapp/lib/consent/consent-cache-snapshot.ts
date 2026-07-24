type ConsentCacheSnapshotMutation = {
  id: string;
  type: string;
  createdAt: number;
  payload?: unknown;
};

type ConsentCacheSnapshot = {
  id: string;
  createdAt: number;
  reason: string;
  mutationCount: number;
  mutations: ConsentCacheSnapshotMutation[];
};

const pendingMutations: ConsentCacheSnapshotMutation[] = [];

function createSnapshotId() {
  return `consent-snapshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function queueConsentCacheSnapshotMutation({
  id,
  type,
  payload,
}: {
  id: string;
  type: string;
  payload?: unknown;
}) {
  pendingMutations.push({
    id,
    type,
    payload,
    createdAt: Date.now(),
  });
}

export function getPendingConsentCacheSnapshotMutationCount() {
  return pendingMutations.length;
}

export function createConsentCacheSnapshot(reason = "manual-flush"): ConsentCacheSnapshot {
  const mutations = [...pendingMutations];

  return {
    id: createSnapshotId(),
    createdAt: Date.now(),
    reason,
    mutationCount: mutations.length,
    mutations,
  };
}

export function flushConsentCacheSnapshot(reason = "manual-flush"): ConsentCacheSnapshot {
  const snapshot = createConsentCacheSnapshot(reason);

  pendingMutations.length = 0;

  return snapshot;
}

export function resetConsentCacheSnapshotQueue() {
  pendingMutations.length = 0;
}