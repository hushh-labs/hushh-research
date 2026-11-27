"""Participant-scoped current payment and delivery facts for a bounded Feed page."""

DRIVE_DOCUMENT_PAYMENT_QUERY = """
SELECT r.request_id::TEXT AS request_id,
       r.status AS current_request_status,
       outcome_search.status AS outcome_search_status,
       outcome_search.incomplete_search AS outcome_search_incomplete,
       outcome_search.matched AS outcome_search_matched,
       outcome_search.unshareable_count AS outcome_search_unshareable,
       delivery.total AS current_delivery_total_count,
       delivery.available AS current_delivery_confirmed_count,
       delivery.pending AS current_delivery_pending_count,
       r.expires_at AS current_request_expires_at,
       (r.expires_at <= clock_timestamp()) AS current_request_expired,
       (r.access_stop_requested_at IS NOT NULL) AS current_access_stopped,
       CASE WHEN o.stripe_mode<>:stripe_mode AND o.status IN ('awaiting_payment','checkout_open')
         THEN 'expired' ELSE o.status END AS current_payment_status,
       (o.stripe_checkout_session_id IS NOT NULL AND
        o.stripe_checkout_expires_at IS NOT NULL AND
        o.stripe_checkout_expires_at <= clock_timestamp()) AS current_checkout_expired,
       CASE WHEN o.stripe_checkout_session_id IS NOT NULL
         THEN o.stripe_checkout_expires_at END AS current_checkout_expires_at,
       (r.user_id=:user_id) AS viewer_is_owner,
       p.status AS owner_payout_status,
       p.owner_earning_cents,
       CASE WHEN r.payment_required AND r.settlement_method<>'hashcoins'
         AND r.status IN
         ('pending','preparing','review_ready','approved','partial','completed')
         AND
         (p.request_id IS NOT NULL OR
          (:payout_rollout AND o.request_id IS NULL)) THEN
         COALESCE(a.account_ready,FALSE)
       END AS owner_payout_account_ready,
       CASE WHEN p.request_id IS NOT NULL
         AND r.settlement_method<>'hashcoins' THEN
         COALESCE(a.account_ready,FALSE)
       END AS current_owner_payout_account_ready,
       CASE WHEN f.status='succeeded'
         THEN COALESCE(f.amount_cents,o.amount_cents) END
         AS current_refund_amount_cents,
       o.amount_cents AS current_payment_amount_cents,
       r.payment_required AS view_payment_required,
       (r.existing_access_waived_at IS NOT NULL AND NOT r.payment_required
        AND r.status='completed' AND COALESCE(o.status,'expired') NOT IN ('paid','refunded'))
        AS current_existing_access_nocharge,
       r.preparation_error_code AS view_preparation_error_code,
       r.quoted_amount_cents AS view_quoted_amount_cents,
       o.reconciliation_reason AS view_reconciliation_reason,
       f.status AS view_refund_status,
       f.amount_cents AS view_refund_amount_cents
FROM drive_share_requests r
JOIN jsonb_array_elements_text(CAST(:request_ids_json AS JSONB)) ids(value)
  ON r.request_id = CAST(ids.value AS UUID)
LEFT JOIN drive_owner_search_jobs outcome_search
  ON outcome_search.user_id=r.user_id
  AND outcome_search.client_request_id=r.request_id AND r.status='no_match'
LEFT JOIN drive_request_payment_orders o ON o.request_id=r.request_id
LEFT JOIN drive_request_owner_payouts p
  ON p.request_id=r.request_id AND p.erased_at IS NULL
LEFT JOIN stripe_owner_payout_accounts a
  ON a.user_id=r.user_id AND r.payment_required AND a.stripe_mode=:stripe_mode
LEFT JOIN drive_request_payment_refunds f ON f.request_id=r.request_id
LEFT JOIN LATERAL (
  SELECT count(*) AS total,
    count(*) FILTER (WHERE e.state IN ('succeeded','preexisting')) AS available,
    count(*) FILTER (WHERE e.state IN ('queued','dispatching','unknown')) AS pending
  FROM drive_bulk_shares b
  JOIN drive_bulk_share_effects e ON e.share_id=b.share_id AND e.user_id=b.user_id
  JOIN drive_bulk_share_files selected ON selected.share_id=e.share_id
    AND selected.user_id=e.user_id AND selected.position=e.position
  WHERE r.status IN ('partial','completed') AND b.origin_request_id=r.request_id
    AND b.user_id=r.user_id AND b.approved_at IS NOT NULL
    AND e.recipient_user_id=r.recipient_user_id
    AND (b.progressive_batch=FALSE OR selected.origin_request_id=r.request_id)
    AND b.expires_at>clock_timestamp()
    AND NOT EXISTS (
      SELECT 1 FROM drive_request_bulk_removals removal
      WHERE removal.share_id=e.share_id AND removal.position=e.position
        AND removal.recipient_user_id=e.recipient_user_id)
) delivery ON TRUE
WHERE r.recipient_user_id=:user_id OR r.user_id=:user_id
"""
