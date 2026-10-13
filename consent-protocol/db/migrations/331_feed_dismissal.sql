-- A presentation-only, owner-scoped hide state. Source audit and event rows
-- remain authoritative; a nullable column adds no table rewrite.
BEGIN;
ALTER TABLE public.feed_events ADD COLUMN IF NOT EXISTS dismissed_at TIMESTAMPTZ;
ALTER TABLE public.feed_events ADD COLUMN IF NOT EXISTS dismissal_token TEXT;
COMMENT ON COLUMN public.feed_events.dismissed_at IS
  'Owner-hidden Feed presentation item; source domain records remain intact.';
COMMENT ON COLUMN public.feed_events.dismissal_token IS
  'Server-issued version for Undo; Clear replaces it to supersede an older dismissal.';
COMMIT;
