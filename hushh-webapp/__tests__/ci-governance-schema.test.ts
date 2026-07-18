import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function loadCiGovernance() {
  const filePath = path.resolve(
    process.cwd(),
    "../config/ci-governance.json",
  );

  return JSON.parse(
    fs.readFileSync(filePath, "utf-8"),
  ) as Record<string, unknown>;
}

describe("ci-governance.json", () => {
  const governance = loadCiGovernance();

  it("contains the required top-level sections", () => {
    expect(governance).toHaveProperty("branch_flow");
    expect(governance).toHaveProperty("main");
    expect(governance).toHaveProperty("pr_train");
    expect(governance).toHaveProperty("uat");
    expect(governance).toHaveProperty("production");
  });

  it("defines branch flow strings", () => {
    const branchFlow = governance.branch_flow as Record<string, unknown>;

    expect(typeof branchFlow.train_branch).toBe("string");
    expect(typeof branchFlow.promotion_branch).toBe("string");
  });

  it("defines governance rules for main", () => {
    const main = governance.main as Record<string, unknown>;

    expect(typeof main.required_status_check).toBe("string");
    expect(typeof main.required_approving_reviews).toBe("number");
    expect(typeof main.merge_queue_required).toBe("boolean");
  });

  it("defines governance rules for pr_train", () => {
    const train = governance.pr_train as Record<string, unknown>;

    expect(typeof train.required_status_check).toBe("string");
    expect(typeof train.required_approving_reviews).toBe("number");
    expect(typeof train.merge_queue_required).toBe("boolean");
  });

  it("defines uat environment metadata", () => {
    const uat = governance.uat as Record<string, unknown>;

    expect(typeof uat.environment).toBe("string");
    expect(typeof uat.required_post_merge_check).toBe("string");
  });

  it("defines production environment metadata", () => {
    const production = governance.production as Record<string, unknown>;

    expect(typeof production.owner_environment).toBe("string");
    expect(typeof production.required_post_merge_check).toBe("string");
  });
});