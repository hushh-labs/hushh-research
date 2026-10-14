-- Provider accounting contains no identifiers, queries, sources, or findings.
CREATE TABLE IF NOT EXISTS pwm_provider_budget (
    provider TEXT NOT NULL CHECK (provider = 'tavily'),
    month DATE NOT NULL,
    credits INTEGER NOT NULL CHECK (credits BETWEEN 0 AND 900),
    PRIMARY KEY (provider, month)
);
COMMENT ON TABLE pwm_provider_budget IS 'Aggregate PWM free-tier credit ceiling; no personal information. Retain monthly counts for cost accounting.';
