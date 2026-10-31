"use client";

import { ApiService } from "@/lib/services/api-service";

const API_ROOT = "/api/one/commands/location/circle-name";
const DIRECTIVE_SCHEMA = "one.location_circle_name_interaction.v1" as const;
const SUBMIT_SCHEMA = "one.location_circle_name_submit_result.v1" as const;
const RUN_ID_RE = /^run_[a-z0-9]{16,96}$/u;
const DIRECTIVE_ID_RE = /^loccirclecmd_[a-f0-9]{32}$/u;
const LEASE_ID_RE = /^loccirclelease_[0-9]{10,11}_[a-f0-9]{64}$/u;
const CONTEXT_RE = /^[A-Za-z0-9_.:-]*$/u;

export type LocationCircleNameDirectiveV1 = {
  schemaVersion: typeof DIRECTIVE_SCHEMA;
  actionId: "location.create_circle";
  surfaceId: "render.form";
  formId: "one.location.create_circle_name.v1";
  directiveId: string;
  run: {
    runId: string;
    revision: number;
    graphRevision: string;
    contextRevision: string;
    status: "needs_input";
  };
  lease: {
    leaseId: string;
    runRevision: number;
  };
  expiresAt: string;
  titleKey: "one.location.circle_name.title";
  bodyKey: "one.location.circle_name.body";
  fields: readonly [
    {
      fieldId: "name";
      type: "string";
      required: true;
      maxLength: 80;
    },
  ];
  submitKey: "one.location.circle_name.submit";
};

export type LocationCircleNameSubmitResultV1 = {
  schemaVersion: typeof SUBMIT_SCHEMA;
  status: "verified" | "working" | "failed";
  actionId: "location.create_circle";
  runId: string;
  statusCard: {
    schemaVersion: "one.location_command_status_card.v1";
    surfaceId: "render.data_card";
    cardId: "one.location.command.circle_verified.v1";
    actionId: "location.create_circle";
    settlement: "verified";
  } | null;
  reasonCode: string | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function positiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/** Strictly rebuild the only approved missing-Circle-name form projection. */
export function parseLocationCircleNameDirective(
  source: unknown,
): LocationCircleNameDirectiveV1 | null {
  const value = record(source);
  if (
    !value ||
    !exactKeys(value, [
      "actionId",
      "bodyKey",
      "directiveId",
      "expiresAt",
      "fields",
      "formId",
      "lease",
      "run",
      "schemaVersion",
      "submitKey",
      "surfaceId",
      "titleKey",
    ]) ||
    value.schemaVersion !== DIRECTIVE_SCHEMA ||
    value.actionId !== "location.create_circle" ||
    value.surfaceId !== "render.form" ||
    value.formId !== "one.location.create_circle_name.v1" ||
    value.titleKey !== "one.location.circle_name.title" ||
    value.bodyKey !== "one.location.circle_name.body" ||
    value.submitKey !== "one.location.circle_name.submit" ||
    typeof value.directiveId !== "string" ||
    !DIRECTIVE_ID_RE.test(value.directiveId) ||
    typeof value.expiresAt !== "string" ||
    !value.expiresAt ||
    value.expiresAt.length > 64 ||
    !Number.isFinite(Date.parse(value.expiresAt))
  ) {
    return null;
  }
  const run = record(value.run);
  const lease = record(value.lease);
  const fields = value.fields;
  if (
    !run ||
    !lease ||
    !Array.isArray(fields) ||
    fields.length !== 1 ||
    !exactKeys(run, ["contextRevision", "graphRevision", "revision", "runId", "status"]) ||
    !exactKeys(lease, ["leaseId", "runRevision"]) ||
    typeof run.runId !== "string" ||
    !RUN_ID_RE.test(run.runId) ||
    !positiveInt(run.revision) ||
    typeof run.graphRevision !== "string" ||
    !run.graphRevision ||
    run.graphRevision.length > 128 ||
    typeof run.contextRevision !== "string" ||
    !CONTEXT_RE.test(run.contextRevision) ||
    run.status !== "needs_input" ||
    typeof lease.leaseId !== "string" ||
    !LEASE_ID_RE.test(lease.leaseId) ||
    lease.runRevision !== run.revision
  ) {
    return null;
  }
  const field = record(fields[0]);
  if (
    !field ||
    !exactKeys(field, ["fieldId", "maxLength", "required", "type"]) ||
    field.fieldId !== "name" ||
    field.type !== "string" ||
    field.required !== true ||
    field.maxLength !== 80
  ) {
    return null;
  }
  return {
    schemaVersion: DIRECTIVE_SCHEMA,
    actionId: "location.create_circle",
    surfaceId: "render.form",
    formId: "one.location.create_circle_name.v1",
    directiveId: value.directiveId,
    run: {
      runId: run.runId,
      revision: run.revision,
      graphRevision: run.graphRevision,
      contextRevision: run.contextRevision,
      status: "needs_input",
    },
    lease: { leaseId: lease.leaseId, runRevision: run.revision },
    expiresAt: value.expiresAt,
    titleKey: "one.location.circle_name.title",
    bodyKey: "one.location.circle_name.body",
    fields: [
      { fieldId: "name", type: "string", required: true, maxLength: 80 },
    ],
    submitKey: "one.location.circle_name.submit",
  };
}

function parseSubmitResult(source: unknown): LocationCircleNameSubmitResultV1 | null {
  const value = record(source);
  if (
    !value ||
    !exactKeys(value, [
      "actionId",
      "reasonCode",
      "runId",
      "schemaVersion",
      "status",
      "statusCard",
    ]) ||
    value.schemaVersion !== SUBMIT_SCHEMA ||
    value.actionId !== "location.create_circle" ||
    typeof value.runId !== "string" ||
    !RUN_ID_RE.test(value.runId) ||
    (value.status !== "verified" && value.status !== "working" && value.status !== "failed") ||
    (value.reasonCode !== null &&
      (typeof value.reasonCode !== "string" || value.reasonCode.length > 96))
  ) {
    return null;
  }
  const statusCard = record(value.statusCard);
  if (value.status === "verified") {
    if (
      !statusCard ||
      !exactKeys(statusCard, ["actionId", "cardId", "schemaVersion", "settlement", "surfaceId"]) ||
      statusCard.schemaVersion !== "one.location_command_status_card.v1" ||
      statusCard.surfaceId !== "render.data_card" ||
      statusCard.cardId !== "one.location.command.circle_verified.v1" ||
      statusCard.actionId !== "location.create_circle" ||
      statusCard.settlement !== "verified"
    ) {
      return null;
    }
  } else if (value.statusCard !== null) {
    return null;
  }
  return {
    schemaVersion: SUBMIT_SCHEMA,
    status: value.status,
    actionId: "location.create_circle",
    runId: value.runId,
    statusCard:
      value.status === "verified"
        ? {
            schemaVersion: "one.location_command_status_card.v1",
            surfaceId: "render.data_card",
            cardId: "one.location.command.circle_verified.v1",
            actionId: "location.create_circle",
            settlement: "verified",
          }
        : null,
    reasonCode: value.reasonCode as string | null,
  };
}

function checkedVaultToken(value: string | null | undefined): string {
  const token = String(value ?? "").trim();
  if (!token || token.length > 4096) {
    throw new Error("Unlock your vault to name the Circle.");
  }
  return token;
}

async function request(
  path: string,
  options: RequestInit,
  vaultOwnerToken: string | null | undefined,
): Promise<Response> {
  const token = checkedVaultToken(vaultOwnerToken);
  return ApiService.apiFetch(path, {
    ...options,
    cache: "no-store",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
      Authorization: `Bearer ${token}`,
      "Cache-Control": "no-store",
    },
  });
}

