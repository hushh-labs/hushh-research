"""Stable SQL projection for the Connect directory's bounded candidate scan."""

from __future__ import annotations

from collections.abc import Callable

DIRECTORY_CANDIDATE_SQL = """
            SELECT
              a.user_id, a.display_name, a.email, a.phone_number, a.phone_verified,
              a.public_person_ref, a.photo_url, a.role_label,
              k.key_id, k.public_key_jwk, k.algorithm, k.created_at AS key_created_at
            FROM (
              SELECT
                profile.user_id, profile.public_person_ref, profile.role_label,
                COALESCE(
                  {usable_identity},
                  {usable_marketplace},
                  {usable_ria},
                  ''
                ) AS display_name,
                identity.email, COALESCE(identity.email_verified, FALSE) AS email_verified,
                CASE WHEN identity.phone_verified = TRUE
                  THEN identity.phone_number ELSE NULL END AS phone_number,
                COALESCE(identity.phone_verified, FALSE) AS phone_verified,
                COALESCE(
                  NULLIF(BTRIM(identity.custom_photo_url), ''),
                  NULLIF(BTRIM(identity.photo_url), '')
                ) AS photo_url,
                -- Whether an email or phone fragment may find this person. A
                -- name is public in the directory; an email or phone is not, so
                -- an explicit opt-out keeps a person out of contact lookups for
                -- strangers. Someone the viewer is already connected to or
                -- trusts stays findable.
                (
                  EXISTS (
                    SELECT 1
                    FROM trusted_connections tc
                    WHERE tc.status = 'active'
                      AND tc.owner_user_id = :owner_user_id
                      AND tc.trusted_user_id = profile.user_id
                  )
                  OR EXISTS (
                    SELECT 1
                    FROM connections known
                    WHERE known.status = 'active'
                      AND (
                        (known.user_a_id = :owner_user_id AND known.user_b_id = profile.user_id)
                        OR (known.user_b_id = :owner_user_id AND known.user_a_id = profile.user_id)
                      )
                  )
                  OR (
                    marketplace.is_discoverable IS DISTINCT FROM FALSE
                    AND (
                      (
                        COALESCE(profile.contact_sync_consent_rule_version, 0) = 0
                        AND profile.contact_sync_consent_enabled_at IS NULL
                        AND profile.contact_sync_consent_contract_version IS NULL
                      )
                      OR (
                        profile.contact_discoverable = TRUE
                        AND profile.contact_sync_consent_enabled_at IS NOT NULL
                        AND profile.contact_sync_consent_rule_version > 0
                        AND profile.contact_sync_consent_contract_version = :contact_sync_contract_version
                      )
                    )
                  )
                ) AS contact_listed
              FROM actor_profiles profile
              LEFT JOIN actor_identity_cache identity
                ON identity.user_id = profile.user_id
              LEFT JOIN marketplace_public_profiles marketplace
                ON marketplace.user_id = profile.user_id
              LEFT JOIN ria_profiles ria ON ria.user_id = profile.user_id
              WHERE profile.user_id <> :owner_user_id
                AND profile.public_profile_status = 'active'
                AND (
                  profile.directory_listed = TRUE
                  OR (profile.directory_listed IS NULL AND EXISTS (
                    SELECT 1 FROM vault_keys vault
                    WHERE vault.user_id = profile.user_id
                      AND vault.vault_status = 'active' AND vault.environment_enrolled_at IS NOT NULL
                  ))
                  OR EXISTS (
                    SELECT 1
                    FROM connections related
                    WHERE related.status = 'active'
                      AND (
                        (related.user_a_id = :owner_user_id AND related.user_b_id = profile.user_id)
                        OR (related.user_b_id = :owner_user_id AND related.user_a_id = profile.user_id)
                      )
                  )
                  OR EXISTS (
                    SELECT 1
                    FROM connection_requests pending
                    WHERE pending.status = 'pending'
                      AND (
                        (pending.requester_user_id = :owner_user_id
                          AND pending.addressee_user_id = profile.user_id)
                        OR (pending.addressee_user_id = :owner_user_id
                          AND pending.requester_user_id = profile.user_id)
                      )
                  )
                  OR EXISTS (
                    SELECT 1
                    FROM trusted_connections edge
                    WHERE edge.status = 'active'
                      AND (
                        (edge.owner_user_id = :owner_user_id
                          AND edge.trusted_user_id = profile.user_id)
                        OR (edge.trusted_user_id = :owner_user_id
                          AND edge.owner_user_id = profile.user_id)
                      )
                  )
                )
                AND (:candidate_user_id IS NULL OR profile.user_id = :candidate_user_id)
                AND (CAST(:candidate_user_ids AS TEXT[]) IS NULL
                     OR profile.user_id = ANY(CAST(:candidate_user_ids AS TEXT[])))
            ) a
            LEFT JOIN LATERAL (
              SELECT key_id, public_key_jwk, algorithm, created_at
              FROM one_location_recipient_keys
              WHERE user_id = a.user_id
                AND status = 'active'
              ORDER BY created_at DESC
              LIMIT 1
            ) k ON TRUE
            WHERE {verified_email_clause} (
              (:missing_names_only = TRUE AND a.display_name = '')
              OR (:missing_names_only = FALSE AND a.display_name <> '' AND a.contact_listed AND (
                LOWER(BTRIM(a.email)) LIKE :email_contains ESCAPE '!'
                OR (a.phone_verified = TRUE
                    AND (
                      REGEXP_REPLACE(a.phone_number, '[^0-9]', '', 'g') LIKE :phone_contains
                      OR REGEXP_REPLACE(a.phone_number, '[^0-9]', '', 'g')
                           LIKE ANY(CAST(:phone_alternates AS TEXT[]))
                    ))
              ))
              OR (:missing_names_only = FALSE AND a.display_name <> '' AND :name_search = TRUE AND (
                :query = ''
                OR {separator_sql} = :exact_name
                OR {separator_sql} LIKE :name_prefix ESCAPE '!'
                OR {separator_sql} LIKE :word_prefix ESCAPE '!'
                OR (:query <> '' AND {all_tokens_match_sql})
              )))
              AND (
                :audience = 'all'
                OR (
                  :audience = 'ria'
                ) = EXISTS (
                  SELECT 1
                  FROM ria_profiles rp_audience
                  WHERE rp_audience.user_id = a.user_id
                    AND rp_audience.verification_status
                          IN ('active', 'verified', 'finra_verified')
                )
              )
            ORDER BY
              CASE
                WHEN :name_search = FALSE THEN 4
                WHEN :query = '' THEN 0
                WHEN {separator_sql} = :exact_name THEN 0
                WHEN {separator_sql} LIKE :name_prefix ESCAPE '!' THEN 1
                WHEN {separator_sql} LIKE :word_prefix ESCAPE '!' THEN 2
                WHEN :query <> '' AND {all_tokens_match_sql} THEN 2
                ELSE 4
              END,
              LOWER(COALESCE(NULLIF(BTRIM(a.display_name), ''), a.phone_number, a.user_id)),
              a.user_id
            LIMIT :fetch_limit OFFSET :offset
"""


def build_directory_candidate_statement(
    *,
    usable_name: Callable[[str], str],
    separator_sql: str,
    all_tokens_match_sql: str,
    verified_email_clause: str,
) -> str:
    """Fill only internal static SQL fragments; caller binds every value."""
    return DIRECTORY_CANDIDATE_SQL.format(
        usable_identity=usable_name("identity.display_name"),
        usable_marketplace=usable_name("marketplace.display_name"),
        usable_ria=usable_name("ria.display_name"),
        separator_sql=separator_sql,
        all_tokens_match_sql=all_tokens_match_sql,
        verified_email_clause=verified_email_clause,
    )  # nosec B608 # All substitutions are internal static SQL fragments.
