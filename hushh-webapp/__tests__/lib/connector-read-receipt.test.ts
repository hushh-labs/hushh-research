import { describe, expect, it } from "vitest";
import { parseConnectorReadReceipt } from "@/lib/agent/connector-read-receipt";
import { parseAgentToolResultExperience } from "@/lib/agent/agui-structured-experiences";

const receipt = {
  schema_version: "specialist_read.v1", connector: "mail", status: "ok",
  sources: [{ source_ref: "mail:1", label: "Mail", kind: "metadata" }],
  truncated: true, metadata_only: true,
};

describe("connector read receipts", () => {
  it("preserves only opaque Drive citations and bounded page provenance", () => {
    const ref = `document:${"a".repeat(32)}`;
    const structured = { ...receipt, connector: "drive", metadata_only: false,
      sources: [{ source_ref: ref, kind: "document", label: "Document", page: 2 }] };
    const value = parseAgentToolResultExperience("ask_documents_agent", { text: "PRIVATE DOCUMENT", structured });
    expect(value).toEqual({ type: "one.connector_read.v1", connector: "drive", status: "ok", sourceRefs: [ref], sourcePages: [2], truncated: true, metadataOnly: false });
    expect(JSON.stringify(value)).not.toContain("PRIVATE");
    expect(parseConnectorReadReceipt({ ...structured, sources: [{ ...structured.sources[0], page: 101 }] })).toBeNull();
    expect(parseConnectorReadReceipt({ ...structured, sources: [{ ...structured.sources[0], label: "PRIVATE FILENAME" }] })).toBeNull();
    const found = { ...structured, metadata_only: true,
      sources: [{ source_ref: ref, kind: "metadata", label: "Document", page: null }] };
    expect(parseConnectorReadReceipt(found)).toMatchObject({ metadataOnly: true, sourceRefs: [ref] });
    expect(parseConnectorReadReceipt({ ...found, sources: [{ ...found.sources[0], open_url: "https://evil.invalid" }] })).toBeNull();
  });
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

  it("projects a provider-specific setup card only for an explicit Workspace MCP permission result", () => {
    // Private tool arguments are removed at the wire boundary. The safe
    // provider enum in the result must be sufficient to offer reconnection.
    expect(parseAgentToolResultExperience(
      "read_workspace_tool",
      { status: "permission_required", provider: "calendar", private_result: "not_retained" },
    )).toEqual({
      type: "one.workspace_connector_setup.v1",
      provider: "calendar",
      status: "connect_required",
    });
    expect(parseAgentToolResultExperience(
      "discover_workspace_tools",
      { status: "permission_required", provider: "drive", tools: [] },
      { provider: "drive" },
    )).toEqual({
      type: "one.workspace_connector_setup.v1",
      provider: "drive",
      status: "connect_required",
    });
    expect(parseAgentToolResultExperience(
      "read_workspace_tool",
      { status: "permission_required" },
      { provider: "gmail", query: "private search terms" },
    )).toMatchObject({ provider: "gmail", status: "connect_required" });
    expect(parseAgentToolResultExperience(
      "discover_workspace_tools",
      { status: "permission_required", provider: "drive" },
      { provider: "gmail" },
    )).toBeNull();
    expect(parseAgentToolResultExperience(
      "discover_workspace_tools",
      { status: "ok", provider: "drive" },
      { provider: "drive" },
    )).toMatchObject({ provider: "drive", status: "manage_available" });
    expect(parseAgentToolResultExperience(
      "discover_workspace_tools",
      { status: "api_available", provider: "gmail" },
      { provider: "gmail" },
    )).toMatchObject({ provider: "gmail", status: "manage_available" });
    expect(parseAgentToolResultExperience(
      "read_workspace_tool", { status: "ok", provider: "gmail" }, { provider: "gmail" },
    )).toBeNull();
    expect(parseAgentToolResultExperience(
      "untrusted_tool",
      { status: "permission_required", provider: "drive" },
      { provider: "drive" },
    )).toBeNull();
  });

  it("projects only a generic setup action for the owner's private connectors", () => {
    const result = parseAgentToolResultExperience("inspect_private_connectors", {
      status: "setup_available", provider: "custom",
      saved: [{ name: "PRIVATE CONNECTOR NAME", status: "saved" }],
    });
    expect(result).toEqual({
      type: "one.workspace_connector_setup.v1",
      provider: "custom",
      status: "manage_available",
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE CONNECTOR NAME");
    expect(parseAgentToolResultExperience("inspect_private_connectors", {
      status: "blocked", provider: "custom",
    })).toBeNull();
    expect(parseAgentToolResultExperience("inspect_private_connectors", {
      status: "blocked", result: { status: "setup_available", provider: "custom" },
    })).toBeNull();
    expect(parseAgentToolResultExperience("other_tool", {
      status: "setup_available", provider: "custom",
    })).toBeNull();
  });
  it("shows only bounded, identified connector metadata in the Chat card", () => {
    const id = `custom_${"a".repeat(32)}`;
    const result = parseAgentToolResultExperience("inspect_private_connectors", {
      status: "setup_available", provider: "custom",
      saved: [{ id, name: "Synthetic app", status: "reconnect_needed", token: "synthetic-private-token" }],
    });
    expect(result).toMatchObject({ provider: "custom", saved: [{ id, name: "Synthetic app", status: "reconnect_needed" }] });
    expect(JSON.stringify(result)).not.toContain("synthetic-private-token");
  });
});
