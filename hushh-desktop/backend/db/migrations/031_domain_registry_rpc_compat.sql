-- PKM cutover compatibility: restore domain registry RPC used by runtime services.

CREATE OR REPLACE FUNCTION auto_register_domain(
    p_domain_key TEXT,
    p_display_name TEXT DEFAULT NULL,
    p_icon_name TEXT DEFAULT 'folder',
    p_color_hex TEXT DEFAULT '#6B7280'
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
    v_display_name TEXT;
    v_result JSONB;
BEGIN
    v_display_name := COALESCE(p_display_name, INITCAP(REPLACE(p_domain_key, '_', ' ')));

    INSERT INTO domain_registry (domain_key, display_name, icon_name, color_hex)
    VALUES (p_domain_key, v_display_name, p_icon_name, p_color_hex)
    ON CONFLICT (domain_key) DO NOTHING;

    SELECT jsonb_build_object(
        'domain_key', domain_key,
        'display_name', display_name,
        'icon_name', icon_name,
        'color_hex', color_hex,
        'attribute_count', attribute_count,
        'user_count', user_count
    )
    INTO v_result
    FROM domain_registry
    WHERE domain_key = p_domain_key;

    RETURN v_result;
END;
$$;
