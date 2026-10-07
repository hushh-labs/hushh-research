-- Rollback of the budget removes public oEmbed availability; the route fails
-- closed in production if the shared table is unavailable.
BEGIN;
DROP TABLE IF EXISTS public.instagram_oembed_request_budgets;
COMMIT;
