"""Fixed retained-activity SQL shared by collection and independent reporting."""

# Overinclusive candidates are safe: proof/eligibility is applied before counts.
# LIMIT 5001 is an overflow sentinel, never a truncated global measurement.
# Individual identity/lifecycle reads remain paged in 50-owner batches.
MAX_ADOPTION_CANDIDATES = 5000
CANDIDATES_SQL = """
WITH candidates AS (
 SELECT user_id FROM agent_chat_messages WHERE completed_at >= $1 AND completed_at <= $2
 UNION SELECT user_id FROM pkm_domain_commits WHERE created_at >= $1 AND created_at <= $2
 UNION SELECT user_id FROM gmail_owner_send_actions WHERE sent_at >= $1 AND sent_at <= $2
 UNION SELECT user_id FROM one_product_value_receipts WHERE occurred_at >= $1 AND occurred_at <= $2
 UNION SELECT user_id FROM one_action_directive_ledger WHERE settled_at >= $1 AND settled_at <= $2
 UNION SELECT user_id FROM connected_system_audit_events WHERE created_at >= $1 AND created_at <= $2
 UNION SELECT user_id FROM drive_share_permission_operations WHERE settled_at >= $1 AND settled_at <= $2
)
SELECT user_id FROM candidates ORDER BY user_id LIMIT 5001
"""
MEANINGFUL_REPLIES_SQL = """
SELECT DISTINCT a.user_id FROM agent_chat_messages a
WHERE a.user_id=ANY($1::text[]) AND a.role='assistant' AND a.status='complete'
 AND a.error_code IS NULL AND a.completed_at >= $2 AND a.completed_at <= $3
 AND EXISTS(SELECT 1 FROM agent_chat_messages u WHERE u.user_id=a.user_id
   AND u.conversation_id=a.conversation_id AND u.role='user' AND u.status='complete'
   AND u.created_at <= a.created_at)
"""
MEANINGFUL_REPLY_LATEST_SQL = """
SELECT a.user_id, MAX(a.completed_at) AS latest_completed_at
FROM agent_chat_messages a
WHERE a.user_id=ANY($1::text[]) AND a.role='assistant' AND a.status='complete'
 AND a.error_code IS NULL AND a.completed_at >= $2 AND a.completed_at <= $3
 AND EXISTS(SELECT 1 FROM agent_chat_messages u WHERE u.user_id=a.user_id
   AND u.conversation_id=a.conversation_id AND u.role='user' AND u.status='complete'
   AND u.created_at <= a.created_at)
GROUP BY a.user_id
"""
SOURCE_TABLES = (
    "actor_identity_cache",
    "actor_verified_email_aliases",
    "account_deletion_tombstones",
    "agent_chat_messages",
    "pkm_domain_commits",
    "pkm_events",
    "gmail_owner_send_actions",
    "gmail_personal_information_requests",
    "one_product_value_receipts",
    "one_product_activity_epochs",
    "one_action_directive_ledger",
    "connected_system_intents",
    "connected_system_audit_events",
    "drive_share_permission_operations",
    "drive_share_reviews",
    "wallet_card_registrations",
)


# The existing expiry index bounds this additional population branch to the
# retained seven-day ledger. The native candidate sentinel remains intact.
FEATURE_CANDIDATES_SQL = (
    """
WITH observed_candidates AS MATERIALIZED (
 SELECT user_id FROM one_product_activity_observations
 WHERE observed_at >= GREATEST($1, $3::timestamptz - INTERVAL '7 days')
   AND observed_at <= $2 AND expires_at > $3
   AND expires_at <= $2::timestamptz + INTERVAL '7 days'
 LIMIT 100001
), candidates AS (
 SELECT user_id FROM ("""
    + CANDIDATES_SQL
    + """) native
 UNION SELECT user_id FROM observed_candidates
)
SELECT user_id,(SELECT COUNT(*)>100000 FROM observed_candidates) AS observation_overflow
FROM candidates ORDER BY user_id LIMIT 5001
"""
)

