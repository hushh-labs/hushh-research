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
    domain world_model_domain NOT NULL,
    attribute_key TEXT NOT NULL,
    
    -- Encrypted Value (BYOK)
    ciphertext TEXT NOT NULL,
    iv TEXT NOT NULL,
    tag TEXT NOT NULL,
    algorithm TEXT DEFAULT 'aes-256-gcm',
    
    -- Metadata
    source attribute_source NOT NULL,
    confidence DECIMAL(3,2),
    inferred_at TIMESTAMPTZ,
    
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
    updated_at TIMESTAMPTZ DEFAULT NOW()
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
