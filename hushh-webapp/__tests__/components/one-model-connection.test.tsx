import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { OneModelConnection } from "@/components/agent/one-model-connection";

describe("OneModelConnection", () => {
  it("shows human provider labels and hides internal deployment slugs and unverified developer telemetry", () => {
    render(
      <OneModelConnection
        connection={{
          user_id: "owner",
          selected_model: null,
          effective_model: "one-chat",
          source: "owner_pod",
          choices: [],
          effective_provider: "azure_openai",
          verification: "unverified",
        }}
      />,
    );

    expect(screen.getByText("Azure AI")).toBeVisible();
    expect(screen.queryByText(/one-chat/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/not verified/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: "One's AI: Azure AI" }),
    ).toBeVisible();
  });

  it("humanizes Gemini preview identifiers and falls back to Private AI without provider metadata", () => {
    const { rerender } = render(
      <OneModelConnection
        connection={{
          user_id: "owner",
          selected_model: null,
          effective_model: "gemini-2.5-flash-preview-09-2026",
          source: "owner_pod",
          choices: [],
          effective_provider: "gemini",
          verification: "unverified",
        }}
      />,
    );
    expect(screen.getByText("Gemini · 2.5 Flash")).toBeVisible();
    expect(screen.queryByText(/not verified/i)).not.toBeInTheDocument();

    rerender(
      <OneModelConnection
        connection={{
          user_id: "owner",
          selected_model: null,
          effective_model: "model",
          source: "owner_pod",
          choices: [],
        }}
      />,
    );
    expect(screen.getByText("Private AI")).toBeVisible();
  });

  it("allows custom deployment names to wrap cleanly in the profile sheet", () => {
    render(
      <OneModelConnection
        fullWidth
        connection={{
          user_id: "owner",
          selected_model: null,
          effective_model: "a-long-private-deployment-name",
          source: "owner_pod",
          choices: [],
          effective_provider: "gemini",
          verification: "previously_verified",
        }}
      />,
    );

    expect(
      screen.getByText("Gemini · a-long-private-deployment-name"),
    ).toHaveClass("break-all");
    expect(screen.queryByText(/not verified/i)).not.toBeInTheDocument();
  });
});
