BEGIN;

-- Migration 139: say where a claimed adviser's profile words came from.
--
-- Services, fees and the engagement minimum are not published by the SEC
-- identity API. They exist only as narrative prose inside the firm's own Form
-- ADV Part 2A brochure, which the post-claim worker reads and writes into the
-- blank fields on ria_profiles.
--
-- Those three sentences then sit on the profile looking exactly like something
-- the adviser wrote. They are not. These columns record the filing they were
-- taken from — which brochure, at which URL, filed on which date — so the UI
-- can label them and the adviser can see, correct, or overwrite them against
-- the actual source. Without provenance the profile would assert a filing's
-- words as the adviser's own, which is the one thing this feature must not do.
--
-- All three are nullable and carry no default: a profile the adviser typed
-- themselves has no source to name, and must keep saying nothing.
ALTER TABLE ria_profiles
  ADD COLUMN IF NOT EXISTS profile_source TEXT,
  ADD COLUMN IF NOT EXISTS profile_source_url TEXT,
  ADD COLUMN IF NOT EXISTS profile_source_filed_on TEXT;

COMMENT ON COLUMN ria_profiles.profile_source IS
  'Where the narrative profile fields came from, e.g. `form_adv_part2`. NULL means the adviser authored them.';

COMMENT ON COLUMN ria_profiles.profile_source_url IS
  'URL of the exact filing the narrative fields were read from, so a reader can check the words against the source.';

COMMENT ON COLUMN ria_profiles.profile_source_filed_on IS
  'Filing date of that source document, as the regulator published it (free text: the feed is not a date type).';

COMMIT;
