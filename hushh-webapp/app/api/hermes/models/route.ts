import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

import { resolveHermesBridgeConfig } from "@/lib/hermes/bridge-config";

/**
 * The Puppy One model picker, proxied to the local Hermes api_server.
 *
 * GET lists the providers and models Hermes can actually reach. POST pins one.
 * Both go through this route so the loopback bearer key stays server-side.
 *
 * Two things are surfaced rather than smoothed over, because hiding either
 * would leave the picker showing a model that is not the one answering:
 *
 *   - Pinning writes config and applies to NEW sessions only. The running
 *     session keeps its model, so the response says so and the panel starts a
 *     fresh session rather than letting the label drift from the runtime.
 *   - Hermes answers an expensive model with {ok: false, confirm_required},
 *     not an error. That is a question, and it is passed through as one.
 */

const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

/** Providers that run on this machine. Everything else leaves it. */
const LOCAL_PROVIDERS = new Set(["lmstudio", "lm-studio", "lm_studio", "ollama"]);

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

function notConfigured() {
  return Response.json(
    {
      configured: false,
      providers: [],
      message: "Set HERMES_API_SERVER_KEY to reach Puppy One on this machine.",
    },
    { status: 200 },
  );
}

export async function GET(request: NextRequest) {
  const config = resolveHermesBridgeConfig();
  if (!config) return notConfigured();

  // Parsed from request.url rather than nextUrl: the same handler is exercised
  // with a plain Request in tests, and nextUrl exists only on NextRequest.
  let refresh = false;
  try {
    refresh = new URL(request.url).searchParams.get("refresh") === "1";
  } catch {
    refresh = false;
  }
  let upstream: Response;
  try {
    upstream = await fetch(
      `${config.baseUrl}/api/model/options?include_unconfigured=false${refresh ? "&refresh=true" : ""}`,
      {
        headers: { Authorization: `Bearer ${config.apiKey}` },
        signal: AbortSignal.timeout(20_000),
      },
    );
  } catch {
    return Response.json(
      { configured: true, reachable: false, providers: [] },
      { status: 200 },
    );
  }
  if (!upstream.ok) {
    return Response.json(
      { configured: true, reachable: false, providers: [] },
      { status: 200 },
    );
  }

  const payload = (await upstream.json().catch(() => ({}))) as {
    providers?: Array<{
      id?: unknown;
      slug?: unknown;
      name?: unknown;
      models?: unknown;
      capabilities?: unknown;
      is_current?: unknown;
      authenticated?: unknown;
    }>;
    model?: unknown;
    provider?: unknown;
  };

  // Hermes identifies a provider by `slug` and lists its models as plain
  // strings, with per-model capabilities in a sibling map keyed by model id.
  // An older shape used `id` and `{id}` objects. Read both: a picker that
  // renders every provider and model as "" is the one surface that lies
  // about the runtime, and it is exactly what the old mapping produced.
  const providers = (Array.isArray(payload.providers) ? payload.providers : [])
    .map((entry) => {
      const id = String(entry?.slug ?? entry?.id ?? "");
      const capabilities =
        entry?.capabilities && typeof entry.capabilities === "object"
          ? (entry.capabilities as Record<string, Record<string, unknown> | undefined>)
          : {};
      const models = Array.isArray(entry?.models)
        ? (entry.models as Array<unknown>)
            .map((model) => {
              const modelId =
                typeof model === "string"
                  ? model
                  : String((model as Record<string, unknown>)?.id ?? "");
              const inline =
                typeof model === "object" && model !== null
                  ? (model as Record<string, unknown>)
                  : {};
              return {
                id: modelId,
                supportsReasoning: Boolean(
                  (inline.capabilities as Record<string, unknown> | undefined)
                    ?.reasoning ??
                    inline.supports_reasoning ??
                    capabilities[modelId]?.reasoning,
                ),
              };
            })
            .filter((model) => model.id)
        : [];
      return {
        id,
        name: String(entry?.name ?? id),
        // Marked, not filtered. A picker that silently drops the cloud
        // providers cannot explain why they are missing; one that shows them
        // as off-machine tells the truth about what the choice costs.
        onDevice: LOCAL_PROVIDERS.has(id.toLowerCase()),
        isCurrent: Boolean(entry?.is_current),
        models,
      };
    })
    .filter((provider) => provider.id);

  return Response.json({
    configured: true,
    reachable: true,
    providers,
    current: {
      model: String(payload.model ?? ""),
      provider: String(payload.provider ?? ""),
    },
    reasoningEfforts: REASONING_EFFORTS,
  });
}

export async function POST(request: NextRequest) {
  const config = resolveHermesBridgeConfig();
  if (!config) return notConfigured();

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const provider = String(body.provider ?? "").trim();
  const model = String(body.model ?? "").trim();
  const confirmExpensive = Boolean(body.confirmExpensive);
  if (!provider || !model) {
    return Response.json(
      { ok: false, error: "Pick a provider and a model." },
      { status: 400 },
    );
  }

  const effortInput = String(body.reasoningEffort ?? "").trim();
  // Validate against the list rather than forwarding whatever arrived: an
  // unrecognised effort would be silently ignored downstream, leaving the UI
  // showing a setting that is not in force.
  if (effortInput && !REASONING_EFFORTS.includes(effortInput as ReasoningEffort)) {
    return Response.json(
      {
        ok: false,
        error: `Unknown reasoning effort ${effortInput}.`,
        accepted: REASONING_EFFORTS,
      },
      { status: 400 },
    );
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${config.baseUrl}/api/model/set`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        scope: "main",
        provider,
        model,
        confirm_expensive_model: confirmExpensive,
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return Response.json(
      { ok: false, error: "Puppy One is not answering on this machine." },
      { status: 200 },
    );
  }

  const result = (await upstream.json().catch(() => ({}))) as Record<string, unknown>;
  if (!upstream.ok) {
    return Response.json(
      { ok: false, error: "Puppy One could not change the model." },
      { status: 200 },
    );
  }

  if (result.confirm_required) {
    return Response.json({
      ok: false,
      confirmRequired: true,
      confirmMessage: String(result.confirm_message ?? "This model bills per token."),
      provider,
      model,
    });
  }

  return Response.json({
    ok: Boolean(result.ok ?? true),
    provider,
    model,
    reasoningEffort: effortInput || null,
    onDevice: LOCAL_PROVIDERS.has(provider.toLowerCase()),
    // Hermes writes config, which new sessions read. Saying "applied" here
    // would be wrong for the turn the user is in the middle of.
    appliesTo: "next-session",
  });
}
