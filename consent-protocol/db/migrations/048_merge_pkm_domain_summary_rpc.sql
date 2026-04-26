-- Migration 048: atomic JSONB merge RPC for pkm_index domain summaries
-- Replaces the read-modify-write in update_domain_summary() with a single
-- DB-level upsert, eliminating the race window on concurrent writes.

CREATE OR REPLACE FUNCTION merge_pkm_domain_summary(
    p_user_id      TEXT,
    p_domain       TEXT,
    p_patch        JSONB,
    p_domains_list TEXT[]
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
    INSERT INTO pkm_index (user_id, domain_summaries, available_domains, updated_at)
    VALUES (
        p_user_id,
        jsonb_build_object(p_domain, p_patch),
        p_domains_list,
        now()
    )
    ON CONFLICT (user_id) DO UPDATE SET
        domain_summaries = pkm_index.domain_summaries || jsonb_build_object(p_domain,
            COALESCE(pkm_index.domain_summaries -> p_domain, '{}'::jsonb) || p_patch
        ),
        available_domains = (
            SELECT array_agg(DISTINCT elem)
            FROM unnest(pkm_index.available_domains || p_domains_list) AS elem
        ),
        updated_at = now();
END;
$$;