import { useCallback, useRef, useState, type MutableRefObject, type SetStateAction } from "react";

export function useShareRecipientSelectionState(): readonly [
  string[],
  (next: SetStateAction<string[]>) => string[],
  MutableRefObject<string[]>,
] {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // React can batch multiple share actions before rerendering. This cursor lets
  // each action compose from the latest queued selection while state remains
  // the rendered source of truth. Exposed (read-only by convention) so a
  // handler that fires immediately after a select -- faster than the render
  // that would otherwise make the pick visible -- can still read who was just
  // chosen instead of the not-yet-committed empty state. See its use in
  // handleShare's effectiveSelectedShareRecipients.
  const latestSelectedIdsRef = useRef<string[]>([]);
  const updateSelectedIds = useCallback(
    (next: SetStateAction<string[]>): string[] => {
      const resolvedIds =
        typeof next === "function" ? next(latestSelectedIdsRef.current) : next;
      latestSelectedIdsRef.current = resolvedIds;
      setSelectedIds(resolvedIds);
      return resolvedIds;
    },
    [],
  );
  return [selectedIds, updateSelectedIds, latestSelectedIdsRef] as const;
}
