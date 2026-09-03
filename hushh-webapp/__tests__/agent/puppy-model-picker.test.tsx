import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchPuppyModelOptions: vi.fn(),
  assignPuppyModel: vi.fn(),
}));

vi.mock("@/lib/services/puppy-one-service", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/services/puppy-one-service")>();
  return {
    ...original,
    fetchPuppyModelOptions: mocks.fetchPuppyModelOptions,
    assignPuppyModel: mocks.assignPuppyModel,
  };
});

import { PuppyModelPicker } from "@/components/agent/puppy-model-picker";
import type { PuppyModelOptions } from "@/lib/services/puppy-one-service";

/**
 * What the owner sees in the picker.
 *
 * The complaint this defends against is concrete: five providers with no
 * credentials and no models sat above the models that exist, so choosing the
 * model that is actually loaded meant scrolling past rows that could not be
 * picked. The gateway now sends only real, authenticated, deduplicated models,
 * and these tests hold the picker to showing exactly that list -- plus the
 * build type beside each row, which is the difference between a model that
 * runs well on this machine and one that does not.
 */

/**
 * The open popover. List queries are scoped to it because the trigger shows the
 * CURRENT model's short name, which otherwise matches a row of the same name
 * and makes "is this model listed once" unanswerable.
 */
function list() {
  return screen.getByRole("dialog");
}

function open(payload: PuppyModelOptions) {
  mocks.fetchPuppyModelOptions.mockResolvedValue(payload);
  const view = render(<PuppyModelPicker onApplied={vi.fn()} />);
  fireEvent.click(screen.getByTitle("Choose the model and reasoning effort"));
  return view;
}

function options(overrides: Partial<PuppyModelOptions> = {}): PuppyModelOptions {
  return {
    configured: true,
    reachable: true,
    current: { model: "google/gemma-4-26b-a4b-qat", provider: "lmstudio" },
    reasoningEfforts: ["none", "low", "medium", "high"],
    providers: [
      {
        id: "lmstudio",
        name: "LM Studio",
        onDevice: true,
        isCurrent: true,
        models: [
          {
            id: "google/gemma-4-26b-a4b-qat",
            variant: "MLX",
            quantization: "4bit",
            state: "loaded",
            supportsReasoning: true,
          },
          {
            id: "nvidia/nemotron-3-nano-omni",
            variant: "GGUF",
            quantization: "Q4_K_M",
            state: "not-loaded",
            supportsReasoning: true,
          },
        ],
      },
    ],
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("PuppyModelPicker", () => {
  it("shows the build type beside each model", async () => {
    open(options());

    expect(await screen.findByText("nemotron-3-nano-omni")).toBeInTheDocument();
    expect(within(list()).getByText("gemma-4-26b-a4b-qat")).toBeInTheDocument();
    expect(within(list()).getByText("MLX")).toBeInTheDocument();
    expect(within(list()).getByText("GGUF")).toBeInTheDocument();
  });

  it("renders nothing at all where the build type is unknown", async () => {
    open(
      options({
        providers: [
          {
            id: "lmstudio",
            name: "LM Studio",
            onDevice: true,
            models: [
              { id: "known/one", variant: "MLX" },
              { id: "unknown/two", variant: null },
              { id: "silent/three" },
            ],
          },
        ],
      }),
    );

    expect(await screen.findByText("two")).toBeInTheDocument();
    expect(screen.getByText("three")).toBeInTheDocument();
    // A chip is a claim about how the model runs. Unknown is not an error and
    // it is not a guess either: the row simply carries no chip.
    expect(screen.getAllByText(/^(MLX|GGUF)$/)).toHaveLength(1);
  });

  it("shows quantization and the loaded model without crowding the row", async () => {
    open(options());

    expect(await screen.findByText("4bit")).toBeInTheDocument();
    expect(screen.getByText("Q4_K_M")).toBeInTheDocument();
    // Only the resident model is marked, and the mark is readable to a screen
    // reader rather than being a bare dot with no meaning.
    expect(screen.getAllByText("already loaded in memory")).toHaveLength(1);
    expect(screen.getByTitle("Already loaded in memory")).toBeInTheDocument();
  });

  it("does not draw a heading over a provider with no models", async () => {
    open(
      options({
        providers: [
          {
            id: "lmstudio",
            name: "LM Studio",
            onDevice: true,
            models: [{ id: "google/gemma-4-26b-a4b-qat", variant: "MLX" }],
          },
          { id: "fireworks", name: "Fireworks", onDevice: false, models: [] },
        ],
      }),
    );

    expect(await screen.findByText("LM Studio")).toBeInTheDocument();
    // This is the row the owner was scrolling past.
    expect(screen.queryByText("Fireworks")).not.toBeInTheDocument();
  });

  it("says no models are configured when every provider came back empty", async () => {
    open(
      options({
        providers: [
          { id: "fireworks", name: "Fireworks", onDevice: false, models: [] },
        ],
      }),
    );

    expect(
      await screen.findByText("No models are configured yet."),
    ).toBeInTheDocument();
  });

  it("renders a repeated id as two rows rather than dropping one", async () => {
    open(
      options({
        providers: [
          {
            id: "lmstudio",
            name: "LM Studio",
            onDevice: true,
            models: [
              { id: "google/gemma-4-26b-a4b-qat", variant: "MLX" },
              { id: "google/gemma-4-26b-a4b-qat", variant: "GGUF" },
            ],
          },
        ],
      }),
    );

    // The gateway deduplicates, so this payload should not happen. If it did,
    // keying on the id alone would collide and silently swallow a row; the
    // picker renders both and stays standing.
    await waitFor(() =>
      expect(within(list()).getAllByText("gemma-4-26b-a4b-qat")).toHaveLength(2),
    );
  });

  it("still labels where the turn runs", async () => {
    open(
      options({
        providers: [
          {
            id: "lmstudio",
            name: "LM Studio",
            onDevice: true,
            models: [{ id: "local/one" }],
          },
          {
            id: "openai",
            name: "OpenAI",
            onDevice: false,
            models: [{ id: "gpt-5" }],
          },
        ],
      }),
    );

    expect(await screen.findByText("on this machine")).toBeInTheDocument();
    expect(screen.getByText("leaves this machine")).toBeInTheDocument();
  });

  it("still asks before pinning a model that bills per token", async () => {
    mocks.assignPuppyModel.mockResolvedValue({
      ok: false,
      confirmRequired: true,
      confirmMessage: "gpt-5 bills per token.",
    });
    open(
      options({
        providers: [
          {
            id: "openai",
            name: "OpenAI",
            onDevice: false,
            models: [{ id: "gpt-5" }],
          },
        ],
      }),
    );

    fireEvent.click(await screen.findByText("gpt-5"));

    expect(await screen.findByText("gpt-5 bills per token.")).toBeInTheDocument();
    expect(screen.getByText("Use it anyway")).toBeInTheDocument();
  });

  it("still offers the reasoning efforts the agent accepts", async () => {
    open(options());

    expect(await screen.findByRole("button", { name: "medium" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "high" }));
    expect(screen.getByRole("button", { name: "high" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
