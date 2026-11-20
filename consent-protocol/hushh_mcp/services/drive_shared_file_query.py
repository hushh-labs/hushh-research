"""Bounded encrypted candidates; the source reader authorizes before opening names."""

CANDIDATES_SQL = """
WITH candidates AS (
 SELECT 'bulk'::text AS source_kind,b.created_at AS source_at,b.share_id AS source_id,
   f.position,q.request_id,q.user_id AS owner_user_id,q.recipient_user_id,
   q.request_envelope,q.payment_required,q.access_stop_requested_at,
   r.identity_envelope,f.metadata_envelope,f.source_job_id,f.source_position,
   NULL::jsonb AS plan_envelope,e.state AS grant_state,
   removal.state AS removal_state,removal.removal_id IS NOT NULL AS removal_exists,
   b.expires_at,e.updated_at AS recorded_at,b.progressive_batch,
   payment.status AS payment_status,payment.paid_at,payment.reconciliation_required,
   payment.stripe_mode
 FROM drive_share_requests q
 JOIN drive_bulk_shares b ON b.origin_request_id=q.request_id AND b.user_id=q.user_id
 JOIN drive_bulk_share_files f ON f.share_id=b.share_id AND f.user_id=b.user_id
 JOIN drive_bulk_share_effects e ON e.share_id=f.share_id AND e.position=f.position
   AND e.user_id=b.user_id AND e.recipient_user_id=q.recipient_user_id
 JOIN drive_bulk_share_recipients r ON r.share_id=b.share_id
   AND r.user_id=b.user_id AND r.recipient_user_id=e.recipient_user_id
 LEFT JOIN drive_request_bulk_removals removal ON removal.share_id=e.share_id
   AND removal.position=e.position AND removal.recipient_user_id=e.recipient_user_id
 LEFT JOIN drive_request_payment_orders payment ON payment.request_id=q.request_id
 WHERE b.approved_at IS NOT NULL AND e.state IN ('succeeded','preexisting')
   AND e.updated_at<=:snapshot_at
 UNION ALL
 SELECT 'legacy',g.created_at,g.operation_id,0,q.request_id,q.user_id,q.recipient_user_id,
   q.request_envelope,q.payment_required,q.access_stop_requested_at,
   NULL::jsonb,NULL::jsonb,NULL::uuid,NULL::integer,g.plan_envelope,g.state,
   revoked.state,revoked.state IS NOT NULL,NULL::timestamptz,
   COALESCE(g.settled_at,g.updated_at),FALSE,
   payment.status,payment.paid_at,payment.reconciliation_required,payment.stripe_mode
 FROM drive_share_requests q
 JOIN drive_share_permission_operations g ON g.request_id=q.request_id
   AND g.user_id=q.user_id AND g.kind='grant'
 LEFT JOIN LATERAL (SELECT state FROM drive_share_permission_operations revoke
   WHERE revoke.parent_operation_id=g.operation_id AND revoke.kind='revoke'
   ORDER BY revoke.created_at DESC,revoke.operation_id DESC LIMIT 1) revoked ON TRUE
 LEFT JOIN drive_request_payment_orders payment ON payment.request_id=q.request_id
 WHERE g.state IN ('succeeded','preexisting','present_unattributed')
   AND COALESCE(g.settled_at,g.updated_at)<=:snapshot_at
), owned AS (
 SELECT candidate.*,peer.display_name AS counterpart_label
 FROM candidates candidate
 LEFT JOIN connections relationship ON relationship.status='active'
   AND ((relationship.user_a_id=:viewer AND relationship.user_b_id=
       CASE WHEN :audience='owner' THEN candidate.recipient_user_id ELSE candidate.owner_user_id END)
     OR (relationship.user_b_id=:viewer AND relationship.user_a_id=
       CASE WHEN :audience='owner' THEN candidate.recipient_user_id ELSE candidate.owner_user_id END))
 LEFT JOIN actor_identity_cache peer ON relationship.id IS NOT NULL AND peer.user_id=
   CASE WHEN :audience='owner' THEN candidate.recipient_user_id ELSE candidate.owner_user_id END
 WHERE CASE WHEN :audience='owner' THEN candidate.owner_user_id=:viewer
   ELSE candidate.recipient_user_id=:viewer END
   AND (CAST(:person AS text) IS NULL OR (relationship.id IS NOT NULL AND
     CASE WHEN :audience='owner' THEN candidate.recipient_user_id ELSE candidate.owner_user_id END=:person))
   AND source_at<=:snapshot_at
   AND (CAST(:from_at AS timestamptz) IS NULL OR recorded_at>=:from_at)
   AND (CAST(:before_at AS timestamptz) IS NULL OR recorded_at<:before_at)
)
SELECT *,clock_timestamp() AS server_now FROM owned WHERE
 (CAST(:exact_id AS uuid) IS NULL OR (source_kind=:exact_kind AND source_id=:exact_id
   AND position=:exact_position AND request_id=:exact_request))
 AND (CAST(:after_at AS timestamptz) IS NULL OR
   (source_at,source_kind,source_id,position)>(:after_at,:after_kind,:after_id,:after_position))
 AND (CAST(:keys AS text[]) IS NULL OR source_kind||':'||source_id::text||':'||position::text=ANY(:keys))
ORDER BY source_at,source_kind,source_id,position LIMIT :scan_limit
"""
