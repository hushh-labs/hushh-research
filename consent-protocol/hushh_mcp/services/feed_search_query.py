"""Search the admitted owner history before ranking and keyset pagination."""

from hushh_mcp.services.feed_activity_policy import POLICY_REVISION, browse_admission_sql
from hushh_mcp.services.feed_location_search import search_label_sql
from hushh_mcp.services.feed_search_contract import scope_sql, terms_sql


def search_sql(cte: str) -> str:
    anchor = "WHERE f.user_id = :user_id"
    if anchor not in cte:
        raise ValueError("Canonical owner Feed CTE required")
    cte = cte.replace(anchor, anchor + " AND f.id<=:snapshot_id", 1)
    fields = [
        "left(COALESCE(m.actor_label,''),160)",
        *[
            search_label_sql("m", key)
            for key in (
                "search_current_name",
                "counterpart_label",
                "display_name",
                "circle_name",
                "ticker",
                "user_facing_status",
            )
        ],
        "replace(m.event_type,'_',' ')",
        "CASE WHEN m.source_domain='location' AND m.metadata->>'share_kind'='check_in' THEN 'check in checkin' END",
        "to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD FMMonth DD YYYY')",
    ]
    return (
        cte
        + f""", search_labels AS (
      SELECT m.*, {scope_sql("m")} AS scope_id,
        ARRAY(SELECT btrim(regexp_replace(lower(normalize(COALESCE(label,''),NFKC) COLLATE "pg_c_utf8"),'[^[:alnum:]]+',' ','g'))
          FROM unnest(ARRAY[{",".join(fields)}] || ({terms_sql("m")})) label) AS labels
      FROM classified m JOIN grouped current ON current.thread_key=m.thread_key
      WHERE m.dismissed_at IS NULL AND (current.last_dismissed_id IS NULL OR m.id>current.last_dismissed_id)
        AND {browse_admission_sql("m")} AND (m.source_action_required OR (
        m.event_type='mail_information_request_detected' AND m.metadata->>'workflow_id' IS NOT NULL
        AND current.event_type='mail_message_sent' AND current.subagent_id='agent_kyc'))
        AND (CAST(:from_at AS timestamptz) IS NULL OR m.created_at>=CAST(:from_at AS timestamptz))
        AND (CAST(:before_at AS timestamptz) IS NULL OR m.created_at<CAST(:before_at AS timestamptz))
        AND (CAST(:agent AS text) IS NULL OR m.subagent_id=:agent)
    ), searchable AS (
      SELECT *,array_to_string(labels,' ') AS words FROM search_labels
      WHERE (CAST(:scope AS text) IS NULL OR scope_id=:scope)
    ), matches AS MATERIALIZED (
      SELECT thread_key,MAX(CASE WHEN :query='' THEN 0
        WHEN :query=ANY(labels) THEN 100
        WHEN NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(CAST(:terms AS jsonb)) term
          WHERE NOT EXISTS(SELECT 1 FROM unnest(string_to_array(words,' ')) word
            WHERE left(word,length(term))=term)) THEN 80 ELSE 50 END) AS search_rank
      FROM searchable WHERE NOT EXISTS(
        SELECT 1 FROM jsonb_array_elements_text(CAST(:terms AS jsonb)) term
        WHERE strpos(words,term)=0)
      AND strpos(array_to_string(labels[1:4],' '),:person)>0 GROUP BY thread_key
    ), search_ranked AS (
      SELECT g.*,matches.search_rank,{scope_sql("g")} AS scope_id
      FROM grouped g JOIN matches USING(thread_key)
    ), search_snapshot AS (
      SELECT md5(COALESCE(string_agg(md5(jsonb_build_array('{POLICY_REVISION}',id,source_domain,actor_label,event_type,created_at,
        thread_key,metadata,source_action_required,dismissed_at)::text),'' ORDER BY id),'')) AS search_revision FROM keyed
    ) SELECT page.*,search_snapshot.search_revision FROM search_snapshot
    LEFT JOIN LATERAL (SELECT * FROM search_ranked WHERE CAST(:after_rank AS int) IS NULL
      OR (search_rank,created_at,id)<(:after_rank,CAST(:after_time AS timestamptz),CAST(:after_id AS bigint))
      ORDER BY search_rank DESC,created_at DESC,id DESC LIMIT :page_size) page ON TRUE"""
    )


def suggestion_sql(cte: str) -> str:
    # Suggestions come from admitted, owner-scoped labels, never a directory.
    return (
        cte
        + f""" SELECT DISTINCT left(m.actor_label,160) AS label FROM classified m
      JOIN grouped g ON g.thread_key=m.thread_key
      WHERE m.dismissed_at IS NULL AND (g.last_dismissed_id IS NULL OR m.id>g.last_dismissed_id)
        AND m.source_action_required AND {browse_admission_sql("m")}
        AND m.actor_label IS NOT NULL AND (CAST(:scope AS text) IS NULL OR {scope_sql("m")}=:scope)
        AND (CAST(:agent AS text) IS NULL OR m.subagent_id=:agent)
        AND (CAST(:from_at AS timestamptz) IS NULL OR m.created_at>=CAST(:from_at AS timestamptz))
        AND (CAST(:before_at AS timestamptz) IS NULL OR m.created_at<CAST(:before_at AS timestamptz))
      ORDER BY label LIMIT 1000"""
    )
