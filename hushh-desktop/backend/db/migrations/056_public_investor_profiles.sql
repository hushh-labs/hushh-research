-- Public investor discovery inventory for RIA marketplace.
--
-- This table stores only public/official-source investor discovery records.
-- Rows are discovery-only and must not be treated as Hushh users unless a
-- separate opted-in marketplace_public_profiles row exists.

CREATE TABLE IF NOT EXISTS investor_profiles (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  name_normalized TEXT,
  cik TEXT UNIQUE,
  firm TEXT,
  title TEXT,
  investor_type TEXT NOT NULL DEFAULT 'institutional_investor',
  photo_url TEXT,
  location_hint TEXT,
  business_address JSONB NOT NULL DEFAULT '{}'::jsonb,
  aum_billions NUMERIC,
  top_holdings JSONB NOT NULL DEFAULT '[]'::jsonb,
  sector_exposure JSONB NOT NULL DEFAULT '{}'::jsonb,
  investment_style TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  risk_tolerance TEXT,
  time_horizon TEXT,
  portfolio_turnover TEXT,
  recent_buys TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  recent_sells TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  public_quotes JSONB NOT NULL DEFAULT '[]'::jsonb,
  biography TEXT,
  education TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  board_memberships TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  peer_investors TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  is_insider BOOLEAN NOT NULL DEFAULT FALSE,
  insider_company_ticker TEXT,
  data_sources TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  source_urls TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_13f_date DATE,
  last_form4_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE investor_profiles
  ADD COLUMN IF NOT EXISTS location_hint TEXT,
  ADD COLUMN IF NOT EXISTS business_address JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS source_urls TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS evidence JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_investor_profiles_name ON investor_profiles(name);
CREATE INDEX IF NOT EXISTS idx_investor_profiles_firm ON investor_profiles(firm);
CREATE INDEX IF NOT EXISTS idx_investor_profiles_type ON investor_profiles(investor_type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_investor_profiles_cik_unique ON investor_profiles(cik);
CREATE INDEX IF NOT EXISTS idx_investor_profiles_cik ON investor_profiles(cik) WHERE cik IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_investor_profiles_location_hint ON investor_profiles(location_hint);
CREATE INDEX IF NOT EXISTS idx_investor_profiles_last_13f_date ON investor_profiles(last_13f_date DESC NULLS LAST);

INSERT INTO investor_profiles (
  name,
  name_normalized,
  cik,
  firm,
  title,
  investor_type,
  location_hint,
  business_address,
  investment_style,
  biography,
  data_sources,
  source_urls,
  evidence,
  last_13f_date
) VALUES
  (
    'GATES FOUNDATION TRUST',
    'gatesfoundationtrust',
    '0001166559',
    'Gates Foundation Trust',
    'Public institutional filer',
    'institutional_investor',
    'Kirkland, WA 98033',
    '{"street1":"2365 CARILLON POINT","city":"KIRKLAND","state":"WA","zip":"98033","source":"SEC submissions business address"}'::jsonb,
    ARRAY['public_13f','foundation_trust'],
    'Public institutional investor profile seeded from official SEC EDGAR submissions. SEC records list the business and mailing address in Kirkland, Washington 98033.',
    ARRAY['SEC EDGAR submissions API','SEC Form 13F-HR'],
    ARRAY['https://data.sec.gov/submissions/CIK0001166559.json','https://www.sec.gov/edgar/browse/?CIK=0001166559'],
    '{"confidence":"official_sec_record","latest_known_13f_accession":"0001104659-26-062592"}'::jsonb,
    DATE '2026-05-15'
  ),
  (
    'BERKSHIRE HATHAWAY INC',
    'berkshirehathawayinc',
    '0001067983',
    'Berkshire Hathaway Inc',
    'Public institutional filer',
    'institutional_investor',
    'Omaha, NE 68131',
    '{"street1":"3555 FARNAM STREET","city":"OMAHA","state":"NE","zip":"68131","source":"SEC submissions business address"}'::jsonb,
    ARRAY['public_13f','long_term_value'],
    'Public institutional investor profile seeded from official SEC EDGAR submissions and Form 13F-HR filing context.',
    ARRAY['SEC EDGAR submissions API','SEC Form 13F-HR'],
    ARRAY['https://data.sec.gov/submissions/CIK0001067983.json','https://www.sec.gov/edgar/browse/?CIK=0001067983'],
    '{"confidence":"official_sec_record","latest_known_13f_accession":"0001193125-26-226661"}'::jsonb,
    DATE '2026-05-15'
  ),
  (
    'Bridgewater Associates, LP',
    'bridgewaterassociateslp',
    '0001350694',
    'Bridgewater Associates, LP',
    'Public institutional filer',
    'institutional_investor',
    'Westport, CT 06880',
    '{"street1":"ONE NYALA FARMS ROAD","city":"WESTPORT","state":"CT","zip":"06880","source":"SEC submissions business address"}'::jsonb,
    ARRAY['public_13f','macro'],
    'Public institutional investor profile seeded from official SEC EDGAR submissions and Form 13F-HR filing context.',
    ARRAY['SEC EDGAR submissions API','SEC Form 13F-HR'],
    ARRAY['https://data.sec.gov/submissions/CIK0001350694.json','https://www.sec.gov/edgar/browse/?CIK=0001350694'],
    '{"confidence":"official_sec_record","latest_known_13f_accession":"0001350694-26-000002"}'::jsonb,
    DATE '2026-05-15'
  ),
  (
    'Pershing Square Capital Management, L.P.',
    'pershingsquarecapitalmanagementlp',
    '0001336528',
    'Pershing Square Capital Management, L.P.',
    'Public institutional filer',
    'institutional_investor',
    'New York, NY 10019',
    '{"street1":"787 11TH AVENUE","street2":"9TH FLOOR","city":"NEW YORK","state":"NY","zip":"10019","source":"SEC submissions business address"}'::jsonb,
    ARRAY['public_13f','active_ownership'],
    'Public institutional investor profile seeded from official SEC EDGAR submissions and Form 13F-HR filing context.',
    ARRAY['SEC EDGAR submissions API','SEC Form 13F-HR'],
    ARRAY['https://data.sec.gov/submissions/CIK0001336528.json','https://www.sec.gov/edgar/browse/?CIK=0001336528'],
    '{"confidence":"official_sec_record","latest_known_13f_accession":"0001172661-26-002336"}'::jsonb,
    DATE '2026-05-15'
  ),
  (
    'Scion Asset Management, LLC',
    'scionassetmanagementllc',
    '0001649339',
    'Scion Asset Management, LLC',
    'Public institutional filer',
    'institutional_investor',
    'Saratoga, CA 95070',
    '{"street1":"20665 4TH STREET","street2":"SUITE 201","city":"SARATOGA","state":"CA","zip":"95070","source":"SEC submissions business address"}'::jsonb,
    ARRAY['public_13f','concentrated'],
    'Public institutional investor profile seeded from official SEC EDGAR submissions and Form 13F-HR filing context.',
    ARRAY['SEC EDGAR submissions API','SEC Form 13F-HR'],
    ARRAY['https://data.sec.gov/submissions/CIK0001649339.json','https://www.sec.gov/edgar/browse/?CIK=0001649339'],
    '{"confidence":"official_sec_record","latest_known_13f_accession":"0001649339-25-000007"}'::jsonb,
    DATE '2025-11-03'
  ),
  (
    'ARK Investment Management LLC',
    'arkinvestmentmanagementllc',
    '0001697748',
    'ARK Investment Management LLC',
    'Public institutional filer',
    'institutional_investor',
    'St. Petersburg, FL 33701',
    '{"street1":"200 CENTRAL AVENUE","city":"ST. PETERSBURG","state":"FL","zip":"33701","source":"SEC submissions business address"}'::jsonb,
    ARRAY['public_13f','innovation'],
    'Public institutional investor profile seeded from official SEC EDGAR submissions and Form 13F-HR filing context.',
    ARRAY['SEC EDGAR submissions API','SEC Form 13F-HR'],
    ARRAY['https://data.sec.gov/submissions/CIK0001697748.json','https://www.sec.gov/edgar/browse/?CIK=0001697748'],
    '{"confidence":"official_sec_record","latest_known_13f_accession":"0001104659-26-059240"}'::jsonb,
    DATE '2026-05-12'
  )
ON CONFLICT (cik) DO UPDATE SET
  name = EXCLUDED.name,
  name_normalized = EXCLUDED.name_normalized,
  firm = EXCLUDED.firm,
  title = EXCLUDED.title,
  investor_type = EXCLUDED.investor_type,
  location_hint = EXCLUDED.location_hint,
  business_address = EXCLUDED.business_address,
  investment_style = EXCLUDED.investment_style,
  biography = EXCLUDED.biography,
  data_sources = EXCLUDED.data_sources,
  source_urls = EXCLUDED.source_urls,
  evidence = EXCLUDED.evidence,
  last_13f_date = EXCLUDED.last_13f_date,
  updated_at = NOW();
