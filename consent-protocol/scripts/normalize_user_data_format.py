#!/usr/bin/env python3
"""
Normalize user-data rows in Supabase for the current vault/PKM contract.

What this script normalizes:
1. vault_keys
   - auth_method/key_mode canonical values
   - trims + removes accidental whitespace from encrypted/base64 fields
   - converts sentinel strings ("null"/"undefined"/"none") to NULL for optional fields
2. pkm_data
   - trims + removes accidental whitespace from encrypted/base64 fields
   - normalizes algorithm to "aes-256-gcm" when invalid
3. pkm_index
   - fills null JSON/array counters with defaults

Usage:
  python scripts/normalize_user_data_format.py                  # dry-run
  python scripts/normalize_user_data_format.py --apply          # apply updates
  python scripts/normalize_user_data_format.py --apply --user-id <uid>
"""

from __future__ import annotations

import argparse
import os
import sys
from textwrap import dedent

from dotenv import load_dotenv
from sqlalchemy import text


def _project_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load_env() -> None:
    load_dotenv(os.path.join(_project_root(), ".env"))


def _build_where_clause(user_id: str | None) -> tuple[str, dict]:
    if user_id:
        return "WHERE user_id = :user_id", {"user_id": user_id}
    return "", {}


VAULT_KEYS_COUNT_SQL = dedent(
    """
    SELECT COUNT(*) AS count
    FROM vault_keys
    {where_clause}
    {and_clause}
      (
        auth_method IS NULL
        OR btrim(auth_method) = ''
        OR lower(btrim(auth_method)) NOT IN (
          'passphrase',
          'generated_default_native_biometric',
          'generated_default_web_prf'
        )
        OR key_mode IS NULL
        OR btrim(key_mode) = ''
        OR lower(btrim(key_mode)) NOT IN (
          'passphrase',
          'generated_default_native_biometric',
          'generated_default_web_prf'
        )
        OR encrypted_vault_key ~ E'\\s'
        OR salt ~ E'\\s'
        OR iv ~ E'\\s'
        OR recovery_encrypted_vault_key ~ E'\\s'
        OR recovery_salt ~ E'\\s'
        OR recovery_iv ~ E'\\s'
        OR (
          passkey_credential_id IS NOT NULL
          AND lower(btrim(passkey_credential_id)) IN ('', 'null', 'undefined', 'none')
        )
        OR (
          passkey_prf_salt IS NOT NULL
          AND lower(btrim(passkey_prf_salt)) IN ('', 'null', 'undefined', 'none')
        )
      )
    """
)


