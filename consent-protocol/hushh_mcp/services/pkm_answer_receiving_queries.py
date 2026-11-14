"""Recipient eligibility and immutable staging queries for the paid-answer lane.

Callers retain their existing transactions and row-lock order. Keeping these
queries together makes the public-key ownership and revocation predicates
reviewable across participant status, preparation, checkout and settlement.
"""

PARTICIPANT_STATE = """SELECT r.request_id, r.owner_user_id, r.status, r.question,
                   r.terms_digest, r.composer_consent_digest,
                   d.has_content AS staged_has_content, d.source_revisions AS staged_revisions,
                   EXISTS(SELECT 1 FROM marketplace_recipient_keys k
                     WHERE k.user_id=r.requester_user_id AND k.status='active'
                       AND k.key_id<>'' AND k.public_key_jwk IS NOT NULL
                       AND k.public_key_jwk<>'{}'::jsonb) AS requester_key_ready,
                   d.recipient_key_id AS delivery_recipient_key_id,
                   EXISTS(SELECT 1 FROM marketplace_recipient_keys staged_key
                     WHERE staged_key.user_id=r.requester_user_id
                       AND staged_key.key_id=d.recipient_key_id
                       AND staged_key.status='active') AS delivery_recipient_key_active
                FROM pkm_answer_requests r
                LEFT JOIN pkm_answer_deliveries d ON d.request_id=r.request_id
                WHERE r.request_id=:request
                AND (r.owner_user_id=:user OR r.requester_user_id=:user)"""

ANSWERABLE_WITH_RECIPIENT = """SELECT r.request_id, r.question, r.period_start, r.period_end,
                              r.requester_user_id, r.terms_digest, r.answer_deadline_at,
                              recipient.key_id, recipient.public_key_jwk, recipient.algorithm
                       FROM pkm_answer_requests r
                       JOIN LATERAL (
                         SELECT k.key_id,k.public_key_jwk,k.algorithm
                         FROM marketplace_recipient_keys k
                         WHERE k.user_id=r.requester_user_id AND k.status='active'
                           AND k.key_id<>'' AND k.public_key_jwk IS NOT NULL
                           AND k.public_key_jwk<>'{}'::jsonb
                         ORDER BY k.created_at DESC LIMIT 1
                       ) recipient ON TRUE
                       LEFT JOIN pkm_answer_payment_orders o ON o.request_id = r.request_id
                       LEFT JOIN pkm_answer_deliveries d ON d.request_id = r.request_id
                       WHERE r.owner_user_id = :owner
                         AND (d.request_id IS NULL OR
                              (d.has_content AND (r.status='answering'
                               OR d.source_revisions->>'_composition_terms' IS DISTINCT FROM r.terms_digest
                               OR NOT EXISTS(SELECT 1 FROM marketplace_recipient_keys staged_key
                                WHERE staged_key.user_id=r.requester_user_id
                                  AND staged_key.key_id=d.recipient_key_id
                                  AND staged_key.status='active'))))
                         AND EXISTS (SELECT 1 FROM connections c WHERE c.status='active'
                           AND ((c.user_a_id=r.owner_user_id AND c.user_b_id=r.requester_user_id)
                             OR (c.user_b_id=r.owner_user_id AND c.user_a_id=r.requester_user_id)))
                         AND (
                           -- Staging. The owner has just approved, so their
                           -- device is present and unlocked: the answer is
                           -- prepared now and withheld until payment, and a
                           -- question nothing matches never reaches a price.
                           r.status = 'approved'
                           -- The paid-first path, for a request approved while
                           -- the owner's device could not prepare it.
                           OR (r.status = 'answering'
                               AND o.status = 'paid' AND NOT o.reconciliation_required
                               AND o.stripe_mode IN ('test', 'live')
                               AND r.answer_deadline_at > clock_timestamp())
                         )
                       ORDER BY r.approved_at
                       LIMIT :limit"""

STAGE_RECIPIENT_DELIVERY = """INSERT INTO pkm_answer_deliveries
                       (request_id, recipient_key_id, ciphertext, iv,
                        sender_ephemeral_public_key_jwk, source_revisions, has_content)
                       VALUES (:request, :key_id, :ciphertext, :iv,
                               CAST(:jwk AS JSONB), CAST(:revisions AS JSONB), :has_content)
                       ON CONFLICT (request_id) DO UPDATE SET
                         recipient_key_id=EXCLUDED.recipient_key_id,
                         ciphertext=EXCLUDED.ciphertext, iv=EXCLUDED.iv,
                         sender_ephemeral_public_key_jwk=EXCLUDED.sender_ephemeral_public_key_jwk,
                         source_revisions=EXCLUDED.source_revisions,
                         has_content=EXCLUDED.has_content,
                         created_at=clock_timestamp()
                       WHERE pkm_answer_deliveries.has_content
                         AND ((pkm_answer_deliveries.source_revisions->>'_composition_terms'
                              IS DISTINCT FROM EXCLUDED.source_revisions->>'_composition_terms'
                              AND EXCLUDED.source_revisions ? '_composition_receipt')
                           OR (NOT EXCLUDED.has_content
                               AND NOT pkm_answer_deliveries.source_revisions ? '_composition_receipt')
                           OR ((NOT EXCLUDED.has_content
                                OR EXCLUDED.source_revisions ? '_composition_receipt')
                               AND NOT EXISTS(SELECT 1 FROM marketplace_recipient_keys previous_key
                                 WHERE previous_key.user_id=:requester
                                   AND previous_key.key_id=pkm_answer_deliveries.recipient_key_id
                                   AND previous_key.status='active')))"""

PAYMENT_WITH_RECIPIENT_STATE = """SELECT r.status AS request_status, r.amount_cents, r.currency,
                          r.request_id, r.owner_user_id, r.terms_digest, r.composer_consent_digest,
                          r.answer_deadline_at, r.question,
                          (r.approved_at < clock_timestamp() - interval '2 minutes') AS preparation_overdue,
                          o.status AS order_status,
                          o.stripe_checkout_url, o.paid_at, o.refunded_at, o.refund_reason,
                          o.reconciliation_required, d.has_content AS staged_has_content,
                          d.source_revisions AS staged_revisions,
                          EXISTS(SELECT 1 FROM marketplace_recipient_keys k
                            WHERE k.user_id=r.requester_user_id
                              AND k.key_id=d.recipient_key_id AND k.status='active')
                            AS staged_recipient_active
                   FROM pkm_answer_requests r
                   LEFT JOIN pkm_answer_payment_orders o ON o.request_id = r.request_id
                   LEFT JOIN pkm_answer_deliveries d ON d.request_id = r.request_id
                   WHERE r.request_id = :request AND r.requester_user_id = :requester"""

PREPARED_ACTIVE_DELIVERY = """SELECT d.has_content, d.ciphertext, d.iv, d.recipient_key_id,
                          d.source_revisions
                    FROM pkm_answer_deliveries d
                    JOIN marketplace_recipient_keys k ON k.key_id=d.recipient_key_id
                      AND k.user_id=:requester AND k.status='active'
                    WHERE d.request_id=:request FOR SHARE OF d,k"""

SETTLEMENT_ACTIVE_DELIVERY = """SELECT d.has_content, d.source_revisions FROM pkm_answer_deliveries d
                           JOIN marketplace_recipient_keys k ON k.key_id=d.recipient_key_id
                             AND k.user_id=:requester AND k.status='active'
                           WHERE d.request_id=:request FOR SHARE OF d,k"""
