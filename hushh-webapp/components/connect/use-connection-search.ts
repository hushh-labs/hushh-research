import { useEffect, useRef, useState } from "react";
import type {
  ConnectionAudience,
  ConnectionPage,
  ConnectionSummaryEntry,
} from "@/lib/services/connections-service";

type SearchPage = {
  scope: string;
  items: ConnectionSummaryEntry[];
  page: number;
  hasMore: boolean;
  totalCount: number;
  loading: boolean;
  error: boolean;
};
const EMPTY: SearchPage = {
  scope: "",
  items: [],
  page: 0,
  hasMore: false,
  totalCount: 0,
  loading: false,
  error: false,
};

/** Read-only roster search through the existing paged service. It never replaces
 * the browse snapshot used by graph reconciliation or writes search rows to cache. */
export function useConnectionSearch({
  ownerId,
  query,
  audience,
  loadPage,
  revision,
}: {
  ownerId: string | null;
  query: string;
  audience: ConnectionAudience;
  loadPage: (
    page: number,
    audience: ConnectionAudience,
    query?: string,
  ) => Promise<ConnectionPage | null>;
  revision: readonly ConnectionSummaryEntry[];
}) {
  const normalizedQuery = query.trim();
  const scope = JSON.stringify([ownerId, audience, normalizedQuery]);
  const [state, setState] = useState<SearchPage>(EMPTY);
  const requestRef = useRef(0);
  const currentScope = useRef(scope);
  useEffect(() => {
    currentScope.current = scope;
  }, [scope]);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const request = ++requestRef.current;
    if (!ownerId || !normalizedQuery) return;
    setState((previous) => ({
      ...(previous.scope === scope ? previous : EMPTY),
      scope,
      loading: true,
      error: false,
    }));
    void loadPage(1, audience, normalizedQuery).then((result) => {
      if (request !== requestRef.current || currentScope.current !== scope)
        return;
      setState((previous) =>
        result
          ? { scope, ...result, loading: false, error: false }
          : { ...previous, loading: false, error: true },
      );
    });
    return () => {
      requestRef.current += 1;
    };
  }, [ownerId, audience, normalizedQuery, scope, loadPage, revision, retry]);
  const current =
    state.scope === scope
      ? state
      : { ...EMPTY, loading: Boolean(ownerId && normalizedQuery) };
  const loadMore = async () => {
    if (!normalizedQuery || current.loading || !current.hasMore) return;
    const request = ++requestRef.current;
    setState((previous) => ({ ...previous, loading: true, error: false }));
    const result = await loadPage(current.page + 1, audience, normalizedQuery);
    if (request !== requestRef.current || currentScope.current !== scope)
      return;
    setState((previous) => {
      if (!result) return { ...previous, loading: false, error: true };
      const rows = new Map(
        previous.items.map((row) => [row.connectionId, row]),
      );
      result.items.forEach((row) => rows.set(row.connectionId, row));
      return {
        scope,
        ...result,
        items: [...rows.values()],
        loading: false,
        error: false,
      };
    });
  };
  return {
    ...current,
    active: Boolean(normalizedQuery),
    loadMore,
    retry: () => setRetry((value) => value + 1),
  };
}