export async function fetchActiveLocationCircleNameDirective(
  vaultOwnerToken: string | null | undefined,
): Promise<LocationCircleNameDirectiveV1 | null> {
  const response = await request(`${API_ROOT}/active`, { method: "GET" }, vaultOwnerToken);
  if (response.status === 204) return null;
  if (!response.ok) throw new Error("Agent One could not resume the Circle request.");
  const directive = parseLocationCircleNameDirective(await response.json());
  if (!directive) throw new Error("Agent One returned an invalid Circle request.");
  return directive;
}

export async function submitLocationCircleNameDirective(
  directive: LocationCircleNameDirectiveV1,
  name: string,
  vaultOwnerToken: string | null | undefined,
): Promise<LocationCircleNameSubmitResultV1> {
  const normalizedName = name.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (!normalizedName || normalizedName.length > 80 || /[\p{Cc}\p{Cf}]/u.test(normalizedName)) {
    throw new Error("Enter a Circle name up to 80 characters.");
  }
  const response = await request(
    `${API_ROOT}/${encodeURIComponent(directive.run.runId)}/submit`,
    {
      method: "POST",
      body: JSON.stringify({
        runRevision: directive.run.revision,
        directiveId: directive.directiveId,
        leaseId: directive.lease.leaseId,
        name: normalizedName,
      }),
    },
    vaultOwnerToken,
  );
  if (!response.ok) {
    throw new Error(
      response.status === 409
        ? "That Circle request changed. Start it again."
        : "Agent One could not save the Circle name. Try again.",
    );
  }
  const result = parseSubmitResult(await response.json());
  if (!result) throw new Error("Agent One returned an invalid Circle result.");
  return result;
}
