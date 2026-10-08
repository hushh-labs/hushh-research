import { ownerCloudProvider, type OwnerCloudProvider } from "@/lib/one/owner-cloud";

/**
 * The background setup job's stages, per owner cloud, with copy a person can
 * trust. Both clouds report progress through the same setup-status record
 * (`GET /api/one/runtime/byoc/setup/status`); only the stage ids differ.
 */

export type SetupStage = { id: string; label: string };

/** The part of a setup-status record that describes progress. */
export type SetupJobProgress = {
  stage: string;
  stages: ReadonlyArray<{ stage: string }>;
};

/**
 * A setup-status record as far as choosing its cloud goes. `projectId` is a
 * Google project id for a Google job and the resource group's Azure Resource
 * Manager id for an Azure job. `deploymentTarget` is not sent today; when the
 * hub names the job's cloud it is authoritative.
 */
export type SetupJobRecord = SetupJobProgress & {
  projectId: string;
  deploymentTarget?: string | null;
};

/** Google Cloud: the six stages, in product order. */
export const GCP_SETUP_STAGES: readonly SetupStage[] = [
  { id: "creating_project", label: "Creating your project" },
  { id: "linking_billing", label: "Linking your billing" },
  { id: "enabling_apis", label: "Preparing cloud services" },
  { id: "applying_iam", label: "Configuring private access" },
  { id: "settling_grant", label: "Confirming cloud access" },
  { id: "proving", label: "Checking your private agent" },
];

/** Microsoft Azure: the twelve stages, in the order the hub runs them. */
export const AZURE_SETUP_STAGES: readonly SetupStage[] = [
  { id: "creating_resource_group", label: "Creating your resource group" },
  { id: "registering_providers", label: "Preparing Azure services" },
  { id: "creating_identity", label: "Creating your agent’s identity" },
  { id: "creating_key_vault", label: "Creating your agent’s key vault" },
  { id: "creating_storage", label: "Creating storage for your agent’s memory" },
  { id: "creating_registry", label: "Creating your private image store" },
  { id: "creating_model", label: "Setting up your Azure OpenAI model" },
  { id: "creating_environment", label: "Preparing where your agent runs" },
  { id: "assigning_roles", label: "Configuring private access" },
  { id: "importing_image", label: "Copying your agent into your subscription" },
  { id: "deploying_agent", label: "Starting your private agent" },
  { id: "proving", label: "Checking your private agent" },
];

export const AZURE_SETUP_FIRST_STAGE = "creating_resource_group";

/** An approved update re-runs only the tail of the Azure job, from here on. */
export const AZURE_UPGRADE_FIRST_STAGE = "importing_image";

/** Every job row starts here with no stages (`byoc_setup_job_service.start`). */
const STARTING_STAGES: readonly SetupStage[] = [{ id: "starting", label: "Starting" }];

/** Google's project-id rule (`validate_project_id`): all the Google path accepts. */
const GCP_PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/** An Azure job's subject: `/subscriptions/<id>/resourceGroups/<name>`. */
const AZURE_RESOURCE_GROUP_ID = /^\/subscriptions\/[^/\s]+\/resourcegroups\/[^/\s]+$/i;

const GCP_STAGE_IDS = new Set(GCP_SETUP_STAGES.map((stage) => stage.id));

const AZURE_ONLY_STAGE_IDS = new Set(
  AZURE_SETUP_STAGES.map((stage) => stage.id).filter((id) => !GCP_STAGE_IDS.has(id)),
);

function reachedStageIds(job: SetupJobProgress): string[] {
  return [job.stage, ...job.stages.map((entry) => entry.stage)].filter(Boolean);
}

function azureStageIndex(id: string): number {
  return AZURE_SETUP_STAGES.findIndex((stage) => stage.id === id);
}

function firstReachedAzureIndex(job: SetupJobProgress): number {
  const reached = new Set(reachedStageIds(job));
  return AZURE_SETUP_STAGES.findIndex((stage) => reached.has(stage.id));
}

/**
 * Which cloud a setup job belongs to, from evidence in the record itself:
 * the cloud the hub names, then the shape of `projectId`, then any Azure-only
 * stage (the vocabularies share only `proving`). A record with none of these,
 * such as a malformed id, falls back to the registry's owner cloud, and is
 * otherwise unknown (`null`) rather than guessed to be Google.
 */
export function setupJobProvider(
  job: SetupJobRecord | null,
  registryProvider: OwnerCloudProvider | null = null,
): OwnerCloudProvider | null {
  if (!job) return null;
  const declared = ownerCloudProvider(job.deploymentTarget);
  if (declared) return declared;
  if (AZURE_RESOURCE_GROUP_ID.test(job.projectId)) return "azure";
  if (reachedStageIds(job).some((id) => AZURE_ONLY_STAGE_IDS.has(id))) return "azure";
  if (GCP_PROJECT_ID.test(job.projectId)) return "gcp";
  return registryProvider;
}

/** How a failed setup is retried; `null` when its cloud cannot be told. */
export type SetupRetry = { provider: "azure" } | { provider: "gcp"; projectId: string };

/**
 * The retry for a failed or stopped job. Only a valid Google project id ever
 * reaches the Google authorization path; an Azure job restarts the person's
 * Microsoft sign-in.
 */
export function setupRetryFor(
  job: SetupJobRecord,
  registryProvider: OwnerCloudProvider | null = null,
): SetupRetry | null {
  const provider = setupJobProvider(job, registryProvider);
  if (provider === "azure") return { provider: "azure" };
  if (provider === "gcp" && GCP_PROJECT_ID.test(job.projectId)) {
    return { provider: "gcp", projectId: job.projectId };
  }
  return null;
}

/**
 * The Azure stages this job walks, starting at the first one it reported: a
 * setup shows all twelve, an approved update only its own tail. Before any
 * stage is reported the list starts at `defaultFirstStage`.
 */
export function azureChecklistStages(
  job: SetupJobProgress,
  defaultFirstStage: string = AZURE_SETUP_FIRST_STAGE,
): readonly SetupStage[] {
  const reachedStart = firstReachedAzureIndex(job);
  const start = reachedStart >= 0 ? reachedStart : azureStageIndex(defaultFirstStage);
  return AZURE_SETUP_STAGES.slice(Math.max(start, 0));
}

/** True when an Azure job began at the update tail rather than at setup. */
export function isAzureUpgradeJob(job: SetupJobProgress): boolean {
  const start = firstReachedAzureIndex(job);
  return start >= 0 && start >= azureStageIndex(AZURE_UPGRADE_FIRST_STAGE);
}

/**
 * The cloud step's checklist heading and stages for a running job. An Azure
 * job that has not reported a stage yet (it may be a setup or an update) and a
 * job whose cloud cannot be told show one neutral "Starting" row.
 */
export function setupChecklistFor(
  job: SetupJobRecord,
  registryProvider: OwnerCloudProvider | null = null,
): {
  title: string;
  stages: readonly SetupStage[];
} {
  const provider = setupJobProvider(job, registryProvider);
  if (provider === "gcp") {
    return { title: `Setting up ${job.projectId}`, stages: GCP_SETUP_STAGES };
  }
  if (provider === "azure" && firstReachedAzureIndex(job) >= 0) {
    return {
      title: isAzureUpgradeJob(job)
        ? "Updating your agent in Microsoft Azure"
        : "Setting up your agent in Microsoft Azure",
      stages: azureChecklistStages(job),
    };
  }
  return {
    title: provider === "azure" ? "Starting in Microsoft Azure" : "Starting your cloud setup",
    stages: STARTING_STAGES,
  };
}
