"""Fixed retained-activity SQL shared by collection and independent reporting."""

# Overinclusive candidates are safe: proof/eligibility is applied before counts.
# LIMIT 51 is an overflow sentinel, never a truncated global measurement. Fifty
# is the existing lifecycle/identity contract, not a new production capacity.
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
SELECT user_id FROM candidates ORDER BY user_id LIMIT 51
"""
MEANINGFUL_REPLIES_SQL = """
SELECT DISTINCT a.user_id FROM agent_chat_messages a
WHERE a.user_id=ANY($1::text[]) AND a.role='assistant' AND a.status='complete'
 AND a.error_code IS NULL AND a.completed_at >= $2 AND a.completed_at <= $3
 AND EXISTS(SELECT 1 FROM agent_chat_messages u WHERE u.user_id=a.user_id
   AND u.conversation_id=a.conversation_id AND u.role='user' AND u.status='complete'
   AND u.created_at <= a.created_at)
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
