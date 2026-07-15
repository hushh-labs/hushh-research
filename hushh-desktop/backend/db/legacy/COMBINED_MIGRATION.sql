-- ============================================================================
-- COMBINED MIGRATION: 003 + 004
-- Run this in Supabase SQL Editor to set up all required tables
-- ============================================================================

-- ============================================================================
-- Migration 003: World Model + Chat Tables with pgvector
-- Agent Kai Revamp - Unified User Data Model
-- ============================================================================

-- Enable pgvector extension for embeddings
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================================
-- WORLD MODEL INDEX (Queryable Layer - Non-Sensitive)
-- ============================================================================
CREATE TABLE IF NOT EXISTS world_model_index (
    user_id TEXT PRIMARY KEY REFERENCES vault_keys(user_id) ON DELETE CASCADE,
    
    -- Financial Profile (bucketed for privacy)
    risk_bucket TEXT CHECK (risk_bucket IN ('conservative', 'balanced', 'aggressive')),
    investment_horizon TEXT CHECK (investment_horizon IN ('short', 'medium', 'long', 'very_long')),
    portfolio_size_bucket TEXT CHECK (portfolio_size_bucket IN ('starter', 'growing', 'established', 'affluent', 'hnw')),
    
    -- Lifestyle Tags (inferred, not PII)
    lifestyle_tags TEXT[],
    interest_categories TEXT[],
    
    -- Activity Metrics
    activity_score DECIMAL(3,2),
    last_active_at TIMESTAMPTZ,
    
    -- Model Metadata
    model_version INTEGER DEFAULT 1,
    confidence_score DECIMAL(3,2),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- WORLD MODEL ATTRIBUTES (Encrypted Layer - BYOK)
-- ============================================================================
DO $$ BEGIN
    CREATE TYPE world_model_domain AS ENUM (
        'financial', 'lifestyle', 'professional', 'interests', 'behavioral'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE attribute_source AS ENUM (
        'explicit', 'inferred', 'imported', 'computed'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS world_model_attributes (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES vault_keys(user_id) ON DELETE CASCADE,
    domain TEXT NOT NULL,  -- Changed from enum to TEXT for dynamic domains
    attribute_key TEXT NOT NULL,
    
    -- Encrypted Value (BYOK)
    ciphertext TEXT NOT NULL,
    iv TEXT NOT NULL,
    tag TEXT NOT NULL,
    algorithm TEXT DEFAULT 'aes-256-gcm',
    
    -- Metadata
    source TEXT NOT NULL DEFAULT 'explicit',
    confidence DECIMAL(3,2),
    inferred_at TIMESTAMPTZ,
    display_name TEXT,
    data_type TEXT DEFAULT 'string',
    
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(user_id, domain, attribute_key)
);

-- ============================================================================
-- WORLD MODEL EMBEDDINGS (pgvector on Supabase)
-- ============================================================================
DO $$ BEGIN
    CREATE TYPE embedding_type AS ENUM (
        'financial_profile', 'lifestyle_profile', 'interest_profile', 'composite'
    );
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS world_model_embeddings (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES vault_keys(user_id) ON DELETE CASCADE,
    embedding_type embedding_type NOT NULL,
    embedding_vector vector(384),  -- all-MiniLM-L6-v2 dimension
    model_name TEXT DEFAULT 'all-MiniLM-L6-v2',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, embedding_type)
);

-- HNSW Index for fast similarity search
CREATE INDEX IF NOT EXISTS idx_wme_vector ON world_model_embeddings 
USING hnsw (embedding_vector vector_cosine_ops);

-- ============================================================================
-- CHAT CONVERSATIONS (Persistent History)
-- ============================================================================
CREATE TABLE IF NOT EXISTS chat_conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL REFERENCES vault_keys(user_id) ON DELETE CASCADE,
    title TEXT,
    agent_context JSONB,  -- Current session state
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
    content TEXT NOT NULL,
    content_type TEXT DEFAULT 'text',  -- 'text', 'component', 'tool_use'
    
    -- For insertable components
    component_type TEXT,  -- 'analysis', 'portfolio_import', 'decision_card', etc.
    component_data JSONB,
    
    -- Metadata
    tokens_used INTEGER,
    model_used TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- PORTFOLIO HOLDINGS (Encrypted)
-- ============================================================================
CREATE TABLE IF NOT EXISTS vault_portfolios (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES vault_keys(user_id) ON DELETE CASCADE,
    portfolio_name TEXT DEFAULT 'Main Portfolio',
    
    -- Encrypted holdings array
    holdings_ciphertext TEXT NOT NULL,
    holdings_iv TEXT NOT NULL,
    holdings_tag TEXT NOT NULL,
    algorithm TEXT DEFAULT 'aes-256-gcm',
    
    -- Metadata (unencrypted for display)
    total_value_usd NUMERIC,
    holdings_count INTEGER,
    source TEXT,  -- 'manual', 'csv', 'pdf_schwab', 'plaid'
    
    last_imported_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    UNIQUE(user_id, portfolio_name)
);

-- ============================================================================
-- INDEXES
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_wmi_risk ON world_model_index(risk_bucket);
CREATE INDEX IF NOT EXISTS idx_wmi_lifestyle ON world_model_index USING GIN(lifestyle_tags);
CREATE INDEX IF NOT EXISTS idx_wma_user ON world_model_attributes(user_id);
CREATE INDEX IF NOT EXISTS idx_wma_domain ON world_model_attributes(domain);
CREATE INDEX IF NOT EXISTS idx_chat_conv_user ON chat_conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_msg_conv ON chat_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_chat_msg_created ON chat_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_portfolio_user ON vault_portfolios(user_id);

-- ============================================================================
-- SIMILARITY SEARCH RPC FUNCTION
-- ============================================================================
CREATE OR REPLACE FUNCTION match_user_profiles(
    query_embedding vector(384),
    embedding_type_filter embedding_type,
    match_threshold float DEFAULT 0.7,
    match_count int DEFAULT 10
)
RETURNS TABLE (
    user_id text,
    similarity float
)
LANGUAGE sql STABLE
AS $$
    SELECT
        user_id,
        1 - (embedding_vector <=> query_embedding) as similarity
    FROM world_model_embeddings
    WHERE embedding_type = embedding_type_filter
      AND 1 - (embedding_vector <=> query_embedding) > match_threshold
    ORDER BY embedding_vector <=> query_embedding
    LIMIT match_count;
$$;

-- ============================================================================
-- UPDATE TRIGGERS
-- ============================================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_world_model_index_updated_at ON world_model_index;
CREATE TRIGGER update_world_model_index_updated_at
    BEFORE UPDATE ON world_model_index
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_world_model_attributes_updated_at ON world_model_attributes;
CREATE TRIGGER update_world_model_attributes_updated_at
    BEFORE UPDATE ON world_model_attributes
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_chat_conversations_updated_at ON chat_conversations;
CREATE TRIGGER update_chat_conversations_updated_at
    BEFORE UPDATE ON chat_conversations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_vault_portfolios_updated_at ON vault_portfolios;
CREATE TRIGGER update_vault_portfolios_updated_at
    BEFORE UPDATE ON vault_portfolios
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- Migration 004: Dynamic Domain Registry + World Model Index v2
-- ============================================================================

-- ============================================================================
-- DOMAIN REGISTRY (Dynamic Domain Discovery)
-- ============================================================================
CREATE TABLE IF NOT EXISTS domain_registry (
    domain_key TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    description TEXT,
    icon_name TEXT,
    color_hex TEXT,
    parent_domain TEXT REFERENCES domain_registry(domain_key),
    attribute_count INTEGER DEFAULT 0,
    user_count INTEGER DEFAULT 0,
    first_seen_at TIMESTAMPTZ DEFAULT NOW(),
    last_updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_domain_parent ON domain_registry(parent_domain);

-- ============================================================================
-- WORLD MODEL INDEX v2 (Dynamic JSONB-based)
-- ============================================================================
CREATE TABLE IF NOT EXISTS world_model_index_v2 (
    user_id TEXT PRIMARY KEY REFERENCES vault_keys(user_id) ON DELETE CASCADE,
    domain_summaries JSONB DEFAULT '{}',
    available_domains TEXT[] DEFAULT '{}',
    computed_tags TEXT[] DEFAULT '{}',
    activity_score DECIMAL(3,2),
    last_active_at TIMESTAMPTZ,
    total_attributes INTEGER DEFAULT 0,
    model_version INTEGER DEFAULT 2,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wmi2_domains ON world_model_index_v2 USING GIN(domain_summaries);
CREATE INDEX IF NOT EXISTS idx_wmi2_available ON world_model_index_v2 USING GIN(available_domains);
CREATE INDEX IF NOT EXISTS idx_wmi2_tags ON world_model_index_v2 USING GIN(computed_tags);

-- ============================================================================
-- SEED DEFAULT DOMAINS
-- ============================================================================
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
CREATE OR REPLACE FUNCTION update_domain_registry_counts()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE domain_registry 
        SET attribute_count = attribute_count + 1,
            last_updated_at = NOW()
        WHERE domain_key = NEW.domain;
        
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
        UPDATE domain_registry 
        SET attribute_count = GREATEST(0, attribute_count - 1),
            last_updated_at = NOW()
        WHERE domain_key = OLD.domain;
        
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

DROP TRIGGER IF EXISTS trg_update_domain_counts ON world_model_attributes;
CREATE TRIGGER trg_update_domain_counts
    AFTER INSERT OR DELETE ON world_model_attributes
    FOR EACH ROW EXECUTE FUNCTION update_domain_registry_counts();

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

DROP TRIGGER IF EXISTS trg_update_user_index ON world_model_attributes;
CREATE TRIGGER trg_update_user_index
    AFTER INSERT OR UPDATE OR DELETE ON world_model_attributes
    FOR EACH ROW EXECUTE FUNCTION update_user_index_on_attribute_change();

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
    ) INTO v_result
    FROM domain_registry
    WHERE domain_key = p_domain_key;
    
    RETURN v_result;
END;
$$;

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================
SELECT 'Migration complete! Tables created: world_model_index, world_model_attributes, world_model_embeddings, chat_conversations, chat_messages, vault_portfolios, domain_registry, world_model_index_v2' as status;
