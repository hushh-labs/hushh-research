-- Rollback disables the publication claim path. Claims contain no content and
-- are retained so an uncertain publication cannot become replayable.
BEGIN;
REVOKE ALL ON TABLE public.instagram_publication_claims FROM PUBLIC;
COMMIT;
