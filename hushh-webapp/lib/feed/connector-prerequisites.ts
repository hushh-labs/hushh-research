import { GOOGLE_DRIVE_CONNECTOR_ID } from "@/lib/consent/document-request-setup";
import type { FeedActionable } from "./use-feed-actionables";

/** Feed presentation only; each source request and To-do keeps its own identity. */
export function foldFeedConnectorPrerequisites(items: FeedActionable[]): FeedActionable[] {
  const grouped = new Map<string, FeedActionable[]>();
  for (const item of items) {
    const connector = item.connectorPrerequisite?.connectorId;
    if (connector !== GOOGLE_DRIVE_CONNECTOR_ID) continue;
    const group = grouped.get(connector) ?? [];
    group.push(item);
    grouped.set(connector, group);
  }
  const folded = items.filter(item => !item.connectorPrerequisite ||
    (grouped.get(item.connectorPrerequisite.connectorId)?.length ?? 0) < 2);
  for (const [connector, group] of grouped) {
    if (group.length < 2) continue;
    const first = group[0]!;
    const timestamps = group.flatMap(item => typeof item.displayTimestamp === "number" ? [item.displayTimestamp] : []);
    folded.push({ ...first, id: `connector:${connector}`, operationKey: `connector:external:${connector}`,
      operationKeys: group.flatMap(item => item.operationKey ? [item.operationKey] : []),
      title: "Connect Google Drive", description: `${group.length} document requests`,
      person: null, todo: undefined, onSelect: undefined,
      sortAt: Math.max(...group.map(item => item.sortAt)),
      displayTimestamp: timestamps.length ? Math.max(...timestamps) : null,
      affectedRequests: group.flatMap(item => item.connectorPrerequisite ? [{
        requestId: item.connectorPrerequisite.requestId, label: item.title,
        href: item.connectorPrerequisite.href,
      }] : []),
    });
  }
  return folded;
}
