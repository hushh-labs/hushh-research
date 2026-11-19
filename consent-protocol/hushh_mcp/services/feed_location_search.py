"""Only recorded Location labels and typed Check-In facts enter local search."""

from typing import Any


def search_label_sql(alias: str, key: str) -> str:
    if alias not in {"source", "milestone", "m"} or key not in {
        "search_current_name",
        "counterpart_label",
        "display_name",
        "circle_name",
        "user_facing_status",
        "ticker",
    }:
        raise ValueError("Search labels must be authored fields")
    return (
        f"CASE WHEN jsonb_typeof({alias}.metadata->'{key}')='string' "
        f"THEN {alias}.metadata->>'{key}' END"
    )


LOCATION_SEARCH_CONTEXT_SQL = f"""(SELECT COALESCE(jsonb_agg(context.alias),'[]'::jsonb)
    FROM (SELECT DISTINCT jsonb_build_object(
      'person',concat_ws(' ',source.actor_label,{search_label_sql("source", "counterpart_label")},
        {search_label_sql("source", "display_name")}),
      'circle',{search_label_sql("source", "circle_name")},
      'check_in',COALESCE(source.metadata->>'share_kind'='check_in',FALSE)) AS alias
    FROM classified source WHERE source.thread_key=g.thread_key
      AND source.source_domain='location' AND source.dismissed_at IS NULL
      AND (g.last_dismissed_id IS NULL OR source.id>g.last_dismissed_id)
      AND (CAST(:from_at AS timestamptz) IS NULL OR source.created_at>=CAST(:from_at AS timestamptz))
      AND (CAST(:before_at AS timestamptz) IS NULL OR source.created_at<CAST(:before_at AS timestamptz))
      AND (CAST(:agent AS text) IS NULL OR source.subagent_id=:agent)) context)
    AS location_search_context"""


def location_search_fields(row: dict[str, Any]) -> dict[str, Any]:
    contexts = row.get("location_search_context")
    if not isinstance(contexts, list):
        return {}
    # Only SQL-computed fields are accepted; storage metadata cannot supply aliases.
    safe = []
    for item in contexts:
        if not isinstance(item, dict):
            continue
        safe.append(
            {
                "person": item.get("person", "")[:480]
                if isinstance(item.get("person"), str)
                else "",
                "circle": item.get("circle", "")[:160]
                if isinstance(item.get("circle"), str)
                else "",
                "check_in": item.get("check_in") is True,
            }
        )
    return {"location_search_context": safe}
