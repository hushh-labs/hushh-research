-- ============================================================================
-- Migration 004: Dynamic Domain Registry + World Model Index v2
-- Enables schema-less, dynamic domain support for any user preference type
-- ============================================================================

-- ============================================================================
-- DOMAIN REGISTRY (Dynamic Domain Discovery)
-- ============================================================================
-- Tracks all domains dynamically - no hardcoded enum
-- Domains are auto-registered on first attribute storage

CREATE TABLE IF NOT EXISTS domain_registry (
    domain_key TEXT PRIMARY KEY,  -- e.g., 'subscriptions', 'health', 'travel_rewards'
    
    -- Display metadata for UI
    display_name TEXT NOT NULL,   -- e.g., 'Subscriptions', 'Health & Wellness'
    description TEXT,
    icon_name TEXT,               -- Lucide icon name for UI (e.g., 'wallet', 'heart')
    color_hex TEXT,               -- Brand color for UI cards (e.g., '#D4AF37')
    
    -- Categorization (hierarchical domains)
    parent_domain TEXT REFERENCES domain_registry(domain_key),
    
    -- Discovery metrics (updated via triggers)
    attribute_count INTEGER DEFAULT 0,   -- Total attributes in this domain
    user_count INTEGER DEFAULT 0,        -- Users with data in this domain
    
    -- Timestamps
    first_seen_at TIMESTAMPTZ DEFAULT NOW(),
    last_updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for hierarchical queries
CREATE INDEX IF NOT EXISTS idx_domain_parent ON domain_registry(parent_domain);

-- ============================================================================
-- WORLD MODEL INDEX v2 (Dynamic JSONB-based)
-- ============================================================================
-- Replaces fixed-field world_model_index with flexible JSONB structure
-- Supports any domain without schema changes

CREATE TABLE IF NOT EXISTS world_model_index_v2 (
    user_id TEXT PRIMARY KEY REFERENCES vault_keys(user_id) ON DELETE CASCADE,
    
    -- Dynamic domain summaries (JSONB for flexibility)
    -- Example: {
    --   "financial": {"risk_bucket": "aggressive", "holdings_count": 15},
    --   "subscriptions": {"active_count": 7, "monthly_spend": 150},
    --   "health": {"fitness_score": 0.8, "last_checkin": "2026-01-30"}
    -- }
    domain_summaries JSONB DEFAULT '{}',
    
    -- Available domains for this user (for quick filtering)
    available_domains TEXT[] DEFAULT '{}',
    
    -- Computed tags (for similarity/discovery)
    computed_tags TEXT[] DEFAULT '{}',
    
    -- Activity metrics
    activity_score DECIMAL(3,2),
    last_active_at TIMESTAMPTZ,
    total_attributes INTEGER DEFAULT 0,
    
    -- Model metadata
    model_version INTEGER DEFAULT 2,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- GIN indexes for JSONB and array queries
CREATE INDEX IF NOT EXISTS idx_wmi2_domains ON world_model_index_v2 USING GIN(domain_summaries);
CREATE INDEX IF NOT EXISTS idx_wmi2_available ON world_model_index_v2 USING GIN(available_domains);
CREATE INDEX IF NOT EXISTS idx_wmi2_tags ON world_model_index_v2 USING GIN(computed_tags);

-- ============================================================================
-- UPDATE world_model_attributes TO USE TEXT DOMAIN
-- ============================================================================
-- Remove enum constraint, allow any domain string

-- First, drop the enum constraint if it exists
DO $$ 
BEGIN
    -- Check if domain column uses enum type and alter to TEXT
    IF EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'world_model_attributes' 
        AND column_name = 'domain'
        AND udt_name = 'world_model_domain'
    ) THEN
        ALTER TABLE world_model_attributes 
            ALTER COLUMN domain TYPE TEXT;
    END IF;
END $$;

-- Add new metadata columns to attributes table
ALTER TABLE world_model_attributes
    ADD COLUMN IF NOT EXISTS display_name TEXT,
    ADD COLUMN IF NOT EXISTS data_type TEXT DEFAULT 'string';

-- ============================================================================
-- SEED DEFAULT DOMAINS
-- ============================================================================
-- Pre-register common domains with display metadata

INSERT INTO domain_registry (domain_key, display_name, description, icon_name, color_hex)
VALUES 
    ('financial', 'Financial', 'Investment portfolio, risk profile, and financial preferences', 'wallet', '#D4AF37'),
    ('subscriptions', 'Subscriptions', 'Streaming services, memberships, and recurring payments', 'credit-card', '#6366F1'),
    ('health', 'Health & Wellness', 'Fitness data, health metrics, and wellness preferences', 'heart', '#EF4444'),
    ('travel', 'Travel', 'Travel preferences, loyalty programs, and trip history', 'plane', '#0EA5E9'),
    ('food', 'Food & Dining', 'Dietary preferences, favorite cuisines, and restaurant history', 'utensils', '#F97316'),
    ('professional', 'Professional', 'Career information, skills, and work preferences', 'briefcase', '#8B5CF6'),
    ('entertainment', 'Entertainment', 'Movies, music, games, and media preferences', 'tv', '#EC4899'),
    ('shopping', 'Shopping', 'Purchase history, brand preferences, and wishlists', 'shopping-bag', '#14B8A6'),
    ('general', 'General', 'Miscellaneous preferences and attributes', 'folder', '#6B7280')
ON CONFLICT (domain_key) DO NOTHING;

-- ============================================================================
-- TRIGGERS FOR AUTOMATIC COUNTER UPDATES
-- ============================================================================

-- Function to update domain_registry counters when attributes change
CREATE OR REPLACE FUNCTION update_domain_registry_counts()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- Increment attribute count
        UPDATE domain_registry 
        SET attribute_count = attribute_count + 1,
            last_updated_at = NOW()
        WHERE domain_key = NEW.domain;
        
        -- Update user count if this is first attribute for user in domain
        IF NOT EXISTS (
            SELECT 1 FROM world_model_attributes 
            WHERE user_id = NEW.user_id 
            AND domain = NEW.domain 
            AND id != NEW.id
        ) THEN
            UPDATE domain_registry 
            SET user_count = user_count + 1
            WHERE domain_key = NEW.domain;
        END IF;
        
    ELSIF TG_OP = 'DELETE' THEN
        -- Decrement attribute count
        UPDATE domain_registry 
        SET attribute_count = GREATEST(0, attribute_count - 1),
            last_updated_at = NOW()
        WHERE domain_key = OLD.domain;
        
        -- Update user count if this was last attribute for user in domain
        IF NOT EXISTS (
            SELECT 1 FROM world_model_attributes 
            WHERE user_id = OLD.user_id 
            AND domain = OLD.domain
        ) THEN
            UPDATE domain_registry 
            SET user_count = GREATEST(0, user_count - 1)
            WHERE domain_key = OLD.domain;
        END IF;
    END IF;
    
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for attribute changes
DROP TRIGGER IF EXISTS trg_update_domain_counts ON world_model_attributes;
CREATE TRIGGER trg_update_domain_counts
    AFTER INSERT OR DELETE ON world_model_attributes
    FOR EACH ROW EXECUTE FUNCTION update_domain_registry_counts();

-- Function to update world_model_index_v2 when attributes change
CREATE OR REPLACE FUNCTION update_user_index_on_attribute_change()
RETURNS TRIGGER AS $$
DECLARE
    v_user_id TEXT;
    v_domain TEXT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        v_user_id := OLD.user_id;
        v_domain := OLD.domain;
    ELSE
        v_user_id := NEW.user_id;
        v_domain := NEW.domain;
    END IF;
    
    -- Upsert user index with updated domain list and counts
    INSERT INTO world_model_index_v2 (user_id, available_domains, total_attributes, last_active_at)
    SELECT 
        v_user_id,
        ARRAY(SELECT DISTINCT domain FROM world_model_attributes WHERE user_id = v_user_id),
        (SELECT COUNT(*) FROM world_model_attributes WHERE user_id = v_user_id),
        NOW()
    ON CONFLICT (user_id) DO UPDATE SET
        available_domains = ARRAY(SELECT DISTINCT domain FROM world_model_attributes WHERE user_id = v_user_id),
        total_attributes = (SELECT COUNT(*) FROM world_model_attributes WHERE user_id = v_user_id),
        last_active_at = NOW(),
        updated_at = NOW();
    
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for user index updates
DROP TRIGGER IF EXISTS trg_update_user_index ON world_model_attributes;
CREATE TRIGGER trg_update_user_index
    AFTER INSERT OR UPDATE OR DELETE ON world_model_attributes
    FOR EACH ROW EXECUTE FUNCTION update_user_index_on_attribute_change();

-- ============================================================================
-- UPDATE TRIGGERS FOR TIMESTAMPS
-- ============================================================================

DROP TRIGGER IF EXISTS update_domain_registry_updated_at ON domain_registry;
CREATE TRIGGER update_domain_registry_updated_at
    BEFORE UPDATE ON domain_registry
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_world_model_index_v2_updated_at ON world_model_index_v2;
CREATE TRIGGER update_world_model_index_v2_updated_at
    BEFORE UPDATE ON world_model_index_v2
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- RPC FUNCTION: Get User World Model Metadata
-- ============================================================================
-- Returns UI-ready metadata about a user's world model

CREATE OR REPLACE FUNCTION get_user_world_model_metadata(p_user_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_result JSONB;
BEGIN
    SELECT jsonb_build_object(
        'user_id', p_user_id,
        'domains', COALESCE((
            SELECT jsonb_agg(
                jsonb_build_object(
                    'key', dr.domain_key,
                    'display_name', dr.display_name,
                    'icon', dr.icon_name,
                    'color', dr.color_hex,
                    'attribute_count', (
                        SELECT COUNT(*) 
                        FROM world_model_attributes wma 
                        WHERE wma.user_id = p_user_id AND wma.domain = dr.domain_key
                    ),
                    'last_updated', (
                        SELECT MAX(updated_at) 
                        FROM world_model_attributes wma 
                        WHERE wma.user_id = p_user_id AND wma.domain = dr.domain_key
                    )
                )
            )
            FROM domain_registry dr
            WHERE dr.domain_key = ANY(
                SELECT DISTINCT domain FROM world_model_attributes WHERE user_id = p_user_id
            )
        ), '[]'::jsonb),
        'total_attributes', COALESCE((
            SELECT COUNT(*) FROM world_model_attributes WHERE user_id = p_user_id
        ), 0),
        'available_domains', COALESCE((
            SELECT array_agg(DISTINCT domain) FROM world_model_attributes WHERE user_id = p_user_id
        ), ARRAY[]::TEXT[]),
        'last_updated', (
            SELECT MAX(updated_at) FROM world_model_attributes WHERE user_id = p_user_id
        )
    ) INTO v_result;
    
    RETURN v_result;
END;
$$;

-- ============================================================================
-- RPC FUNCTION: Auto-register Domain
-- ============================================================================
-- Registers a new domain if it doesn't exist, returns domain info

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
    -- Generate display name if not provided
    v_display_name := COALESCE(p_display_name, INITCAP(REPLACE(p_domain_key, '_', ' ')));
    
    -- Insert or get existing domain
    INSERT INTO domain_registry (domain_key, display_name, icon_name, color_hex)
    VALUES (p_domain_key, v_display_name, p_icon_name, p_color_hex)
    ON CONFLICT (domain_key) DO NOTHING;
    
    -- Return domain info
    SELECT jsonb_build_object(
        'domain_key', domain_key,
        'display_name', display_name,
        'icon_name', icon_name,
        'color_hex', color_hex,
        'attribute_count', attribute_count,
        'user_count', user_count
    ) INTO v_result
    FROM domain_registry
    WHERE domain_key = p_domain_key;
    
    RETURN v_result;
END;
$$;
