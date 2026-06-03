-- Qualified investor admission model for the RIA marketplace deck.
--
-- V1 keeps official/public SEC profiles discovery-only and only allows Hushh
-- users into the default RIA deck when their public profile metadata explicitly
-- marks them qualified.

ALTER TABLE investor_profiles
  ADD COLUMN IF NOT EXISTS marketplace_eligible BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS curation_tier TEXT NOT NULL DEFAULT 'unreviewed',
  ADD COLUMN IF NOT EXISTS admission_status TEXT NOT NULL DEFAULT 'pending_review',
  ADD COLUMN IF NOT EXISTS quality_score INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS curation_reason TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'investor_profiles_curation_tier_check'
  ) THEN
    ALTER TABLE investor_profiles
      ADD CONSTRAINT investor_profiles_curation_tier_check
      CHECK (curation_tier IN ('unreviewed', 'qualified', 'showcase', 'suppressed'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'investor_profiles_admission_status_check'
  ) THEN
    ALTER TABLE investor_profiles
      ADD CONSTRAINT investor_profiles_admission_status_check
      CHECK (admission_status IN ('pending_review', 'qualified', 'suppressed'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'investor_profiles_quality_score_check'
  ) THEN
    ALTER TABLE investor_profiles
      ADD CONSTRAINT investor_profiles_quality_score_check
      CHECK (quality_score BETWEEN 0 AND 100);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_investor_profiles_marketplace_deck
  ON investor_profiles (marketplace_eligible, admission_status, curation_tier, quality_score DESC);

WITH investor_seed (
  name,
  cik,
  firm,
  location_hint,
  street1,
  street2,
  city,
  state_code,
  zip_code,
  investment_style,
  last_13f_date,
  latest_13f_accession,
  curation_tier,
  quality_score,
  curation_reason
) AS (
  VALUES
    (
      'GATES FOUNDATION TRUST',
      '0001166559',
      'Gates Foundation Trust',
      'Kirkland, WA 98033',
      '2365 CARILLON POINT',
      NULL,
      'KIRKLAND',
      'WA',
      '98033',
      ARRAY['public_13f', 'foundation_trust']::TEXT[],
      DATE '2026-05-15',
      '0001104659-26-062592',
      'showcase',
      98,
      'Showcase public foundation-trust filer with official SEC business address in Kirkland, WA 98033.'
    ),
    (
      'BERKSHIRE HATHAWAY INC',
      '0001067983',
      'Berkshire Hathaway Inc',
      'Omaha, NE 68131',
      '3555 FARNAM STREET',
      NULL,
      'OMAHA',
      'NE',
      '68131',
      ARRAY['public_13f', 'long_term_value']::TEXT[],
      DATE '2026-05-15',
      '0001193125-26-226661',
      'showcase',
      98,
      'Showcase public institutional filer with durable long-term public 13F context.'
    ),
    (
      'Bridgewater Associates, LP',
      '0001350694',
      'Bridgewater Associates, LP',
      'Westport, CT 06880',
      'ONE NYALA FARMS ROAD',
      NULL,
      'WESTPORT',
      'CT',
      '06880',
      ARRAY['public_13f', 'macro']::TEXT[],
      DATE '2026-05-15',
      '0001350694-26-000002',
      'showcase',
      96,
      'Showcase institutional filer with official SEC 13F-HR and macro-oriented public profile context.'
    ),
    (
      'Pershing Square Capital Management, L.P.',
      '0001336528',
      'Pershing Square Capital Management, L.P.',
      'New York, NY 10019',
      '787 11TH AVENUE',
      '9TH FLOOR',
      'NEW YORK',
      'NY',
      '10019',
      ARRAY['public_13f', 'active_ownership']::TEXT[],
      DATE '2026-05-15',
      '0001172661-26-002336',
      'showcase',
      94,
      'Showcase active-ownership public filer with current official 13F evidence.'
    ),
    (
      'CITADEL ADVISORS LLC',
      '0001423053',
      'CITADEL ADVISORS LLC',
      'Miami, FL 33131',
      '830 BRICKELL PLAZA',
      NULL,
      'MIAMI',
      'FL',
      '33131',
      ARRAY['public_13f', 'multi_strategy']::TEXT[],
      DATE '2026-05-15',
      '0001104659-26-062477',
      'showcase',
      95,
      'Showcase multi-strategy institutional filer with official SEC 13F-HR evidence.'
    ),
    (
      'MILLENNIUM MANAGEMENT LLC',
      '0001273087',
      'MILLENNIUM MANAGEMENT LLC',
      'New York, NY 10022',
      '399 PARK AVENUE',
      NULL,
      'NEW YORK',
      'NY',
      '10022',
      ARRAY['public_13f', 'multi_strategy']::TEXT[],
      DATE '2026-05-15',
      '0001273087-26-000004',
      'showcase',
      94,
      'Showcase multi-manager institutional filer with current official 13F-HR evidence.'
    ),
    (
      'Point72 Asset Management, L.P.',
      '0001603466',
      'Point72 Asset Management, L.P.',
      'Stamford, CT 06902',
      '72 CUMMINGS POINT ROAD',
      NULL,
      'STAMFORD',
      'CT',
      '06902',
      ARRAY['public_13f', 'active_equity']::TEXT[],
      DATE '2026-05-15',
      '0000919574-26-003476',
      'showcase',
      93,
      'Showcase active-equity institutional filer with official SEC business address and 13F-HR evidence.'
    ),
    (
      'RENAISSANCE TECHNOLOGIES LLC',
      '0001037389',
      'RENAISSANCE TECHNOLOGIES LLC',
      'New York, NY 10022',
      '800 THIRD AVE',
      NULL,
      'NEW YORK',
      'NY',
      '10022',
      ARRAY['public_13f', 'quantitative']::TEXT[],
      DATE '2026-05-14',
      '0001037389-26-000033',
      'showcase',
      95,
      'Showcase quantitative institutional filer with current official SEC 13F-HR evidence.'
    ),
    (
      'TIGER GLOBAL MANAGEMENT LLC',
      '0001167483',
      'TIGER GLOBAL MANAGEMENT LLC',
      'New York, NY 10019',
      '9 WEST 57TH STREET',
      '35TH FLOOR',
      'NEW YORK',
      'NY',
      '10019',
      ARRAY['public_13f', 'growth']::TEXT[],
      DATE '2026-05-15',
      '0000919574-26-003362',
      'qualified',
      90,
      'Qualified growth-oriented public institutional filer with current official SEC 13F-HR evidence.'
    ),
    (
      'TCI Fund Management Ltd',
      '0001647251',
      'TCI Fund Management Ltd',
      'London, United Kingdom W1S2FT',
      '7 CLIFFORD STREET',
      NULL,
      'LONDON',
      'X0',
      'W1S2FT',
      ARRAY['public_13f', 'active_ownership']::TEXT[],
      DATE '2026-05-15',
      '0001647251-26-000004',
      'qualified',
      89,
      'Qualified active-ownership public filer with official SEC submissions and 13F-HR evidence.'
    ),
    (
      'Duquesne Family Office LLC',
      '0001536411',
      'Duquesne Family Office LLC',
      'New York, NY 10019',
      '40 WEST 57TH STREET, 25TH FLOOR',
      NULL,
      'NEW YORK',
      'NY',
      '10019',
      ARRAY['public_13f', 'family_office']::TEXT[],
      DATE '2026-05-15',
      '0001536411-26-000004',
      'qualified',
      90,
      'Qualified family-office public filer with current official SEC 13F-HR evidence.'
    ),
    (
      'CALIFORNIA STATE TEACHERS RETIREMENT SYSTEM',
      '0001081019',
      'CALIFORNIA STATE TEACHERS RETIREMENT SYSTEM',
      'West Sacramento, CA 95605',
      '100 WATERFRONT PLACE',
      NULL,
      'WEST SACRAMENTO',
      'CA',
      '95605',
      ARRAY['public_13f', 'public_pension']::TEXT[],
      DATE '2026-05-18',
      '0001081019-26-000007',
      'qualified',
      92,
      'Qualified public pension institutional filer with current official SEC 13F-HR evidence.'
    ),
    (
      'ELEMENT CAPITAL MANAGEMENT LLC',
      '0001535630',
      'ELEMENT CAPITAL MANAGEMENT LLC',
      'New York, NY 10022',
      '520 MADISON AVENUE',
      '43PH',
      'NEW YORK',
      'NY',
      '10022',
      ARRAY['public_13f', 'macro']::TEXT[],
      DATE '2026-05-12',
      '0000919574-26-002856',
      'qualified',
      86,
      'Qualified macro-oriented public institutional filer with official SEC 13F-HR evidence.'
    ),
    (
      'Magnetar Financial LLC',
      '0001352851',
      'Magnetar Financial LLC',
      'Evanston, IL 60201',
      '1603 ORRINGTON AVE.',
      '13TH FLOOR',
      'EVANSTON',
      'IL',
      '60201',
      ARRAY['public_13f', 'multi_strategy']::TEXT[],
      DATE '2026-05-13',
      '0001104659-26-059841',
      'qualified',
      86,
      'Qualified multi-strategy public institutional filer with official SEC 13F-HR evidence.'
    ),
    (
      'Appaloosa LP',
      '0001656456',
      'Appaloosa LP',
      'Short Hills, NJ 07078',
      '51 JOHN F. KENNEDY PKWY',
      NULL,
      'SHORT HILLS',
      'NJ',
      '07078',
      ARRAY['public_13f', 'event_driven']::TEXT[],
      DATE '2026-05-15',
      '0001656456-26-000002',
      'qualified',
      89,
      'Qualified event-driven public institutional filer with official SEC 13F-HR evidence.'
    ),
    (
      'Altimeter Capital Management, LP',
      '0001541617',
      'Altimeter Capital Management, LP',
      'Menlo Park, CA 94025',
      '2550 SAND HILL RD',
      'SUITE 150',
      'MENLO PARK',
      'CA',
      '94025',
      ARRAY['public_13f', 'growth_technology']::TEXT[],
      DATE '2026-05-15',
      '0001541617-26-000006',
      'qualified',
      88,
      'Qualified growth and technology public institutional filer with official SEC 13F-HR evidence.'
    ),
    (
      'Saba Capital Management, L.P.',
      '0001510281',
      'Saba Capital Management, L.P.',
      'New York, NY 10174',
      '405 LEXINGTON AVENUE',
      '58TH FLOOR',
      'NEW YORK',
      'NY',
      '10174',
      ARRAY['public_13f', 'credit_event_driven']::TEXT[],
      DATE '2026-05-15',
      '0001062993-26-002707',
      'qualified',
      85,
      'Qualified credit and event-driven public institutional filer with official SEC 13F-HR evidence.'
    ),
    (
      'GEODE CAPITAL MANAGEMENT, LLC',
      '0001214717',
      'GEODE CAPITAL MANAGEMENT, LLC',
      'Boston, MA 02110',
      '100 SUMMER STREET',
      '12TH FLOOR',
      'BOSTON',
      'MA',
      '02110',
      ARRAY['public_13f', 'systematic']::TEXT[],
      DATE '2026-05-15',
      '0001214717-26-000006',
      'qualified',
      87,
      'Qualified systematic institutional filer with official SEC 13F-HR evidence.'
    ),
    (
      'DAVIDSON KEMPNER CAPITAL MANAGEMENT LP',
      '0001595082',
      'DAVIDSON KEMPNER CAPITAL MANAGEMENT LP',
      'New York, NY 10019',
      '9 WEST 57TH STREET',
      '29TH FLOOR',
      'NEW YORK',
      'NY',
      '10019',
      ARRAY['public_13f', 'event_driven']::TEXT[],
      DATE '2026-05-15',
      '0001595082-26-000046',
      'qualified',
      86,
      'Qualified event-driven institutional filer with official SEC 13F-HR evidence.'
    ),
    (
      'BAUPOST GROUP LLC/MA',
      '0001061768',
      'BAUPOST GROUP LLC/MA',
      'Boston, MA 02116',
      '10 ST JAMES AVE',
      'SUITE 1700',
      'BOSTON',
      'MA',
      '02116',
      ARRAY['public_13f', 'value_investing']::TEXT[],
      DATE '2026-05-14',
      '0001061768-26-000007',
      'qualified',
      90,
      'Qualified value-oriented institutional filer with official SEC 13F-HR evidence.'
    ),
    (
      'FMR LLC',
      '0000315066',
      'FMR LLC',
      'Boston, MA 02210',
      '245 SUMMER STREET',
      NULL,
      'BOSTON',
      'MA',
      '02210',
      ARRAY['public_13f', 'institutional_asset_manager']::TEXT[],
      DATE '2026-05-15',
      '0000315066-26-001390',
      'qualified',
      91,
      'Qualified institutional asset-manager filer with current official SEC 13F-HR evidence.'
    ),
    (
      'WELLINGTON MANAGEMENT GROUP LLP',
      '0000902219',
      'WELLINGTON MANAGEMENT GROUP LLP',
      'Boston, MA 02210',
      'C/O WELLINGTON MANAGEMENT COMPANY LLP',
      '280 CONGRESS STREET',
      'BOSTON',
      'MA',
      '02210',
      ARRAY['public_13f', 'institutional_asset_manager']::TEXT[],
      DATE '2026-05-15',
      '0000902219-26-000209',
      'qualified',
      91,
      'Qualified institutional asset-manager filer with current official SEC 13F-HR evidence.'
    ),
    (
      'Scion Asset Management, LLC',
      '0001649339',
      'Scion Asset Management, LLC',
      'Saratoga, CA 95070',
      '20665 4TH STREET',
      'SUITE 201',
      'SARATOGA',
      'CA',
      '95070',
      ARRAY['public_13f', 'concentrated']::TEXT[],
      DATE '2025-11-03',
      '0001649339-25-000007',
      'qualified',
      82,
      'Qualified concentrated public 13F filer retained from the existing SEC-backed inventory.'
    ),
    (
      'ARK Investment Management LLC',
      '0001697748',
      'ARK Investment Management LLC',
      'St. Petersburg, FL 33701',
      '200 CENTRAL AVENUE',
      NULL,
      'ST. PETERSBURG',
      'FL',
      '33701',
      ARRAY['public_13f', 'innovation']::TEXT[],
      DATE '2026-05-12',
      '0001104659-26-059240',
      'qualified',
      87,
      'Qualified innovation-oriented public institutional filer retained from the existing SEC-backed inventory.'
    )
)
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
  last_13f_date,
  marketplace_eligible,
  curation_tier,
  admission_status,
  quality_score,
  curation_reason
)
SELECT
  seed.name,
  regexp_replace(lower(seed.name), '[^a-z0-9]+', '', 'g'),
  seed.cik,
  seed.firm,
  'Public institutional filer',
  'institutional_investor',
  seed.location_hint,
  jsonb_strip_nulls(
    jsonb_build_object(
      'street1', seed.street1,
      'street2', seed.street2,
      'city', seed.city,
      'state', seed.state_code,
      'zip', seed.zip_code,
      'source', 'SEC submissions business address'
    )
  ),
  seed.investment_style,
  'Public SEC-backed investor discovery profile seeded from official EDGAR submissions and Form 13F context. '
    || seed.curation_reason,
  ARRAY['SEC EDGAR submissions API', 'SEC Form 13F-HR']::TEXT[],
  ARRAY[
    'https://data.sec.gov/submissions/CIK' || seed.cik || '.json',
    'https://www.sec.gov/edgar/browse/?CIK=' || seed.cik
  ]::TEXT[],
  jsonb_build_object(
    'confidence', 'official_sec_record',
    'latest_known_13f_accession', seed.latest_13f_accession,
    'curation_reason', seed.curation_reason
  ),
  seed.last_13f_date,
  TRUE,
  seed.curation_tier,
  'qualified',
  seed.quality_score,
  seed.curation_reason
FROM investor_seed seed
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
  marketplace_eligible = EXCLUDED.marketplace_eligible,
  curation_tier = EXCLUDED.curation_tier,
  admission_status = EXCLUDED.admission_status,
  quality_score = EXCLUDED.quality_score,
  curation_reason = EXCLUDED.curation_reason,
  updated_at = NOW();
