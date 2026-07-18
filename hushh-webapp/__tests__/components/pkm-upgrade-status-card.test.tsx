import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PkmUpgradeStatusCard } from "@/components/profile/pkm-upgrade-status-card";
import type { PkmUpgradeStatus } from "@/lib/services/pkm-upgrade-service";

const failedStatus: PkmUpgradeStatus = {
  userId: "user-1",
  modelVersion: 1,
  storedModelVersion: 1,
  effectiveModelVersion: 1,
  targetModelVersion: 2,
  currentPkmContractVersion: "1",
  targetPkmContractVersion: "2",
  currentReadableProjectionVersion: "1",
  targetReadableProjectionVersion: "2",
  upgradeStatus: "failed",
  upgradableDomains: [],
  lastUpgradedAt: null,
  run: {
    runId: "run-1",
    userId: "user-1",
    status: "failed",
    mode: "real",
    fromModelVersion: 1,
    toModelVersion: 2,
    currentDomain: null,
    initiatedBy: "unlock_warm",
    resumeCount: 0,
    startedAt: null,
    lastCheckpointAt: null,
    completedAt: null,
    lastError: "Upgrade paused",
    errorContext: null,
    createdAt: null,
    updatedAt: null,
    steps: [],
  },
};

describe("PkmUpgradeStatusCard", () => {
  it("renders retry update action with button type", () => {
    render(
      <PkmUpgradeStatusCard
        status={failedStatus}
        showRecoveryAction
        vaultUnlocked
        onResume={vi.fn()}
      />
    );

    expect(
      screen.getByRole("button", { name: /retry update/i }).getAttribute("type")
    ).toBe("button");
  });
});
