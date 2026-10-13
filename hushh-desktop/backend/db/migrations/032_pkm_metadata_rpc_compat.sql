-- PKM cutover compatibility: restore metadata RPC expected by runtime services.

CREATE OR REPLACE FUNCTION get_user_world_model_metadata(p_user_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_domains JSONB := '[]'::JSONB;
    v_available_domains TEXT[] := ARRAY[]::TEXT[];
    v_total_attributes INTEGER := 0;
    v_last_updated TIMESTAMPTZ := NULL;
BEGIN
    IF EXISTS (SELECT 1 FROM pkm_index WHERE user_id = p_user_id) THEN
        SELECT
            COALESCE(ARRAY_AGG(domain_key ORDER BY domain_key), ARRAY[]::TEXT[]),
            COALESCE(
                JSONB_AGG(
                    JSONB_BUILD_OBJECT(
                        'key', domain_key,
                        'display_name', COALESCE(display_name, INITCAP(REPLACE(domain_key, '_', ' '))),
                        'icon', COALESCE(icon_name, 'folder'),
                        'color', COALESCE(color_hex, '#6B7280'),
                        'attribute_count', attribute_count,
                        'last_updated', last_updated
                    )
                    ORDER BY domain_key
                ),
                '[]'::JSONB
            ),
            COALESCE(SUM(attribute_count), 0),
            MAX(last_updated)
        INTO
            v_available_domains,
            v_domains,
            v_total_attributes,
            v_last_updated
        FROM (
            SELECT
                domain_key.domain AS domain_key,
                dr.display_name,
                dr.icon_name,
                dr.color_hex,
                COALESCE(
                    pm.path_count,
                    NULLIF(pi.domain_summaries -> domain_key.domain ->> 'attribute_count', '')::INTEGER,
                    NULLIF(pi.domain_summaries -> domain_key.domain ->> 'item_count', '')::INTEGER,
                    NULLIF(pi.domain_summaries -> domain_key.domain ->> 'holdings_count', '')::INTEGER,
                    0
                ) AS attribute_count,
                COALESCE(pm.last_content_at, pi.updated_at) AS last_updated
            FROM pkm_index pi
            CROSS JOIN LATERAL UNNEST(COALESCE(pi.available_domains, ARRAY[]::TEXT[])) AS domain_key(domain)
            LEFT JOIN pkm_manifests pm
                ON pm.user_id = pi.user_id
               AND pm.domain = domain_key.domain
            LEFT JOIN domain_registry dr
                ON dr.domain_key = domain_key.domain
            WHERE pi.user_id = p_user_id
        ) domain_rows;

        RETURN JSONB_BUILD_OBJECT(
            'user_id', p_user_id,
            'domains', v_domains,
            'available_domains', TO_JSONB(v_available_domains),
            'total_attributes', v_total_attributes,
            'last_updated', v_last_updated
        );
    END IF;

    IF EXISTS (SELECT 1 FROM world_model_index_v2 WHERE user_id = p_user_id) THEN
        SELECT
            COALESCE(wmi.available_domains, ARRAY[]::TEXT[]),
            COALESCE(wmi.total_attributes, 0),
            wmi.updated_at
        INTO
            v_available_domains,
            v_total_attributes,
            v_last_updated
        FROM world_model_index_v2 wmi
        WHERE wmi.user_id = p_user_id;

        SELECT
            COALESCE(
                JSONB_AGG(
                    JSONB_BUILD_OBJECT(
                        'key', domain_key.domain,
                        'display_name', COALESCE(dr.display_name, INITCAP(REPLACE(domain_key.domain, '_', ' '))),
                        'icon', COALESCE(dr.icon_name, 'folder'),
                        'color', COALESCE(dr.color_hex, '#6B7280'),
                        'attribute_count',
                            COALESCE(
                                NULLIF(wmi.domain_summaries -> domain_key.domain ->> 'attribute_count', '')::INTEGER,
                                NULLIF(wmi.domain_summaries -> domain_key.domain ->> 'item_count', '')::INTEGER,
                                NULLIF(wmi.domain_summaries -> domain_key.domain ->> 'holdings_count', '')::INTEGER,
                                0
                            ),
                        'last_updated', wmi.updated_at
                    )
                    ORDER BY domain_key.domain
                ),
                '[]'::JSONB
            )
        INTO v_domains
        FROM world_model_index_v2 wmi
        CROSS JOIN LATERAL UNNEST(COALESCE(wmi.available_domains, ARRAY[]::TEXT[])) AS domain_key(domain)
        LEFT JOIN domain_registry dr
            ON dr.domain_key = domain_key.domain
        WHERE wmi.user_id = p_user_id;

        RETURN JSONB_BUILD_OBJECT(
            'user_id', p_user_id,
            'domains', v_domains,
            'available_domains', TO_JSONB(v_available_domains),
            'total_attributes', v_total_attributes,
            'last_updated', v_last_updated
        );
    END IF;

    RETURN JSONB_BUILD_OBJECT(
        'user_id', p_user_id,
        'domains', '[]'::JSONB,
        'available_domains', '[]'::JSONB,
        'total_attributes', 0,
        'last_updated', NULL
    );
END;
$$;
