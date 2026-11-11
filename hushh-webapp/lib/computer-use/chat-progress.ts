/** Private task/tool values never enter generic chat activity or diagnostics. */
export function privateToolProgressArgs(
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (name === "discover_workspace_tools" || name === "read_workspace_tool") {
    return { provider: args.provider };
  }
  return [
    "start_browser_task",
    "inspect_private_connectors",
    "probe_private_connector",
    "ask_email_agent",
    "ask_documents_agent",
    "inspect_selected_drive_files",
    "read_selected_drive_search_result",
  ].includes(name)
    ? {}
    : args;
}

export function browserTaskProgress(content: unknown, ownerId: string) {
  let result: unknown = content;
  if (typeof result === "string") {
    try {
      result = JSON.parse(result);
    } catch {
      result = null;
    }
  }
  const record =
    result && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : null;
  const binding =
    record?.binding &&
    typeof record.binding === "object" &&
    !Array.isArray(record.binding)
      ? (record.binding as Record<string, unknown>)
      : null;
  const accepted =
    record?.status === "accepted" &&
    binding?.owner_id === ownerId &&
    typeof binding.task_id === "string" &&
    /^browser_[a-f0-9]{32}$/.test(binding.task_id);
  return {
    accepted,
    event: {
      execution: accepted ? "server" : "blocked",
      message: accepted
        ? "Browser task prepared."
        : "Browser isn’t available on this Agent One yet.",
      raw: { protocol: "ag-ui", toolName: "start_browser_task" },
    },
  };
}
