export type ForegroundChange = {
  operation: "create_folder" | "rename" | "move";
  id: string;
  file_id: string;
  revision: number;
  name: string;
  parent: string;
  request_id: string;
};
export type ForegroundProposal = {
  fileId: string;
  revision: number;
  consentRevision: number;
  provider: "gemini";
  changes: ForegroundChange[];
  result: { state: string; explanation: string };
};
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("FILES_PROJECTION_INVALID");
  return value as Record<string, unknown>;
};
const text = (value: unknown, max: number): string =>
  typeof value === "string" && value.length <= max ? value : "";
export function parseForegroundProposal(value: unknown): ForegroundProposal {
  const body = record(value),
    result = record(body.result);
  if (
    !/^[a-f0-9]{32}$/.test(String(body.fileId)) ||
    !Number.isSafeInteger(body.revision) ||
    !Number.isSafeInteger(body.consentRevision) ||
    body.provider !== "gemini" ||
    !Array.isArray(body.changes) ||
    body.changes.length > 8 ||
    !["organized", "unchanged", "unsupported", "failed"].includes(
      String(result.state),
    ) ||
    typeof result.explanation !== "string"
  )
    throw new Error("FILES_PROJECTION_INVALID");
  const changes = body.changes.map((raw) => {
    const change = record(raw);
    if (!["create_folder", "rename", "move"].includes(String(change.operation)))
      throw new Error("FILES_PROJECTION_INVALID");
    const parsed: ForegroundChange = {
      operation: change.operation as ForegroundChange["operation"],
      id: text(change.id, 32),
      file_id: text(change.file_id, 32),
      revision: Number(change.revision),
      name: text(change.name, 255),
      parent: text(change.parent, 32),
      request_id: text(change.request_id, 128),
    };
    if (
      parsed.operation === "create_folder"
        ? !/^[a-f0-9]{32}$/.test(parsed.id) ||
          !parsed.name ||
          !parsed.parent ||
          !parsed.request_id
        : !/^[a-f0-9]{32}$/.test(parsed.file_id) ||
          !Number.isSafeInteger(parsed.revision) ||
          parsed.revision < 1 ||
          (parsed.operation === "rename" ? !parsed.name : !parsed.parent)
    )
      throw new Error("FILES_PROJECTION_INVALID");
    return parsed;
  });
  return {
    fileId: String(body.fileId),
    revision: Number(body.revision),
    consentRevision: Number(body.consentRevision),
    provider: "gemini",
    changes,
    result: {
      state: String(result.state),
      explanation: result.explanation.slice(0, 2000),
    },
  };
}
