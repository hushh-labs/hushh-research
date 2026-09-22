import { describe, expect, it } from "vitest";
import { parseConnectorReadReceipt } from "@/lib/agent/connector-read-receipt";
import { parseAgentToolResultExperience } from "@/lib/agent/agui-structured-experiences";

const receipt = {
  schema_version: "specialist_read.v1", connector: "mail", status: "ok",
  sources: [{ source_ref: "mail:1", label: "Mail", kind: "metadata" }],
  truncated: true, metadata_only: true,
};

describe("connector read receipts", () => {
  it("adapts only the declared Mail result and drops the outer tool text", () => {
    const value = parseAgentToolResultExperience("ask_email_agent", JSON.stringify({
      text: "PRIVATE_TOOL_TEXT", status: "ok", structured: receipt,
    }));
    expect(value).toEqual({ type: "one.connector_read.v1", connector: "mail", status: "ok",
      sourceRefs: ["mail:1"], truncated: true, metadataOnly: true });
    expect(JSON.stringify(value)).not.toContain("PRIVATE");
    expect(parseAgentToolResultExperience("send_email", { structured: receipt })).toBeNull();
  });

  it.each([
    { schema_version: "future" }, { connector: "drive" }, { status: "invented" },
    { token: "PRIVATE" }, { sources: [{ source_ref: "https://evil.invalid", label: "Mail", kind: "metadata" }] },
    { sources: [{ source_ref: "mail:1", label: "PRIVATE_FILENAME", kind: "metadata" }] },
    { sources: [{ source_ref: "mail:26", label: "Mail", kind: "metadata" }] },
    { sources: [...receipt.sources, ...receipt.sources] }, { status: "reconnect_required" },
    { metadata_only: false }, { truncated: "false" },
  ])("rejects malformed or widening receipt %j", (override) => {
    expect(parseConnectorReadReceipt({ ...receipt, ...override })).toBeNull();
  });

  it("preserves safe reconnect state without inventing an OAuth action", () => {
    expect(parseConnectorReadReceipt({ ...receipt, sources: [], status: "reconnect_required" }))
      .toMatchObject({ status: "reconnect_required", sourceRefs: [] });
  });
});
