export type HostedUmbrellaCellSummary = {
  cellId: string;
  provider: string;
  organization: string;
  activeSlots: number;
  warmStandbySlots: number;
  minWarmSkeletons: number;
  maxWarmSkeletons: number;
  softWatermark: number;
  hardWatermark: number;
  admitsNewOwners: boolean;
  needsReplenishment: boolean;
  costGuardHealthy: boolean;
  idleComputeHourlyUsdPerWarmSlot: number;
};

export type HostedUmbrellaCellsStatus = {
  environment: string;
  cells: HostedUmbrellaCellSummary[];
  totalAzureWarmSlots: number;
  azureWarmReady: boolean;
};

export type HostedAzureCutoverState = {
  relayReady: boolean;
  directReady: boolean;
  ingress: string;
  mode: string;
};

export type HostedAzureMigrationJobSummary = {
  jobId: string | null;
  status: string;
  stage: string | null;
  errorMessage: string | null;
  targetProject: string | null;
  targetRegion: string | null;
};

export type HostedAzureMigrationStatus = {
  job: HostedAzureMigrationJobSummary | null;
  deploymentTarget: string | null;
  registryStatus: string | null;
  cutover: HostedAzureCutoverState;
  cellPool: HostedUmbrellaCellsStatus;
};

export type HostedAzureMigrationResult = {
  jobId: string;
  status: string;
  cellId: string | null;
  slotId: string | null;
  claimLatencyMs: number | null;
  migrationMode: string;
  directPromoted: boolean;
  cutover: HostedAzureCutoverState;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function parseHostedUmbrellaCellsStatus(payload: unknown): HostedUmbrellaCellsStatus {
  if (!isRecord(payload)) {
    return { environment: "", cells: [], totalAzureWarmSlots: 0, azureWarmReady: false };
  }
  const rawCells = Array.isArray(payload.cells) ? payload.cells : [];
  const cells: HostedUmbrellaCellSummary[] = [];
  for (const item of rawCells) {
    if (!isRecord(item)) continue;
    const economics = isRecord(item.costEconomics) ? item.costEconomics : {};
    cells.push({
      cellId: asString(item.cellId),
      provider: asString(item.provider),
      organization: asString(item.organization),
      activeSlots: asNumber(item.activeSlots),
      warmStandbySlots: asNumber(item.warmStandbySlots),
      minWarmSkeletons: asNumber(item.minWarmSkeletons),
      maxWarmSkeletons: asNumber(item.maxWarmSkeletons),
      softWatermark: asNumber(item.softWatermark),
      hardWatermark: asNumber(item.hardWatermark),
      admitsNewOwners: item.admitsNewOwners === true,
      needsReplenishment: item.needsReplenishment === true,
      costGuardHealthy: economics.costGuardHealthy !== false,
      idleComputeHourlyUsdPerWarmSlot: asNumber(economics.idleComputeHourlyUsdPerWarmSlot),
    });
  }
  const azureCells = cells.filter((cell) => cell.provider === "azure");
  const totalAzureWarmSlots = azureCells.reduce(
    (sum, cell) => sum + (cell.admitsNewOwners ? Math.max(0, cell.warmStandbySlots) : 0),
    0,
  );
  return {
    environment: asString(payload.environment),
    cells,
    totalAzureWarmSlots,
    azureWarmReady: totalAzureWarmSlots > 0,
  };
}

function parseCutoverState(payload: unknown): HostedAzureCutoverState {
  if (!isRecord(payload)) {
    return { relayReady: false, directReady: false, ingress: "", mode: "pending" };
  }
  return {
    relayReady: payload.relayReady === true,
    directReady: payload.directReady === true,
    ingress: asString(payload.ingress),
    mode: asString(payload.mode, "pending"),
  };
}

function parseJobSummary(payload: unknown): HostedAzureMigrationJobSummary | null {
  if (!isRecord(payload)) return null;
  const status = asString(payload.status);
  if (!status) return null;
  return {
    jobId: typeof payload.job_id === "string" ? payload.job_id : typeof payload.jobId === "string" ? payload.jobId : null,
    status,
    stage: typeof payload.stage === "string" ? payload.stage : null,
    errorMessage:
      typeof payload.error_message === "string"
        ? payload.error_message
        : typeof payload.errorMessage === "string"
          ? payload.errorMessage
          : null,
    targetProject:
      typeof payload.target_project === "string"
        ? payload.target_project
        : typeof payload.targetProject === "string"
          ? payload.targetProject
          : null,
    targetRegion:
      typeof payload.target_region === "string"
        ? payload.target_region
        : typeof payload.targetRegion === "string"
          ? payload.targetRegion
          : null,
  };
}

export function parseHostedAzureMigrationStatus(payload: unknown): HostedAzureMigrationStatus {
  if (!isRecord(payload)) {
    throw new Error("HOSTED_MIGRATION_STATUS_UNAVAILABLE");
  }
  return {
    job: parseJobSummary(payload.job),
    deploymentTarget: typeof payload.deploymentTarget === "string" ? payload.deploymentTarget : null,
    registryStatus: typeof payload.registryStatus === "string" ? payload.registryStatus : null,
    cutover: parseCutoverState(payload.cutover),
    cellPool: parseHostedUmbrellaCellsStatus(payload.cellPool),
  };
}

export function parseHostedAzureMigrationResult(payload: unknown): HostedAzureMigrationResult {
  if (!isRecord(payload)) {
    throw new Error("HOSTED_AZURE_MIGRATION_FAILED");
  }
  return {
    jobId: asString(payload.jobId),
    status: asString(payload.status, "unknown"),
    cellId: typeof payload.cellId === "string" ? payload.cellId : null,
    slotId: typeof payload.slotId === "string" ? payload.slotId : null,
    claimLatencyMs: typeof payload.claimLatencyMs === "number" ? payload.claimLatencyMs : null,
    migrationMode: asString(payload.migrationMode, "lossless_commit_log"),
    directPromoted: payload.directPromoted === true,
    cutover: parseCutoverState(payload.cutover),
  };
}

export function extractHostedMigrationErrorMessage(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback;
  const detail = payload.detail;
  if (typeof detail === "string" && detail.trim()) return detail.trim();
  if (isRecord(detail) && typeof detail.message === "string" && detail.message.trim()) {
    return detail.message.trim();
  }
  if (typeof payload.message === "string" && payload.message.trim()) return payload.message.trim();
  return fallback;
}
