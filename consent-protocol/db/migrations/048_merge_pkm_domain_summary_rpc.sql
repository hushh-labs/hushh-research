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
DECLARE
    v_patch JSONB := COALESCE(p_patch, '{}'::JSONB);
    v_domains TEXT[] := COALESCE(p_domains_list, ARRAY[p_domain]::TEXT[]);
BEGIN
    INSERT INTO pkm_index (
        user_id,
        domain_summaries,
        available_domains,
        total_attributes,
        updated_at
    )
    VALUES (
        p_user_id,
        jsonb_build_object(p_domain, v_patch),
        v_domains,
        COALESCE(
            NULLIF(v_patch ->> 'attribute_count', '')::INTEGER,
            NULLIF(v_patch ->> 'holdings_count', '')::INTEGER,
            NULLIF(v_patch ->> 'item_count', '')::INTEGER,
            0
        ),
        now()
    )
    ON CONFLICT (user_id) DO UPDATE SET
        domain_summaries = COALESCE(pkm_index.domain_summaries, '{}'::JSONB) || jsonb_build_object(
            p_domain,
            COALESCE(pkm_index.domain_summaries -> p_domain, '{}'::JSONB) || v_patch
        ),
        available_domains = (
            SELECT array_agg(DISTINCT elem)
            FROM unnest(COALESCE(pkm_index.available_domains, ARRAY[]::TEXT[]) || v_domains) AS elem
            WHERE elem IS NOT NULL AND elem <> ''
        ),
        total_attributes = (
            SELECT COALESCE(
                SUM(
                    COALESCE(
                        NULLIF(value ->> 'attribute_count', '')::INTEGER,
                        NULLIF(value ->> 'holdings_count', '')::INTEGER,
                        NULLIF(value ->> 'item_count', '')::INTEGER,
                        0
                    )
                ),
                0
            )
            FROM jsonb_each(
                COALESCE(pkm_index.domain_summaries, '{}'::JSONB) || jsonb_build_object(
                    p_domain,
                    COALESCE(pkm_index.domain_summaries -> p_domain, '{}'::JSONB) || v_patch
                )
            ) AS merged(domain, value)
        ),
        updated_at = now();
END;
$$;
