-- ============================================================================
-- Migration 007: Renaissance Investable Universe
-- Stores the Renaissance AI Fund's investable stock universe with tiers
-- ============================================================================

-- Renaissance Universe Table
CREATE TABLE IF NOT EXISTS renaissance_universe (
    id SERIAL PRIMARY KEY,
    ticker TEXT NOT NULL UNIQUE,
    company_name TEXT NOT NULL,
    sector TEXT NOT NULL,
    tier TEXT NOT NULL CHECK (tier IN ('ACE', 'KING', 'QUEEN', 'JACK')),
    fcf_billions NUMERIC(10,2),           -- 2024 Free Cash Flow in billions
    investment_thesis TEXT,                -- Why investable
    tier_rank INTEGER,                     -- Rank within tier (1 = best)
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_renaissance_tier ON renaissance_universe(tier);
CREATE INDEX IF NOT EXISTS idx_renaissance_sector ON renaissance_universe(sector);
CREATE INDEX IF NOT EXISTS idx_renaissance_fcf ON renaissance_universe(fcf_billions DESC);

-- Trigger for updated_at
DROP TRIGGER IF EXISTS update_renaissance_universe_updated_at ON renaissance_universe;
CREATE TRIGGER update_renaissance_universe_updated_at
    BEFORE UPDATE ON renaissance_universe
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- RPC Function: Check if ticker is in Renaissance Universe
-- ============================================================================
CREATE OR REPLACE FUNCTION is_renaissance_investable(p_ticker TEXT)
RETURNS JSONB
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_result JSONB;
BEGIN
    SELECT jsonb_build_object(
        'is_investable', TRUE,
        'ticker', ticker,
        'company', company_name,
        'tier', tier,
        'sector', sector,
        'fcf_billions', fcf_billions,
        'thesis', investment_thesis
    ) INTO v_result
    FROM renaissance_universe
    WHERE UPPER(ticker) = UPPER(p_ticker);
    
    IF v_result IS NULL THEN
        RETURN jsonb_build_object(
            'is_investable', FALSE,
            'ticker', UPPER(p_ticker),
            'message', 'Not in Renaissance investable universe'
        );
    END IF;
    
    RETURN v_result;
END;
$$;

-- ============================================================================
-- RPC Function: Get stocks by tier
-- ============================================================================
CREATE OR REPLACE FUNCTION get_renaissance_by_tier(p_tier TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    RETURN (
        SELECT jsonb_agg(
            jsonb_build_object(
                'ticker', ticker,
                'company', company_name,
                'sector', sector,
                'tier', tier,
                'fcf_billions', fcf_billions,
                'thesis', investment_thesis
            ) ORDER BY fcf_billions DESC NULLS LAST
        )
        FROM renaissance_universe
        WHERE p_tier IS NULL OR UPPER(tier) = UPPER(p_tier)
    );
END;
$$;

-- ============================================================================
-- SEED DATA: Renaissance Investable Universe
-- ============================================================================

-- ACE Tier (Top 30)
INSERT INTO renaissance_universe (ticker, company_name, sector, tier, fcf_billions, investment_thesis, tier_rank) VALUES
('AAPL', 'Apple Inc', 'Technology', 'ACE', 108.8, 'Largest FCF generator, ecosystem moat', 1),
('MSFT', 'Microsoft Corp', 'Technology', 'ACE', 74.1, 'Cloud + AI dominance, recurring revenue', 2),
('GOOGL', 'Alphabet Inc', 'Technology', 'ACE', 72, 'Search monopoly, YouTube, Cloud growth', 3),
('NVDA', 'NVIDIA Corp', 'Semiconductors', 'ACE', 60.9, 'AI chip monopoly, 125% FCF growth', 4),
('META', 'Meta Platforms', 'Technology', 'ACE', 54.1, 'Social monopoly, AI investments', 5),
('AMZN', 'Amazon.com', 'Technology', 'ACE', 36.8, 'AWS + e-commerce dominance', 7),
('BRK.B', 'Berkshire Hathaway', 'Financials', 'ACE', 32, 'Permanent capital, Buffett', 8),
('XOM', 'Exxon Mobil', 'Energy', 'ACE', 36.1, 'Integrated oil major, discipline', 9),
('TSM', 'Taiwan Semiconductor', 'Semiconductors', 'ACE', 27.9, 'Foundry monopoly, AI beneficiary', 10),
('AVGO', 'Broadcom Inc', 'Semiconductors', 'ACE', 24.9, 'Connectivity chips + VMware', 11),
('UNH', 'UnitedHealth Group', 'Healthcare', 'ACE', 24.9, 'Healthcare vertical integration', 12),
('V', 'Visa Inc', 'Payments', 'ACE', 21.6, 'Payment network duopoly', 13),
('CVX', 'Chevron Corp', 'Energy', 'ACE', 21.4, 'Integrated oil major', 14),
('JNJ', 'Johnson & Johnson', 'Healthcare', 'ACE', 19.8, 'Pharma + MedTech diversified', 15),
('PG', 'Procter & Gamble', 'Consumer Staples', 'ACE', 16.8, 'Brand portfolio, pricing power', 16),
('HD', 'Home Depot', 'Retail', 'ACE', 15.1, 'Home improvement duopoly', 17),
('JPM', 'JPMorgan Chase', 'Financials', 'ACE', 15, 'Best-in-class bank', 18),
('MA', 'Mastercard Inc', 'Payments', 'ACE', 13.6, 'Payment network duopoly', 19),
('NVO', 'Novo Nordisk', 'Healthcare', 'ACE', 12.5, 'GLP-1 obesity/diabetes drugs', 20),
('CRM', 'Salesforce', 'Software', 'ACE', 12.4, 'CRM leader, AI integration', 21),
('ORCL', 'Oracle Corp', 'Software', 'ACE', 11.8, 'Database + cloud transition', 22),
('KO', 'Coca-Cola', 'Consumer Staples', 'ACE', 9.5, 'Global beverage brand', 23),
('PEP', 'PepsiCo', 'Consumer Staples', 'ACE', 8.9, 'Beverage + snacks diversified', 24),
('MCD', 'McDonalds Corp', 'Consumer', 'ACE', 8.1, 'Global QSR franchise model', 25),
('LLY', 'Eli Lilly', 'Healthcare', 'ACE', 8, 'GLP-1 leader, pipeline', 26),
('COST', 'Costco', 'Retail', 'ACE', 7.8, 'Membership model, loyalty', 27),
('NFLX', 'Netflix Inc', 'Media', 'ACE', 6.9, 'Streaming leader, FCF positive', 28),
('TMO', 'Thermo Fisher', 'Healthcare', 'ACE', 6.5, 'Life sciences tools leader', 29),
('ABT', 'Abbott Labs', 'Healthcare', 'ACE', 6.3, 'MedTech diversified', 30)
ON CONFLICT (ticker) DO UPDATE SET
    company_name = EXCLUDED.company_name,
    sector = EXCLUDED.sector,
    tier = EXCLUDED.tier,
    fcf_billions = EXCLUDED.fcf_billions,
    investment_thesis = EXCLUDED.investment_thesis,
    tier_rank = EXCLUDED.tier_rank,
    updated_at = NOW();

-- KING Tier
INSERT INTO renaissance_universe (ticker, company_name, sector, tier, fcf_billions, investment_thesis, tier_rank) VALUES
('ADBE', 'Adobe Inc', 'Software', 'KING', 7.9, 'Creative/PDF monopoly', 1),
('CSCO', 'Cisco Systems', 'Technology', 'KING', 12.8, 'Networking infrastructure', 2),
('ACN', 'Accenture', 'Services', 'KING', 9.2, 'IT consulting leader', 3),
('QCOM', 'Qualcomm', 'Semiconductors', 'KING', 10.5, 'Mobile chip leader', 4),
('TXN', 'Texas Instruments', 'Semiconductors', 'KING', 6.1, 'Analog chips, manufacturing', 5),
('NOW', 'ServiceNow', 'Software', 'KING', 3.8, 'Enterprise workflow automation', 6),
('INTU', 'Intuit Inc', 'Software', 'KING', 5.8, 'Tax/accounting software', 7),
('AMD', 'Advanced Micro Devices', 'Semiconductors', 'KING', 1.5, 'CPU/GPU competition', 8),
('AMAT', 'Applied Materials', 'Semiconductors', 'KING', 7.2, 'Chip equipment leader', 9),
('LRCX', 'Lam Research', 'Semiconductors', 'KING', 4.8, 'Etch equipment leader', 10),
('KLAC', 'KLA Corp', 'Semiconductors', 'KING', 3.5, 'Process control leader', 11),
('ASML', 'ASML Holding', 'Semiconductors', 'KING', 8.5, 'EUV lithography monopoly', 12),
('WMT', 'Walmart Inc', 'Retail', 'KING', 15.5, 'Retail scale, e-commerce growth', 13),
('LOW', 'Lowes Companies', 'Retail', 'KING', 7.2, 'Home improvement #2', 14),
('TJX', 'TJX Companies', 'Retail', 'KING', 4.5, 'Off-price retail leader', 15),
('NKE', 'Nike Inc', 'Consumer', 'KING', 4.8, 'Athletic brand leader', 16),
('SBUX', 'Starbucks', 'Consumer', 'KING', 3.2, 'Global coffee brand', 17),
('PFE', 'Pfizer Inc', 'Healthcare', 'KING', 8.5, 'Big pharma, diversified', 18),
('MRK', 'Merck & Co', 'Healthcare', 'KING', 12.8, 'Keytruda franchise', 19),
('ABBV', 'AbbVie Inc', 'Healthcare', 'KING', 22.3, 'Immunology + aesthetics', 20),
('BMY', 'Bristol-Myers Squibb', 'Healthcare', 'KING', 13.5, 'Oncology pipeline', 21),
('AMGN', 'Amgen Inc', 'Healthcare', 'KING', 10.8, 'Biotech leader, obesity drug', 22),
('GILD', 'Gilead Sciences', 'Healthcare', 'KING', 7.8, 'HIV franchise, oncology', 23),
('DHR', 'Danaher Corp', 'Healthcare', 'KING', 6.2, 'Life sciences tools', 24),
('ISRG', 'Intuitive Surgical', 'Healthcare', 'KING', 2.1, 'Surgical robotics monopoly', 25),
('SYK', 'Stryker Corp', 'Healthcare', 'KING', 3.2, 'MedTech leader', 26),
('MDT', 'Medtronic', 'Healthcare', 'KING', 5.5, 'MedTech diversified', 27),
('VRTX', 'Vertex Pharma', 'Healthcare', 'KING', 4.2, 'CF monopoly, pipeline', 28),
('REGN', 'Regeneron', 'Healthcare', 'KING', 5.5, 'Eylea, Dupixent', 29),
('BAC', 'Bank of America', 'Financials', 'KING', 8.5, 'Scale bank, Buffett holding', 30),
('WFC', 'Wells Fargo', 'Financials', 'KING', 5.2, 'Turnaround, rate benefit', 31),
('GS', 'Goldman Sachs', 'Financials', 'KING', 6.8, 'Investment banking leader', 32),
('MS', 'Morgan Stanley', 'Financials', 'KING', 5.5, 'Wealth management pivot', 33),
('SCHW', 'Charles Schwab', 'Financials', 'KING', 4.5, 'Discount brokerage leader', 34),
('BLK', 'BlackRock', 'Financials', 'KING', 5.2, 'Asset management leader', 35),
('SPGI', 'S&P Global', 'Financials', 'KING', 4.8, 'Ratings + data duopoly', 36),
('MCO', 'Moodys Corp', 'Financials', 'KING', 2.5, 'Ratings duopoly', 37),
('ICE', 'Intercontinental Exchange', 'Financials', 'KING', 3.2, 'Exchange/data infrastructure', 38),
('CME', 'CME Group', 'Financials', 'KING', 3.5, 'Derivatives exchange', 39),
('AON', 'Aon plc', 'Insurance', 'KING', 2.8, 'Insurance broker #2', 40),
('MMC', 'Marsh McLennan', 'Insurance', 'KING', 3.5, 'Insurance broker #1', 41)
ON CONFLICT (ticker) DO UPDATE SET
    company_name = EXCLUDED.company_name,
    sector = EXCLUDED.sector,
    tier = EXCLUDED.tier,
    fcf_billions = EXCLUDED.fcf_billions,
    investment_thesis = EXCLUDED.investment_thesis,
    tier_rank = EXCLUDED.tier_rank,
    updated_at = NOW();

-- QUEEN Tier
INSERT INTO renaissance_universe (ticker, company_name, sector, tier, fcf_billions, investment_thesis, tier_rank) VALUES
('AXP', 'American Express', 'Financials', 'QUEEN', 8.2, 'Premium card network', 1),
('COF', 'Capital One', 'Financials', 'QUEEN', 4.5, 'Credit card + banking', 2),
('USB', 'U.S. Bancorp', 'Financials', 'QUEEN', 3.5, 'Regional bank leader', 3),
('PNC', 'PNC Financial', 'Financials', 'QUEEN', 4.2, 'Regional bank leader', 4),
('TRV', 'Travelers', 'Insurance', 'QUEEN', 3.8, 'P&C insurance leader', 5),
('CB', 'Chubb Ltd', 'Insurance', 'QUEEN', 5.5, 'Global P&C leader', 6),
('AIG', 'American Intl Group', 'Insurance', 'QUEEN', 2.5, 'P&C turnaround', 7),
('MET', 'MetLife', 'Insurance', 'QUEEN', 3.2, 'Life insurance leader', 8),
('PRU', 'Prudential Financial', 'Insurance', 'QUEEN', 2.8, 'Life/retirement', 9),
('AFL', 'Aflac Inc', 'Insurance', 'QUEEN', 2.5, 'Supplemental insurance', 10),
('UNP', 'Union Pacific', 'Industrials', 'QUEEN', 6.8, 'Railroad duopoly', 11),
('CSX', 'CSX Corp', 'Industrials', 'QUEEN', 3.5, 'Eastern railroad', 12),
('NSC', 'Norfolk Southern', 'Industrials', 'QUEEN', 2.8, 'Eastern railroad', 13),
('CAT', 'Caterpillar', 'Industrials', 'QUEEN', 10.8, 'Heavy equipment leader', 14),
('DE', 'Deere & Company', 'Industrials', 'QUEEN', 6.5, 'Ag equipment leader', 15),
('HON', 'Honeywell', 'Industrials', 'QUEEN', 5.5, 'Diversified industrial', 16),
('RTX', 'RTX Corp', 'Industrials', 'QUEEN', 5.2, 'Aerospace/defense', 17),
('LMT', 'Lockheed Martin', 'Industrials', 'QUEEN', 6.2, 'Defense prime', 18),
('GE', 'GE Aerospace', 'Industrials', 'QUEEN', 5.8, 'Aviation engines', 19),
('GD', 'General Dynamics', 'Industrials', 'QUEEN', 3.5, 'Defense diversified', 20),
('NOC', 'Northrop Grumman', 'Industrials', 'QUEEN', 2.8, 'Defense prime', 21),
('LHX', 'L3Harris Tech', 'Industrials', 'QUEEN', 2.2, 'Defense electronics', 22),
('UBER', 'Uber Technologies', 'Technology', 'QUEEN', 6.9, 'Mobility platform', 23),
('ABNB', 'Airbnb Inc', 'Technology', 'QUEEN', 4.5, 'Travel platform', 24),
('BKNG', 'Booking Holdings', 'Technology', 'QUEEN', 7.2, 'Online travel leader', 25),
('WDAY', 'Workday Inc', 'Software', 'QUEEN', 1.8, 'HCM/Finance SaaS', 26),
('PANW', 'Palo Alto Networks', 'Software', 'QUEEN', 2.5, 'Cybersecurity leader', 27),
('SNPS', 'Synopsys Inc', 'Software', 'QUEEN', 1.8, 'EDA software leader', 28),
('CDNS', 'Cadence Design', 'Software', 'QUEEN', 1.5, 'EDA software leader', 29),
('ADSK', 'Autodesk Inc', 'Software', 'QUEEN', 1.5, 'CAD software leader', 31),
('MRVL', 'Marvell Technology', 'Semiconductors', 'QUEEN', 1.2, 'Data center chips', 32),
('MU', 'Micron Technology', 'Semiconductors', 'QUEEN', 3.5, 'Memory leader', 33),
('NXPI', 'NXP Semiconductors', 'Semiconductors', 'QUEEN', 2.5, 'Auto/IoT chips', 34),
('ADI', 'Analog Devices', 'Semiconductors', 'QUEEN', 3.8, 'Analog/mixed signal', 35),
('ON', 'ON Semiconductor', 'Semiconductors', 'QUEEN', 1.8, 'Auto/industrial chips', 36)
ON CONFLICT (ticker) DO UPDATE SET
    company_name = EXCLUDED.company_name,
    sector = EXCLUDED.sector,
    tier = EXCLUDED.tier,
    fcf_billions = EXCLUDED.fcf_billions,
    investment_thesis = EXCLUDED.investment_thesis,
    tier_rank = EXCLUDED.tier_rank,
    updated_at = NOW();

-- JACK Tier
INSERT INTO renaissance_universe (ticker, company_name, sector, tier, fcf_billions, investment_thesis, tier_rank) VALUES
('ZTS', 'Zoetis Inc', 'Healthcare', 'JACK', 2.5, 'Animal health leader', 1),
('EL', 'Estee Lauder', 'Consumer', 'JACK', 1.5, 'Prestige beauty leader', 2),
('CL', 'Colgate-Palmolive', 'Consumer Staples', 'JACK', 3.2, 'Oral care leader', 3),
('GIS', 'General Mills', 'Consumer Staples', 'JACK', 2.8, 'Packaged food leader', 4),
('K', 'Kellanova', 'Consumer Staples', 'JACK', 1.5, 'Snacks focused', 5),
('HSY', 'Hershey Company', 'Consumer Staples', 'JACK', 1.8, 'Confectionery leader', 6),
('MDLZ', 'Mondelez Intl', 'Consumer Staples', 'JACK', 3.5, 'Global snacks', 7),
('SJM', 'JM Smucker', 'Consumer Staples', 'JACK', 1.2, 'Coffee/pet food', 8),
('CLX', 'Clorox Company', 'Consumer Staples', 'JACK', 0.8, 'Cleaning products', 9),
('KMB', 'Kimberly-Clark', 'Consumer Staples', 'JACK', 2.5, 'Personal care', 10),
('EW', 'Edwards Lifesciences', 'Healthcare', 'JACK', 1.2, 'Heart valves leader', 11),
('BSX', 'Boston Scientific', 'Healthcare', 'JACK', 2.2, 'MedTech diversified', 12),
('GEHC', 'GE HealthCare', 'Healthcare', 'JACK', 1.8, 'Imaging equipment', 13),
('A', 'Agilent Technologies', 'Healthcare', 'JACK', 1.5, 'Life sciences tools', 14),
('ILMN', 'Illumina Inc', 'Healthcare', 'JACK', 0.5, 'Genomics sequencing', 15),
('IQV', 'IQVIA Holdings', 'Healthcare', 'JACK', 1.8, 'Clinical research', 16),
('WAT', 'Waters Corp', 'Healthcare', 'JACK', 0.6, 'Analytical instruments', 17),
('MTD', 'Mettler-Toledo', 'Healthcare', 'JACK', 0.8, 'Precision instruments', 18),
('ECL', 'Ecolab Inc', 'Industrials', 'JACK', 1.8, 'Water/hygiene leader', 19),
('SHW', 'Sherwin-Williams', 'Industrials', 'JACK', 2.5, 'Paint leader', 20),
('APD', 'Air Products', 'Industrials', 'JACK', 2.8, 'Industrial gases', 21),
('LIN', 'Linde plc', 'Industrials', 'JACK', 6.5, 'Industrial gases leader', 22),
('ITW', 'Illinois Tool Works', 'Industrials', 'JACK', 2.8, 'Diversified manufacturing', 23),
('EMR', 'Emerson Electric', 'Industrials', 'JACK', 2.5, 'Automation leader', 24),
('ROK', 'Rockwell Automation', 'Industrials', 'JACK', 1.2, 'Factory automation', 25),
('ETN', 'Eaton Corp', 'Industrials', 'JACK', 3.2, 'Power management', 26),
('PH', 'Parker Hannifin', 'Industrials', 'JACK', 2.2, 'Motion control', 27),
('AME', 'AMETEK Inc', 'Industrials', 'JACK', 1.5, 'Electronic instruments', 28),
('FTV', 'Fortive Corp', 'Industrials', 'JACK', 1.2, 'Industrial tech', 29),
('VRSK', 'Verisk Analytics', 'Technology', 'JACK', 1.2, 'Insurance analytics', 30),
('CPRT', 'Copart Inc', 'Industrials', 'JACK', 1.5, 'Auto auctions', 31),
('FAST', 'Fastenal Company', 'Industrials', 'JACK', 0.8, 'Industrial distribution', 32),
('GWW', 'W.W. Grainger', 'Industrials', 'JACK', 1.5, 'MRO distribution', 33),
('WST', 'West Pharma Services', 'Healthcare', 'JACK', 0.8, 'Drug delivery', 34),
('IDXX', 'IDEXX Laboratories', 'Healthcare', 'JACK', 0.6, 'Veterinary diagnostics', 35),
('BIO', 'Bio-Rad Labs', 'Healthcare', 'JACK', 0.4, 'Life sciences research', 36),
('RVTY', 'Revvity Inc', 'Healthcare', 'JACK', 0.5, 'Diagnostics/life sciences', 37),
('TYL', 'Tyler Technologies', 'Software', 'JACK', 0.4, 'Government software', 38),
('PAYC', 'Paycom Software', 'Software', 'JACK', 0.3, 'HCM software', 39),
('PAYX', 'Paychex Inc', 'Software', 'JACK', 1.5, 'Payroll services', 40),
('ADP', 'Automatic Data', 'Software', 'JACK', 3.5, 'HR/payroll leader', 41),
('FI', 'Fiserv Inc', 'Fintech', 'JACK', 4.5, 'Payment processing', 42),
('FIS', 'Fidelity National', 'Fintech', 'JACK', 3.8, 'Banking technology', 43),
('GPN', 'Global Payments', 'Fintech', 'JACK', 2.5, 'Payment processing', 44)
ON CONFLICT (ticker) DO UPDATE SET
    company_name = EXCLUDED.company_name,
    sector = EXCLUDED.sector,
    tier = EXCLUDED.tier,
    fcf_billions = EXCLUDED.fcf_billions,
    investment_thesis = EXCLUDED.investment_thesis,
    tier_rank = EXCLUDED.tier_rank,
    updated_at = NOW();

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================
SELECT 'Renaissance Universe migration complete! ' || COUNT(*) || ' stocks loaded.' as status
FROM renaissance_universe;
