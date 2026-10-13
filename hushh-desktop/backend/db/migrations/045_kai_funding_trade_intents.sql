-- One-click funding + trading orchestration state.

CREATE TABLE IF NOT EXISTS kai_funding_trade_intents (
    intent_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES vault_keys(user_id) ON DELETE CASCADE,
    transfer_id TEXT REFERENCES kai_funding_transfers(transfer_id) ON DELETE SET NULL,
    alpaca_account_id TEXT NOT NULL,
    funding_item_id TEXT NOT NULL REFERENCES kai_funding_plaid_items(item_id) ON DELETE RESTRICT,
    funding_account_id TEXT NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL DEFAULT 'buy'
        CHECK (side IN ('buy', 'sell')),
    order_type TEXT NOT NULL DEFAULT 'market'
        CHECK (order_type IN ('market', 'limit')),
    time_in_force TEXT NOT NULL DEFAULT 'day'
        CHECK (time_in_force IN ('day', 'gtc', 'opg', 'cls', 'ioc', 'fok')),
    notional_usd NUMERIC(18, 2),
    quantity NUMERIC(20, 8),
    limit_price NUMERIC(18, 6),
    status TEXT NOT NULL DEFAULT 'funding_pending'
        CHECK (
            status IN (
                'queued',
                'funding_pending',
                'ready_to_trade',
                'order_submitted',
                'order_partially_filled',
                'order_filled',
                'order_canceled',
                'failed'
            )
        ),
    order_id TEXT,
    idempotency_key TEXT NOT NULL,
    request_payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    transfer_snapshot_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    order_payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    failure_code TEXT,
    failure_message TEXT,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    executed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, idempotency_key),
    CHECK ((notional_usd IS NOT NULL) OR (quantity IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_kai_funding_trade_intents_user
    ON kai_funding_trade_intents(user_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_kai_funding_trade_intents_transfer
    ON kai_funding_trade_intents(transfer_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_kai_funding_trade_intents_status
    ON kai_funding_trade_intents(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS kai_funding_trade_events (
    event_id TEXT PRIMARY KEY,
    intent_id TEXT NOT NULL REFERENCES kai_funding_trade_intents(intent_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES vault_keys(user_id) ON DELETE CASCADE,
    event_source TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_status TEXT,
    reason_code TEXT,
    reason_message TEXT,
    payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kai_funding_trade_events_intent
    ON kai_funding_trade_events(intent_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_kai_funding_trade_events_user
    ON kai_funding_trade_events(user_id, occurred_at DESC);
