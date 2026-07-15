export type KaiStreamKind = "portfolio_import" | "portfolio_optimize" | "stock_analyze";

export interface KaiStreamEnvelope<TPayload = Record<string, unknown>> {
  schema_version: "1.0";
  stream_id: string;
  stream_kind: KaiStreamKind;
  seq: number;
  event: string;
  terminal: boolean;
  payload: TPayload;
}

export interface ParsedSSEFrame {
  event: string;
  data: string;
  id?: string;
}

export function isKaiStreamEnvelope(value: unknown): value is KaiStreamEnvelope {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.schema_version === "1.0" &&
    typeof record.stream_id === "string" &&
    typeof record.stream_kind === "string" &&
    typeof record.seq === "number" &&
    typeof record.event === "string" &&
    typeof record.terminal === "boolean" &&
    typeof record.payload === "object" &&
    record.payload !== null
  );
}
