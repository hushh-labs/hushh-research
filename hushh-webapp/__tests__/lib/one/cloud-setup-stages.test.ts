import { describe, expect, it } from "vitest";

import {
  AZURE_SETUP_STAGES,
  AZURE_UPGRADE_FIRST_STAGE,
  GCP_SETUP_STAGES,
  azureChecklistStages,
  isAzureUpgradeJob,
  setupChecklistFor,
  setupJobProvider,
  setupRetryFor,
} from "@/lib/one/cloud-setup-stages";

function job(stage: string, reached: string[] = [stage]) {
  return { stage, stages: reached.map((id) => ({ stage: id })), projectId: "" };
}

/** What the hub writes for an Azure job: `azure_setup_plan.group_id`. */
const AZURE_GROUP = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-hussh-one-abc";
/** Every job row starts here (`byoc_setup_job_service.start`). */
const STARTING = { stage: "starting", stages: [] };

describe("cloud setup stages", () => {
  it("keeps the hub's Azure stage order exactly", () => {
    expect(AZURE_SETUP_STAGES.map((stage) => stage.id)).toEqual([
      "creating_resource_group",
      "registering_providers",
      "creating_identity",
      "creating_key_vault",
      "creating_storage",
      "creating_registry",
      "creating_model",
      "creating_environment",
      "assigning_roles",
      "importing_image",
      "deploying_agent",
      "proving",
    ]);
    for (const stage of AZURE_SETUP_STAGES) expect(stage.label.trim().length).toBeGreaterThan(0);
  });

  it("leaves the Google stages unchanged", () => {
    expect(GCP_SETUP_STAGES.map((stage) => stage.id)).toEqual([
      "creating_project",
      "linking_billing",
      "enabling_apis",
      "applying_iam",
      "settling_grant",
      "proving",
    ]);
  });

  it("reads the cloud from the stages a job reported", () => {
    expect(setupJobProvider(null)).toBeNull();
    expect(setupJobProvider({ ...job("creating_project"), projectId: "owner-project" })).toBe("gcp");
    expect(setupJobProvider(job("creating_storage", ["creating_resource_group", "creating_storage"]))).toBe("azure");
    // `proving` is shared; the earlier Azure-only history decides.
    expect(setupJobProvider(job("proving", ["deploying_agent", "proving"]))).toBe("azure");
    expect(setupJobProvider({ ...job("proving", ["settling_grant", "proving"]), projectId: "owner-project" })).toBe("gcp");
  });

  it("reads a just-started job's cloud from its record, never by guessing Google", () => {
    expect(setupJobProvider({ ...STARTING, projectId: AZURE_GROUP })).toBe("azure");
    expect(setupJobProvider({ ...STARTING, projectId: "owner-project" })).toBe("gcp");
    expect(setupJobProvider({ ...STARTING, projectId: "owner-project", deploymentTarget: "user_azure" })).toBe("azure");
    expect(setupJobProvider({ ...STARTING, projectId: "" })).toBeNull();
    expect(setupJobProvider({ ...STARTING, projectId: "" }, "azure")).toBe("azure");
    expect(setupJobProvider({ ...STARTING, projectId: "Not A Project" }, "gcp")).toBe("gcp");
  });

  it("retries Google only with a valid Google project id", () => {
    expect(setupRetryFor({ ...STARTING, projectId: AZURE_GROUP })).toEqual({ provider: "azure" });
    expect(setupRetryFor({ ...STARTING, projectId: AZURE_GROUP }, "gcp")).toEqual({ provider: "azure" });
    expect(setupRetryFor({ ...job("linking_billing"), projectId: "owner-project" })).toEqual({
      provider: "gcp",
      projectId: "owner-project",
    });
    // A registry that says Google never sends a non-Google id down that path.
    expect(setupRetryFor({ ...STARTING, projectId: "Not A Project" }, "gcp")).toBeNull();
    expect(setupRetryFor({ ...STARTING, projectId: "" })).toBeNull();
  });

  it("shows a setup all twelve stages and an update only its own tail", () => {
    expect(azureChecklistStages(job("creating_resource_group"))).toHaveLength(12);
    const tail = azureChecklistStages(job("deploying_agent", ["importing_image", "deploying_agent"]));
    expect(tail.map((stage) => stage.id)).toEqual(["importing_image", "deploying_agent", "proving"]);
    expect(isAzureUpgradeJob(job("deploying_agent", ["importing_image", "deploying_agent"]))).toBe(true);
    expect(isAzureUpgradeJob(job("creating_identity", ["creating_resource_group", "creating_identity"]))).toBe(false);
  });

  it("starts at the given default before any stage is reported", () => {
    const empty = { stage: "", stages: [] };
    expect(azureChecklistStages(empty)).toHaveLength(12);
    expect(azureChecklistStages(empty, AZURE_UPGRADE_FIRST_STAGE).map((stage) => stage.id)).toEqual([
      "importing_image",
      "deploying_agent",
      "proving",
    ]);
    expect(isAzureUpgradeJob(empty)).toBe(false);
  });

  it("shows a just-started job one neutral row instead of the Google list", () => {
    expect(setupChecklistFor({ ...STARTING, projectId: AZURE_GROUP })).toEqual({
      title: "Starting in Microsoft Azure",
      stages: [{ id: "starting", label: "Starting" }],
    });
    expect(setupChecklistFor({ ...STARTING, projectId: "" })).toEqual({
      title: "Starting your cloud setup",
      stages: [{ id: "starting", label: "Starting" }],
    });
    expect(setupChecklistFor({ ...STARTING, projectId: "owner-project" }).stages).toBe(GCP_SETUP_STAGES);
  });

  it("titles the cloud step's checklist for the job's cloud", () => {
    expect(setupChecklistFor({ ...job("linking_billing"), projectId: "owner-project" })).toEqual({
      title: "Setting up owner-project",
      stages: GCP_SETUP_STAGES,
    });
    expect(setupChecklistFor(job("creating_model", ["creating_resource_group", "creating_model"])).title).toBe(
      "Setting up your agent in Microsoft Azure",
    );
    expect(setupChecklistFor(job("importing_image")).title).toBe("Updating your agent in Microsoft Azure");
  });
});
