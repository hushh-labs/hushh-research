export function isConnectionRequestEntry(entry: { kind?: string | null }): boolean {
  return entry?.kind === "connection_request";
}
