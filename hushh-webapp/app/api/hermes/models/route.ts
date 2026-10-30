import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

import { isSameOriginRequest, resolveHermesBridgeConfig } from "@/lib/hermes/bridge-config";

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

/** The build a model file is. The gateway sends nothing else. */
export type ModelVariant = "MLX" | "GGUF";

/**
 * Read the variant as "MLX", "GGUF", or unknown.
 *
 * The gateway documents null as "not known", which is NOT an error state: the
 * row simply shows no chip. Anything unrecognised is read the same way, on
 * purpose. A variant chip is a claim about how the model executes, and echoing
 * an uninterpreted string would put a guess in front of the owner wearing the
 * same styling as a fact.
 */
function readVariant(value: unknown): ModelVariant | null {
  if (typeof value !== "string") return null;
  const upper = value.trim().toUpperCase();
  return upper === "MLX" || upper === "GGUF" ? upper : null;
}

/** A present, non-blank string, or null. Absence is carried, never defaulted. */
function readText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.trim() || null;
}

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

/**
 * List what the owner can actually pick.
 *
 * This reads /api/hussh-one/models, which already guarantees the three things
 * the old /api/model/options did not: only AUTHENTICATED providers appear,
 * model ids are deduplicated within a provider, and a provider with no models
 * is omitted entirely. That is why five dead rows (Nous Portal, Fireworks,
 * OpenRouter, NovitaAI, OpenAI) used to sit above the models that exist.
 *
 * None of those rules are re-implemented here. Two filters for one policy
 * drift apart, and the copy of the rule that lives further from the model host
 * is the one that goes stale. This handler normalises shapes and nothing else:
 * every field except a model `id` is optional, and an absent one is carried as
 * null rather than filled in, because "unknown" and "none" are different facts.
 */
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
    // `refresh` is forwarded as a hint, not a requirement. The contract for
    // this endpoint does not promise the parameter, and a gateway that ignores
    // it returns the same cached truth: a staler list, never a wrong one.
    upstream = await fetch(
      `${config.baseUrl}/api/hussh-one/models${refresh ? "?refresh=true" : ""}`,
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
    providers?: unknown;
    current?: unknown;
  };

  const providers = (Array.isArray(payload.providers) ? payload.providers : [])
    .map((rawProvider) => {
      const entry =
        rawProvider && typeof rawProvider === "object"
          ? (rawProvider as Record<string, unknown>)
          : {};
      const id = String(entry.id ?? "").trim();
      const models = (Array.isArray(entry.models) ? entry.models : [])
        .map((rawModel) => {
          const model =
            rawModel && typeof rawModel === "object"
              ? (rawModel as Record<string, unknown>)
              : {};
          return {
            // A bare string was the older wire shape for a model. Reading it
            // costs one branch and is the exact drift that once rendered every
            // row as "": the picker is the one surface that must not lie about
            // what is answering.
            id:
              typeof rawModel === "string"
                ? rawModel.trim()
                : String(model.id ?? "").trim(),
            variant: readVariant(model.variant),
            quantization: readText(model.quantization),
            // Left as an open string. An unrecognised state degrades to "not
            // shown" downstream rather than being mapped onto a known one.
            state: readText(model.state),
            supportsReasoning: Boolean(model.supportsReasoning),
          };
        })
        // A model with no id cannot be pinned, so it is not offered. This is a
        // shape guard, not the gateway's authentication or dedupe policy.
        .filter((model) => model.id);
      return {
        id,
        name: String(entry.name ?? id),
        // The gateway's own answer wins; the local list is only the fallback
        // for a payload that omitted the field. This label is the promise that
        // the words stay on this machine, so it is never inferred from
        // anything softer than the provider id.
        onDevice:
          typeof entry.onDevice === "boolean"
            ? entry.onDevice
            : LOCAL_PROVIDERS.has(id.toLowerCase()),
        isCurrent: Boolean(entry.isCurrent),
        models,
      };
    })
    .filter((provider) => provider.id);

  const current =
    payload.current && typeof payload.current === "object"
      ? (payload.current as Record<string, unknown>)
      : {};

  const body = {
    providers,
    current: {
      model: String(current.model ?? ""),
      provider: String(current.provider ?? ""),
    },
    reasoningEfforts: REASONING_EFFORTS,
  };

  // The envelope flags are written LAST on purpose. `configured` and
  // `reachable` describe THIS bridge, not the gateway, so nothing derived from
  // the payload can overwrite our own answer about it.
  return Response.json({ ...body, configured: true, reachable: true });
}

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) {
    // Pinning a model changes which model answers on the owner's machine, and
    // this route adds the loopback key server-side. Without this check a page
    // the owner merely visits could repoint their agent off-device.
    return Response.json(
      { ok: false, error: "Cross-site requests cannot change the model." },
      { status: 403 },
    );
  }

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
    // No `onDevice` here on purpose. The pin call's only upstream request is
    // `/api/model/set`, whose response carries no provider list, so this route
    // could only answer from the hardcoded id set below -- and GET already
    // prefers the gateway's own `entry.onDevice`. Two rules for one policy
    // drift, and this was the half that could contradict the label the person
    // had just read: a gateway-declared local provider whose slug is not one
    // of the three names was shown as "on this machine" and then told, in the
    // transcript, that it runs off it. The picker carries the row's own answer
    // through to its caller instead.
    // Hermes writes config, which new sessions read. Saying "applied" here
    // would be wrong for the turn the user is in the middle of.
    appliesTo: "next-session",
  });
}