VAULT_KEYS_UPDATE_SQL = dedent(
    """
    WITH raw AS (
      SELECT
        user_id,
        CASE
          WHEN auth_method IS NULL
            OR btrim(auth_method) = ''
            OR lower(btrim(auth_method)) IN ('null', 'undefined', 'none')
            THEN 'passphrase'
          WHEN lower(btrim(auth_method)) IN ('generated_native_biometric', 'native_biometric', 'biometric')
            THEN 'generated_default_native_biometric'
          WHEN lower(btrim(auth_method)) IN ('generated_web_prf', 'web_prf', 'passkey')
            THEN 'generated_default_web_prf'
          WHEN lower(btrim(auth_method)) IN ('passphrase', 'generated_default_native_biometric', 'generated_default_web_prf')
            THEN lower(btrim(auth_method))
          ELSE 'passphrase'
        END AS auth_method_norm,
        CASE
          WHEN key_mode IS NULL
            OR btrim(key_mode) = ''
            OR lower(btrim(key_mode)) IN ('null', 'undefined', 'none')
            THEN NULL
          WHEN lower(btrim(key_mode)) IN ('generated_native_biometric', 'native_biometric', 'biometric')
            THEN 'generated_default_native_biometric'
          WHEN lower(btrim(key_mode)) IN ('generated_web_prf', 'web_prf', 'passkey')
            THEN 'generated_default_web_prf'
          WHEN lower(btrim(key_mode)) IN ('passphrase', 'generated_default_native_biometric', 'generated_default_web_prf')
            THEN lower(btrim(key_mode))
          ELSE NULL
        END AS key_mode_norm_raw,
        regexp_replace(btrim(encrypted_vault_key), E'\\s+', '', 'g') AS encrypted_vault_key_norm,
        regexp_replace(btrim(salt), E'\\s+', '', 'g') AS salt_norm,
        regexp_replace(btrim(iv), E'\\s+', '', 'g') AS iv_norm,
        regexp_replace(btrim(recovery_encrypted_vault_key), E'\\s+', '', 'g')
          AS recovery_encrypted_vault_key_norm,
        regexp_replace(btrim(recovery_salt), E'\\s+', '', 'g') AS recovery_salt_norm,
        regexp_replace(btrim(recovery_iv), E'\\s+', '', 'g') AS recovery_iv_norm,
        CASE
          WHEN passkey_credential_id IS NULL THEN NULL
          WHEN lower(btrim(passkey_credential_id)) IN ('', 'null', 'undefined', 'none')
            THEN NULL
          ELSE btrim(passkey_credential_id)
        END AS passkey_credential_id_norm,
        CASE
          WHEN passkey_prf_salt IS NULL THEN NULL
          WHEN lower(btrim(passkey_prf_salt)) IN ('', 'null', 'undefined', 'none')
            THEN NULL
          ELSE regexp_replace(btrim(passkey_prf_salt), E'\\s+', '', 'g')
        END AS passkey_prf_salt_norm
      FROM vault_keys
      {where_clause}
    ),
    normalized AS (
      SELECT
        user_id,
        auth_method_norm,
        COALESCE(key_mode_norm_raw, auth_method_norm) AS key_mode_norm,
        encrypted_vault_key_norm,
        salt_norm,
        iv_norm,
        recovery_encrypted_vault_key_norm,
        recovery_salt_norm,
        recovery_iv_norm,
        passkey_credential_id_norm,
        passkey_prf_salt_norm
      FROM raw
    )
    UPDATE vault_keys vk
    SET
      auth_method = n.auth_method_norm,
      key_mode = n.key_mode_norm,
      encrypted_vault_key = n.encrypted_vault_key_norm,
      salt = n.salt_norm,
      iv = n.iv_norm,
      recovery_encrypted_vault_key = n.recovery_encrypted_vault_key_norm,
      recovery_salt = n.recovery_salt_norm,
      recovery_iv = n.recovery_iv_norm,
      passkey_credential_id = n.passkey_credential_id_norm,
      passkey_prf_salt = n.passkey_prf_salt_norm,
      updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT * 1000
    FROM normalized n
    WHERE vk.user_id = n.user_id
      AND (
        vk.auth_method IS DISTINCT FROM n.auth_method_norm
        OR vk.key_mode IS DISTINCT FROM n.key_mode_norm
        OR vk.encrypted_vault_key IS DISTINCT FROM n.encrypted_vault_key_norm
        OR vk.salt IS DISTINCT FROM n.salt_norm
        OR vk.iv IS DISTINCT FROM n.iv_norm
        OR vk.recovery_encrypted_vault_key IS DISTINCT FROM n.recovery_encrypted_vault_key_norm
        OR vk.recovery_salt IS DISTINCT FROM n.recovery_salt_norm
        OR vk.recovery_iv IS DISTINCT FROM n.recovery_iv_norm
        OR vk.passkey_credential_id IS DISTINCT FROM n.passkey_credential_id_norm
        OR vk.passkey_prf_salt IS DISTINCT FROM n.passkey_prf_salt_norm
      )
    """
)


PKM_DATA_COUNT_SQL = dedent(
    """
    SELECT COUNT(*) AS count
    FROM pkm_data
    {where_clause}
    {and_clause}
      (
        encrypted_data_ciphertext ~ E'\\s'
        OR encrypted_data_iv ~ E'\\s'
        OR encrypted_data_tag ~ E'\\s'
        OR algorithm IS NULL
        OR btrim(algorithm) = ''
        OR lower(btrim(algorithm)) <> 'aes-256-gcm'
      )
    """
)


PKM_DATA_UPDATE_SQL = dedent(
    """
    WITH normalized AS (
      SELECT
        user_id,
        regexp_replace(btrim(encrypted_data_ciphertext), E'\\s+', '', 'g') AS ciphertext_norm,
        regexp_replace(btrim(encrypted_data_iv), E'\\s+', '', 'g') AS iv_norm,
        regexp_replace(btrim(encrypted_data_tag), E'\\s+', '', 'g') AS tag_norm,
        CASE
          WHEN algorithm IS NULL OR btrim(algorithm) = '' THEN 'aes-256-gcm'
          ELSE lower(btrim(algorithm))
        END AS algorithm_norm
      FROM pkm_data
      {where_clause}
    )
    UPDATE pkm_data wmd
    SET
      encrypted_data_ciphertext = n.ciphertext_norm,
      encrypted_data_iv = n.iv_norm,
      encrypted_data_tag = n.tag_norm,
      algorithm = CASE
        WHEN n.algorithm_norm = 'aes-256-gcm' THEN n.algorithm_norm
        ELSE 'aes-256-gcm'
      END,
      updated_at = NOW()
    FROM normalized n
    WHERE wmd.user_id = n.user_id
      AND (
        wmd.encrypted_data_ciphertext IS DISTINCT FROM n.ciphertext_norm
        OR wmd.encrypted_data_iv IS DISTINCT FROM n.iv_norm
        OR wmd.encrypted_data_tag IS DISTINCT FROM n.tag_norm
        OR wmd.algorithm IS DISTINCT FROM CASE
          WHEN n.algorithm_norm = 'aes-256-gcm' THEN n.algorithm_norm
          ELSE 'aes-256-gcm'
        END
      )
    """
)


