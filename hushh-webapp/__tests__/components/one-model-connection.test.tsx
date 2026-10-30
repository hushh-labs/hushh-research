import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { OneModelConnection } from "@/components/agent/one-model-connection";

describe("OneModelConnection", () => {
  it("shows the cloud provider and exposes an unverified connection", () => {
    render(<OneModelConnection connection={{
      user_id: "owner", selected_model: null, effective_model: "gpt-deployment",
      source: "owner_pod", choices: [], effective_provider: "azure_openai",
      verification: "unverified",
    }} />);

    expect(screen.getByText("Azure AI · gpt-deployment")).toBeVisible();
    expect(screen.getByText("Not verified")).toBeVisible();
    expect(screen.getByRole("group", { name: /Azure AI.*gpt-deployment.*not verified/i })).toBeVisible();
  });

  it("does not claim a provider when the pod has not supplied one", () => {
    render(<OneModelConnection connection={{
      user_id: "owner", selected_model: null, effective_model: "model",
      source: "owner_pod", choices: [],
    }} />);

    expect(screen.getByText("Your AI · model")).toBeVisible();
    expect(screen.getByText("Not verified")).toBeVisible();
  });

  it("allows the full model name to wrap in the profile sheet", () => {
    render(<OneModelConnection fullWidth connection={{
      user_id: "owner", selected_model: null, effective_model: "a-long-private-deployment-name",
      source: "owner_pod", choices: [], effective_provider: "gemini",
      verification: "previously_verified",
    }} />);

    expect(screen.getByText("Gemini · a-long-private-deployment-name")).toHaveClass("break-all");
    expect(screen.queryByText("Not verified")).not.toBeInTheDocument();
  });
});