# Materialization plus the 100001 overflow sentinel bounds every downstream
# grouping. No raw observation, owner or operation identifier leaves One.
FEATURE_OBSERVATIONS_SQL = """
WITH retained AS MATERIALIZED (
 SELECT o.user_id,o.action_id,o.agent_id,o.source,o.phase,o.operation_key,o.observed_at
 FROM one_product_activity_observations o
 JOIN one_product_activity_epochs e ON e.user_id=o.user_id AND e.generation=o.generation
 WHERE o.user_id=ANY($1::text[]) AND o.observed_at >= $2 AND o.observed_at < $3
   AND o.expires_at > $4 AND o.expires_at <= $3::timestamptz + INTERVAL '7 days'
 LIMIT 100001
), reviewed AS (
 SELECT * FROM jsonb_to_recordset($5::jsonb)
 AS c(action_id text,agent_id text,source text)
), valid AS MATERIALIZED (
 SELECT o.* FROM retained o JOIN reviewed c USING(action_id,agent_id,source)
), phases AS (
 SELECT action_id,agent_id,source,phase,COUNT(DISTINCT user_id)::int AS accounts,
   COUNT(*)::int AS observations
 FROM valid GROUP BY action_id,agent_id,source,phase
), phase_objects AS (
 SELECT action_id,agent_id,source,jsonb_object_agg(phase,
   jsonb_build_object('accounts',accounts,'observations',observations)) AS phases
 FROM phases GROUP BY action_id,agent_id,source
), operations AS (
 SELECT user_id,action_id,agent_id,source,operation_key,
   MIN(observed_at) FILTER(WHERE phase='started') AS started_at,
   (ARRAY_AGG(phase ORDER BY observed_at DESC,phase)
     FILTER(WHERE phase<>'started'))[1] AS terminal
 FROM valid WHERE operation_key IS NOT NULL
 GROUP BY user_id,action_id,agent_id,source,operation_key
), attempts AS (
 SELECT action_id,agent_id,source,COUNT(*)::int AS correlated,
   jsonb_build_object(
     'started',COUNT(*) FILTER(WHERE started_at IS NOT NULL),
     'returned',COUNT(*) FILTER(WHERE terminal='returned'),
     'failed',COUNT(*) FILTER(WHERE terminal='failed'),
     'cancelled',COUNT(*) FILTER(WHERE terminal='cancelled'),
     'blocked',COUNT(*) FILTER(WHERE terminal='blocked'),
     'possibleIncomplete',COUNT(*) FILTER(WHERE terminal IS NULL AND started_at <= $3::timestamptz - INTERVAL '60 minutes'),
     'inProgress',COUNT(*) FILTER(WHERE terminal IS NULL AND started_at > $3::timestamptz - INTERVAL '60 minutes')
   ) AS attempts
 FROM operations GROUP BY action_id,agent_id,source
), features AS (
 SELECT action_id,agent_id,source,COUNT(DISTINCT user_id)::int AS accounts,
   COUNT(*)::int AS observations,
   COUNT(*) FILTER(WHERE operation_key IS NULL)::int AS uncorrelated
 FROM valid GROUP BY action_id,agent_id,source
), agent_counts AS (
 SELECT agent_id,COUNT(DISTINCT user_id)::int AS accounts,COUNT(*)::int AS observations
 FROM valid GROUP BY agent_id
), agent_attempts AS (
 SELECT agent_id,COUNT(*)::int AS correlated FROM operations GROUP BY agent_id
), all_source_accounts AS (
 SELECT action_id,agent_id,COUNT(DISTINCT user_id)::int AS all_source_accounts
 FROM valid GROUP BY action_id,agent_id
), capped AS (
 SELECT user_id FROM retained GROUP BY user_id,(observed_at AT TIME ZONE 'UTC')::date
 HAVING COUNT(*)>=500
)
SELECT jsonb_build_object(
 'sourceRows',(SELECT COUNT(*) FROM retained),
 'unmappedObservations',(SELECT COUNT(*) FROM retained)-(SELECT COUNT(*) FROM valid),
 'dailyCappedAccounts',(SELECT COUNT(DISTINCT user_id) FROM capped),
 'observedAccounts',(SELECT COUNT(DISTINCT user_id) FROM valid),
 'observations',(SELECT COUNT(*) FROM valid),
 'correlatedAttempts',(SELECT COUNT(*) FROM operations),
 'byAgent',COALESCE((SELECT jsonb_object_agg(g.agent_id,jsonb_build_object(
   'observedAccounts',g.accounts,'observations',g.observations,
   'correlatedAttempts',COALESCE(a.correlated,0)))
   FROM agent_counts g LEFT JOIN agent_attempts a USING(agent_id)),'{}'::jsonb),
 'features',COALESCE((SELECT jsonb_agg(to_jsonb(f)) FROM (
   SELECT f.*,p.phases,u.all_source_accounts,COALESCE(a.correlated,0) AS correlated,
     COALESCE(a.attempts,'{}'::jsonb) AS attempts
   FROM features f JOIN phase_objects p USING(action_id,agent_id,source)
   JOIN all_source_accounts u USING(action_id,agent_id)
   LEFT JOIN attempts a USING(action_id,agent_id,source)
   ORDER BY action_id,agent_id,source LIMIT 257
 ) f),'[]'::jsonb))
"""