PKM_INDEX_COUNT_SQL = dedent(
    """
    SELECT COUNT(*) AS count
    FROM pkm_index
    {where_clause}
    {and_clause}
      (
        domain_summaries IS NULL
        OR available_domains IS NULL
        OR computed_tags IS NULL
        OR total_attributes IS NULL
        OR model_version IS NULL
      )
    """
)


PKM_INDEX_UPDATE_SQL = dedent(
    """
    UPDATE pkm_index
    SET
      domain_summaries = COALESCE(domain_summaries, '{{}}'::jsonb),
      available_domains = COALESCE(available_domains, ARRAY[]::text[]),
      computed_tags = COALESCE(computed_tags, ARRAY[]::text[]),
      total_attributes = COALESCE(total_attributes, 0),
      model_version = COALESCE(model_version, 2),
      updated_at = NOW()
    {where_clause}
    {and_clause}
      (
        domain_summaries IS NULL
        OR available_domains IS NULL
        OR computed_tags IS NULL
        OR total_attributes IS NULL
        OR model_version IS NULL
      )
    """
)


def _run_scalar(conn, sql: str, params: dict) -> int:
    row = conn.execute(text(sql), params).first()
    return int(row[0] if row else 0)


def _run_update(conn, sql: str, params: dict) -> int:
    result = conn.execute(text(sql), params)
    return int(result.rowcount or 0)


def main() -> int:
    _load_env()
    if not all(os.getenv(k) for k in ("DB_USER", "DB_PASSWORD", "DB_HOST")):
        print(
            "DB credentials are missing. Set DB_USER, DB_PASSWORD, DB_HOST (and optional DB_PORT/DB_NAME).",
            file=sys.stderr,
        )
        return 1

    parser = argparse.ArgumentParser(description="Normalize Supabase user-data rows.")
    parser.add_argument("--apply", action="store_true", help="Apply updates (default is dry-run).")
    parser.add_argument("--user-id", type=str, default=None, help="Only normalize one user_id.")
    args = parser.parse_args()

    try:
        sys.path.insert(0, _project_root())
        from db.db_client import get_db_connection
    except Exception as exc:
        print(f"Failed to import DB client: {exc}", file=sys.stderr)
        return 1

    where_clause, params = _build_where_clause(args.user_id)
    and_clause = "AND" if where_clause else "WHERE"

    with get_db_connection() as conn:
        vault_candidates = _run_scalar(
            conn,
            VAULT_KEYS_COUNT_SQL.format(where_clause=where_clause, and_clause=and_clause),
            params,
        )
        wmd_candidates = _run_scalar(
            conn,
            PKM_DATA_COUNT_SQL.format(where_clause=where_clause, and_clause=and_clause),
            params,
        )
        wmi_candidates = _run_scalar(
            conn,
            PKM_INDEX_COUNT_SQL.format(where_clause=where_clause, and_clause=and_clause),
            params,
        )

        print("Normalization scan:")
        print(f"  vault_keys candidates: {vault_candidates}")
        print(f"  pkm_data candidates: {wmd_candidates}")
        print(f"  pkm_index candidates: {wmi_candidates}")

        if not args.apply:
            print("\nDry-run only. Re-run with --apply to update rows.")
            return 0

        updated_vault = _run_update(
            conn,
            VAULT_KEYS_UPDATE_SQL.format(where_clause=where_clause),
            params,
        )
        updated_wmd = _run_update(
            conn,
            PKM_DATA_UPDATE_SQL.format(where_clause=where_clause),
            params,
        )
        updated_wmi = _run_update(
            conn,
            PKM_INDEX_UPDATE_SQL.format(where_clause=where_clause, and_clause=and_clause),
            params,
        )

        print("\nApplied normalization:")
        print(f"  vault_keys updated: {updated_vault}")
        print(f"  pkm_data updated: {updated_wmd}")
        print(f"  pkm_index updated: {updated_wmi}")
        print("Done.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
