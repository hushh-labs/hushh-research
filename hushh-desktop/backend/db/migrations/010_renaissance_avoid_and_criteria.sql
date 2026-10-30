-- ============================================================================
-- Migration 010: Renaissance Avoid + Screening Criteria
-- Extends Renaissance dataset beyond investable universe tiers.
--
-- Sources (seeded via script):
-- - consent-protocol/data/renaissance/Renaissance Investable vs Avoid(AVOID)_2.csv
-- - consent-protocol/data/renaissance/Renaissance Investable vs Avoid(Extended_Avoid_Tickers)_3.csv
-- - consent-protocol/data/renaissance/Renaissance Investable vs Avoid(Screening_Criteria)_4.csv
--
-- NOTE:
-- - This migration is intentionally modular and does NOT modify 007_renaissance_universe.sql
-- - Requires `update_updated_at_column()` to exist (created in 006_fix_triggers.sql).
-- ============================================================================

-- ============================================================================
-- RENAISSANCE AVOID (Ticker-level negative signals)
-- ============================================================================
CREATE TABLE IF NOT EXISTS renaissance_avoid (
    id SERIAL PRIMARY KEY,
    ticker TEXT NOT NULL UNIQUE,
    category TEXT NOT NULL,
    company_name TEXT,
    sector TEXT,
    why_avoid TEXT,
    -- Provenance: 'avoid_list' or 'extended_avoid_tickers'
    source TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_renaissance_avoid_category ON renaissance_avoid(category);

DROP TRIGGER IF EXISTS update_renaissance_avoid_updated_at ON renaissance_avoid;
CREATE TRIGGER update_renaissance_avoid_updated_at
    BEFORE UPDATE ON renaissance_avoid
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE renaissance_avoid IS
    'Renaissance avoid list: tickers/entities flagged as capital destructors or structurally impaired. Seeded from CSV sources.';

-- ============================================================================
-- RENAISSANCE SCREENING CRITERIA (Rubric used to interpret losers)
-- ============================================================================
CREATE TABLE IF NOT EXISTS renaissance_screening_criteria (
    id SERIAL PRIMARY KEY,
    -- investable_requirements | automatic_avoid_triggers | the_math
    section TEXT NOT NULL,
    -- Optional numeric index within a section (e.g. 1..N)
    rule_index INTEGER,
    -- Short name (e.g. 'Positive Absolute FCF')
    title TEXT NOT NULL,
    -- Full rule text / explanation
    detail TEXT NOT NULL,
    -- Optional value field for THE MATH rows (e.g. "~58,000 companies")
    value_text TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_renaissance_criteria_section ON renaissance_screening_criteria(section);
CREATE INDEX IF NOT EXISTS idx_renaissance_criteria_section_rule_idx ON renaissance_screening_criteria(section, rule_index);

COMMENT ON TABLE renaissance_screening_criteria IS
    'Renaissance screening rubric (investable requirements, automatic avoid triggers, and math funnel). Seeded from CSV.';

-- ============================================================================
-- OPTIONAL RPC: Check if ticker is in Renaissance Avoid list
-- Mirrors is_renaissance_investable() from 007_renaissance_universe.sql
-- ============================================================================
CREATE OR REPLACE FUNCTION is_renaissance_avoid(p_ticker TEXT)
RETURNS JSONB
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_result JSONB;
BEGIN
    SELECT jsonb_build_object(
        'is_avoid', TRUE,
        'ticker', ticker,
        'category', category,
        'company', company_name,
        'sector', sector,
        'why_avoid', why_avoid,
        'source', source
    ) INTO v_result
    FROM renaissance_avoid
    WHERE UPPER(ticker) = UPPER(p_ticker);

    IF v_result IS NULL THEN
        RETURN jsonb_build_object(
            'is_avoid', FALSE,
            'ticker', UPPER(p_ticker),
            'message', 'Not in Renaissance avoid list'
        );
    END IF;

    RETURN v_result;
END;
$$;

