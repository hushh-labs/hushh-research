"""Additional Calendar account persistence under the caller's owner transaction."""

from __future__ import annotations

from typing import Any

from sqlalchemy import text


def upsert_additional_calendar_account(connection: Any, params: dict[str, Any]) -> None:
    connection.execute(
        text("""INSERT INTO google_calendar_additional_accounts (
                    user_id, account_id, provider_subject, provider_email, status, scope_csv,
                    access_level, guest_photo_access, refresh_token_ciphertext, refresh_token_iv, refresh_token_tag,
                    access_token_ciphertext, access_token_iv, access_token_tag,
                    access_token_expires_at, connected_at
                    ) VALUES (:user_id, :account_id, :subject, :email, 'connected', :scope_csv,
                    :access_level, :guest_photo_access, :refresh_ciphertext, :refresh_iv, :refresh_tag,
                    :access_ciphertext, :access_iv, :access_tag, :expires_at, clock_timestamp())
                    ON CONFLICT (user_id, account_id) DO UPDATE SET
                    provider_email = EXCLUDED.provider_email, status = 'connected',
                    scope_csv = EXCLUDED.scope_csv, access_level = EXCLUDED.access_level,
                    guest_photo_access = EXCLUDED.guest_photo_access,
                    refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext,
                    refresh_token_iv = EXCLUDED.refresh_token_iv,
                    refresh_token_tag = EXCLUDED.refresh_token_tag,
                    access_token_ciphertext = EXCLUDED.access_token_ciphertext,
                    access_token_iv = EXCLUDED.access_token_iv,
                    access_token_tag = EXCLUDED.access_token_tag,
                    access_token_expires_at = EXCLUDED.access_token_expires_at,
                    connected_at = clock_timestamp(), revoked_at = NULL, updated_at = clock_timestamp()"""),
        params,
    )
