import { describe, expect, it } from "vitest";

import { NativeAuthRestoreEpoch } from "@/lib/firebase/native-auth-restore-epoch";

describe("NativeAuthRestoreEpoch", () => {
  it("rejects a launch restore after a newer Apple-auth operation", () => {
    const epochs = new NativeAuthRestoreEpoch();
    const launchRestore = epochs.begin();
    const appleSignIn = epochs.begin();

    expect(epochs.isCurrent(launchRestore)).toBe(false);
    expect(epochs.isCurrent(appleSignIn)).toBe(true);
  });

  it("rejects a pending restore after sign-out invalidates it", () => {
    const epochs = new NativeAuthRestoreEpoch();
    const pendingRestore = epochs.begin();

    epochs.invalidate();

    expect(epochs.isCurrent(pendingRestore)).toBe(false);
  });
});
