BEGIN;
DROP TRIGGER IF EXISTS feed_request_projection_wake ON public.connection_requests;
DROP TRIGGER IF EXISTS feed_request_projection_wake ON public.drive_owner_search_jobs;
DROP TRIGGER IF EXISTS feed_request_projection_wake ON public.drive_bulk_shares;
DROP TRIGGER IF EXISTS feed_request_projection_wake ON public.drive_request_payment_orders;
DROP TRIGGER IF EXISTS feed_request_projection_wake ON public.drive_request_payment_refunds;
DROP FUNCTION IF EXISTS public.notify_feed_request_projection();
COMMIT;
