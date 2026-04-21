CREATE TABLE IF NOT EXISTS ai_insight_feedback (
    feedback_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    stock TEXT NOT NULL,
    insight TEXT NOT NULL,
    confidence NUMERIC(5, 4) NOT NULL
        CHECK (confidence >= 0 AND confidence <= 1),
    rating TEXT NOT NULL
        CHECK (rating IN ('up', 'down')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_insight_feedback_user_created
    ON ai_insight_feedback(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_insight_feedback_stock_created
    ON ai_insight_feedback(stock, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_insight_feedback_stock_rating
    ON ai_insight_feedback(stock, rating);
