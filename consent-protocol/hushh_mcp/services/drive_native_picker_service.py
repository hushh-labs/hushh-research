"""Google One Picker mobile redirect without exposing a Drive grant to the app.

The native system browser uses Google's documented ``trigger_onepick=true``
authorization flow.  Google redirects selected IDs and an authorization code to
our fixed HTTPS callback.  The callback exchanges and validates that code on
the server, then returns the app only an opaque attempt outcome.  A Vault Owner
must still explicitly confirm the staged files before catalog admission.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import secrets
import uuid
from dataclasses import asdict
from typing import Any, cast
from urllib.parse import urlencode, urlsplit

from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.drive_document_store import PROCESSING_DISCLOSURE_VERSION
from hushh_mcp.services.drive_native_picker_store import DriveNativePickerStore
from hushh_mcp.services.drive_selection_service import DriveSelectionService
from hushh_mcp.services.external_connector_credentials_service import (
    ExternalConnectorCredentialError,
)
from hushh_mcp.services.external_connector_google_oauth import (
    AUTHORIZE_URL,
    TOKEN_URL,
    DriveOAuthError,
)
from hushh_mcp.services.external_connector_oauth_service import (
    ExternalConnectorOAuthError,
    get_external_connector_oauth_service,
)
from hushh_mcp.services.google_drive_adapter import (
    DRIVE_FILE_SCOPE,
    MAX_SELECTION,
    DriveMetadata,
    DriveReadError,
    GoogleDriveAdapter,
    selected_file_ids,
)

NATIVE_PICKER_CALLBACK_PATH = "/api/connectors/google_drive/picker/native/callback"
NATIVE_PICKER_SCOPES = (DRIVE_FILE_SCOPE,)
_PICKER_RESULT_VERSION = 1


def _attempt_aad(row: dict[str, Any], purpose: str) -> str:
    return json.dumps(
        [
            "drive-native-picker-v1",
            purpose,
            str(row["user_id"]),
            str(row["attempt_id"]),
            int(row["connection_generation"]),
            int(row["credential_version"]),
        ],
        separators=(",", ":"),
    )


def _strict_scopes(value: str | None) -> set[str]:
    if not isinstance(value, str) or not value or len(value) > 2048:
        raise DriveOAuthError("insufficient_scope", status_code=403)
    items = value.split()
    if len(items) != len(set(items)) or set(items) != set(NATIVE_PICKER_SCOPES):
        raise DriveOAuthError("unexpected_scope", status_code=403)
    return set(items)


def _callback_access_token(token: dict[str, Any]) -> str:
    """Validate and immediately discard the mobile Picker exchange token.

    Google's One Picker redirect accepts only ``drive.file``.  It cannot
    request OIDC identity scopes, so the callback never claims it identified an
    account. The callback token is used once to prove the Picker-authorized
    IDs are readable. The already-active, verified connector credential then
    re-reads them before staging and again at confirmation.
    """
    if not isinstance(token, dict):
        raise DriveOAuthError("provider_response_invalid", status_code=502)
    token_scope = token.get("scope")
    scope_items = token_scope.split() if isinstance(token_scope, str) else []
    if (
        not isinstance(token_scope, str)
        or len(scope_items) != len(set(scope_items))
        or set(scope_items) != set(NATIVE_PICKER_SCOPES)
    ):
        raise DriveOAuthError("unexpected_scope", status_code=403)
    access = token.get("access_token")
    expiry = token.get("expires_in")
    if (
        not isinstance(access, str)
        or not 1 <= len(access) <= 16384
        or str(token.get("token_type", "")).lower() != "bearer"
        or isinstance(expiry, bool)
        or not isinstance(expiry, (int, float))
        or not 0 < expiry <= 86400
    ):
        raise DriveOAuthError("provider_response_invalid", status_code=502)
    return access


def _picked_ids(value: str | None) -> tuple[str, ...]:
    # One Picker's mobile redirect emits a comma-separated list.  A raw
    # provider query never becomes an operation argument or customer response.
    if not isinstance(value, str) or not value or len(value) > MAX_SELECTION * 201:
        raise DriveReadError("invalid_selection")
    return cast(tuple[str, ...], selected_file_ids(value.split(",")))


def _redirect_uri(value: str, connector: Any) -> str:
    """Accept only the exact operator-registered HTTPS mobile callback."""
    if value not in connector.registered_redirect_uris:
        raise DriveOAuthError("redirect_not_registered")
    parsed = urlsplit(value)
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or parsed.username
        or parsed.password
        or parsed.path != NATIVE_PICKER_CALLBACK_PATH
        or parsed.query
        or parsed.fragment
    ):
        raise DriveOAuthError("redirect_not_registered")
    return value


def _candidate_payload(files: list[DriveMetadata]) -> list[dict[str, Any]]:
    return [
        {
            # This is an opaque staging handle, not Google's file identifier
            # and not an existing catalog document identifier.
            "documentId": str(uuid.uuid4()),
            "file": asdict(file),
        }
        for file in files
    ]


def _decode_candidates(value: str) -> tuple[str, list[dict[str, Any]]]:
    try:
        decoded = json.loads(value)
        if (
            not isinstance(decoded, dict)
            or decoded.get("version") != _PICKER_RESULT_VERSION
            or set(decoded) != {"version", "subject", "files"}
            or not isinstance(decoded.get("subject"), str)
            or not 1 <= len(decoded["subject"]) <= 255
            or not isinstance(decoded.get("files"), list)
            or not 1 <= len(decoded["files"]) <= MAX_SELECTION
        ):
            raise ValueError("invalid candidate envelope")
        result: list[dict[str, Any]] = []
        ids: set[str] = set()
        handles: set[str] = set()
        for candidate in decoded["files"]:
            if not isinstance(candidate, dict):
                raise ValueError("invalid candidate")
            handle, source = candidate.get("documentId"), candidate.get("file")
            if (
                not isinstance(handle, str)
                or str(uuid.UUID(handle)) != handle
                or not isinstance(source, dict)
            ):
                raise ValueError("invalid candidate")
            file_id = source.get("file_id")
            if not isinstance(file_id, str) or file_id in ids or handle in handles:
                raise ValueError("invalid candidate")
            metadata = DriveMetadata(
                file_id=file_id,
                name=source["name"],
                mime_type=source["mime_type"],
                version=source["version"],
                modified_time=source["modified_time"],
                size=source.get("size"),
                checksum=source.get("checksum"),
            )
            # Reuse the canonical strict identifier parser.  The other fields
            # are display-only until the exact same source is re-read at
            # confirmation.
            selected_file_ids([metadata.file_id])
            if (
                not isinstance(metadata.name, str)
                or not 1 <= len(metadata.name) <= 1024
                or not isinstance(metadata.mime_type, str)
                or not isinstance(metadata.version, str)
                or not isinstance(metadata.modified_time, str)
            ):
                raise ValueError("invalid candidate")
            ids.add(metadata.file_id)
            handles.add(handle)
            result.append({"documentId": handle, "metadata": metadata})
        return decoded["subject"], result
    except (KeyError, TypeError, ValueError):
        raise DriveReadError("selection_expired") from None


class DriveNativePickerService:
    def __init__(self, *, oauth=None, store=None, adapter=None, selection=None):
        self.oauth = oauth or get_external_connector_oauth_service().drive()
        self.store = store or DriveNativePickerStore(db=self.oauth.lifecycle.db)
        self.adapter = adapter or GoogleDriveAdapter()
        self.selection = selection or DriveSelectionService(
            oauth=self.oauth, store=self.store, adapter=self.adapter
        )

    async def _current(self, user_id: str) -> tuple[Any, dict[str, Any], dict[str, Any]]:
        connector, row, credential = await self.selection._current(user_id)
        _, client_id, _ = await self.oauth._configuration()
        subject = credential.get("subject")
        if (
            credential.get("oauthClientId") != client_id
            or not isinstance(subject, str)
            or not 1 <= len(subject) <= 255
        ):
            raise DriveReadError("reconnect_required")
        return connector, row, credential

    @staticmethod
    def _same_attempt(
        attempt: dict[str, Any], row: dict[str, Any], credential: dict[str, Any], *, client_id: str
    ) -> None:
        if (
            int(attempt["connection_generation"]) != int(row["connection_generation"])
            or int(attempt["credential_version"]) != int(row["credential_version"])
            or credential.get("oauthClientId") != client_id
            or not isinstance(credential.get("subject"), str)
        ):
            raise DriveReadError("connection_changed")

    async def start(self, *, user_id: str, redirect_uri: str) -> dict[str, str]:
        connector, row, credential = await self._current(user_id)
        callback_uri = _redirect_uri(redirect_uri, connector)
        _, client_id, _ = await self.oauth._configuration()
        attempt_id = str(uuid.uuid4())
        verifier = secrets.token_urlsafe(48)
        proof_row = {
            "user_id": user_id,
            "attempt_id": attempt_id,
            "connection_generation": row["connection_generation"],
            "credential_version": row["credential_version"],
        }
        proof = self.oauth.credentials.encrypt_secret(
            json.dumps(
                {
                    "verifier": verifier,
                    "subject": credential["subject"],
                    "clientId": client_id,
                    "redirectUri": callback_uri,
                },
                separators=(",", ":"),
            ),
            aad=_attempt_aad(proof_row, "proof"),
        )
        attempt = await self.store.start_attempt(
            user_id=user_id,
            generation=int(row["connection_generation"]),
            credential_version=int(row["credential_version"]),
            attempt_id=attempt_id,
            proof_ciphertext=proof["ciphertext"],
            proof_iv=proof["iv"],
        )
        query = {
            "client_id": client_id,
            "redirect_uri": callback_uri,
            "response_type": "code",
            "scope": " ".join(NATIVE_PICKER_SCOPES),
            "state": self.oauth.state_codec._signed_state(attempt_id),
            "code_challenge": self.oauth.state_codec._pkce_challenge(verifier),
            "code_challenge_method": "S256",
            # Google's mobile Picker documented redirect path.  It does not
            # create an app-wide Drive grant or expose picker output to JS.
            "trigger_onepick": "true",
            "allow_multiple": "true",
            "include_granted_scopes": "false",
            "prompt": "consent",
        }
        return {
            "authorizeUrl": f"{AUTHORIZE_URL}?{urlencode(query)}",
            "attemptId": str(attempt["attempt_id"]),
            "expiresAt": attempt["expires_at"].isoformat(),
        }

    def _open_proof(self, attempt: dict[str, Any]) -> dict[str, str]:
        try:
            result = json.loads(
                self.oauth.credentials.decrypt_secret(
                    ciphertext=attempt["proof_ciphertext"],
                    iv=attempt["proof_iv"],
                    aad=_attempt_aad(attempt, "proof"),
                )
            )
            if (
                not isinstance(result, dict)
                or not all(isinstance(result.get(key), str) and result[key] for key in result)
                or set(result) != {"verifier", "subject", "clientId", "redirectUri"}
            ):
                raise ValueError("invalid proof")
            return result
        except (ValueError, TypeError, ExternalConnectorCredentialError):
            raise DriveReadError("selection_expired") from None

    async def callback(
        self,
        *,
        state: str,
        code: str | None,
        scope: str | None,
        picked_file_ids: str | None,
        error: str | None,
    ) -> tuple[str, str]:
        """Complete Google's public callback, returning an opaque app outcome only."""
        attempt_id = self.oauth.state_codec._verify_state(state)
        if error or not code:
            await self.store.discard_callback(attempt_id=attempt_id)
            return attempt_id, "cancelled" if error else "failed"
        try:
            staged = await self._stage_callback(
                attempt_id=attempt_id,
                code=code,
                scope=scope,
                picked_file_ids=picked_file_ids,
            )
        except (
            DriveReadError,
            DriveOAuthError,
            ExternalConnectorOAuthError,
            ExternalConnectorCredentialError,
            TimeoutError,
        ):
            return attempt_id, "failed"
        except Exception:  # noqa: BLE001 - public callback must stay opaque after valid state.
            return attempt_id, "failed"
        return attempt_id, "ready" if staged else "failed"

    async def _stage_callback(
        self,
        *,
        attempt_id: str,
        code: str,
        scope: str | None,
        picked_file_ids: str | None,
    ) -> bool:
        attempt = await self.store.claim_callback(attempt_id=attempt_id)
        if attempt is None:
            return False
        try:
            proof = self._open_proof(attempt)
            connector, client_id, client_secret = await self.oauth._configuration()
            if proof["clientId"] != client_id or proof["redirectUri"] != _redirect_uri(
                proof["redirectUri"], connector
            ):
                raise DriveOAuthError("attempt_configuration_changed", status_code=409)
            _strict_scopes(scope)
            token = await self.oauth._post(
                TOKEN_URL,
                {
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": proof["redirectUri"],
                    "client_id": client_id,
                    "client_secret": client_secret,
                    "code_verifier": proof["verifier"],
                },
            )
            callback_access_token = _callback_access_token(token)
            ids = _picked_ids(picked_file_ids)
            _, row, credential = await self._current(str(attempt["user_id"]))
            self._same_attempt(attempt, row, credential, client_id=client_id)
            if not hmac.compare_digest(str(credential["subject"]), proof["subject"]):
                raise DriveOAuthError("identity_not_verified", status_code=401)
            try:
                async with asyncio.timeout(20):
                    callback_files = [
                        await self.adapter.get_metadata(
                            file_id=file_id, access_token=callback_access_token
                        )
                        for file_id in ids
                    ]
                    files = [
                        await self.adapter.get_metadata(
                            file_id=file_id, access_token=credential["accessToken"]
                        )
                        for file_id in ids
                    ]
            except TimeoutError:
                raise DriveReadError("provider_unavailable", retryable=True) from None
            if callback_files != files:
                raise DriveReadError("source_changed", retryable=True)
            # A disconnect, credential refresh, registry policy change or account
            # switch during provider I/O must suppress staging.
            _, row, credential = await self._current(str(attempt["user_id"]))
            self._same_attempt(attempt, row, credential, client_id=client_id)
            if not hmac.compare_digest(str(credential["subject"]), proof["subject"]):
                raise DriveOAuthError("identity_not_verified", status_code=401)
            envelope = self.oauth.credentials.encrypt_secret(
                json.dumps(
                    {
                        "version": _PICKER_RESULT_VERSION,
                        # Preserve the start-time subject binding only in this
                        # encrypted envelope: proof is scrubbed after staging,
                        # but confirmation must still fence a same-version
                        # credential substitution.
                        "subject": proof["subject"],
                        "files": _candidate_payload(files),
                    },
                    separators=(",", ":"),
                ),
                aad=_attempt_aad(attempt, "candidates"),
            )
            if not await self.store.stage_candidates(
                attempt_id=attempt_id,
                candidates_ciphertext=envelope["ciphertext"],
                candidates_iv=envelope["iv"],
                candidate_count=len(files),
            ):
                raise DriveReadError("selection_expired")
            return True
        except Exception:
            # This path owns the callback claim, so it may safely scrub it.
            # A concurrent/replayed callback never reaches this block.
            await self.store.discard_callback(attempt_id=attempt_id, claimed=True)
            raise

    def _open_candidates(self, attempt: dict[str, Any]) -> tuple[str, list[dict[str, Any]]]:
        try:
            plaintext = self.oauth.credentials.decrypt_secret(
                ciphertext=attempt["candidates_ciphertext"],
                iv=attempt["candidates_iv"],
                aad=_attempt_aad(attempt, "candidates"),
            )
        except ExternalConnectorCredentialError:
            raise DriveReadError("selection_expired") from None
        return _decode_candidates(plaintext)

    async def pending(self, *, user_id: str) -> dict[str, Any] | None:
        attempt = await self.store.pending(user_id=user_id)
        if attempt is None:
            return None
        try:
            _, candidates = self._open_candidates(attempt)
        except DriveReadError:
            await self.store.discard_callback(
                attempt_id=str(attempt["attempt_id"]), claimed=True, staged=True
            )
            return None
        return {
            "attemptId": str(attempt["attempt_id"]),
            "expiresAt": attempt["expires_at"].isoformat(),
            "files": [
                {
                    "documentId": candidate["documentId"],
                    "name": candidate["metadata"].name,
                    "mimeType": candidate["metadata"].mime_type,
                }
                for candidate in candidates
            ],
        }

    async def confirm(
        self, *, user_id: str, attempt_id: str, processing_consent: str | None = None
    ) -> list[dict[str, Any]]:
        if processing_consent is not None:
            if processing_consent != PROCESSING_DISCLOSURE_VERSION:
                raise DriveReadError("processing_consent_required")
            # Avoid contacting Google for optional background processing when
            # its distinct feature gate is no longer admitted. The catalog-only
            # confirmation path deliberately remains available without this.
            if not connector_feature_enabled("drive_document_indexing", user_id):
                raise DriveReadError("connector_unavailable")
        lease_id = str(uuid.uuid4())
        attempt = await self.store.claim_confirmation(
            user_id=user_id, attempt_id=attempt_id, lease_id=lease_id
        )
        if attempt is None:
            raise DriveReadError("selection_expired")
        try:
            staged_subject, candidates = self._open_candidates(attempt)
            _, row, credential = await self._current(user_id)
            _, client_id, _ = await self.oauth._configuration()
            self._same_attempt(attempt, row, credential, client_id=client_id)
            if not hmac.compare_digest(str(credential["subject"]), staged_subject):
                raise DriveReadError("connection_changed")
            try:
                async with asyncio.timeout(20):
                    files = [
                        await self.adapter.get_metadata(
                            file_id=candidate["metadata"].file_id,
                            access_token=credential["accessToken"],
                        )
                        for candidate in candidates
                    ]
            except TimeoutError:
                raise DriveReadError("provider_unavailable", retryable=True) from None
            if files != [candidate["metadata"] for candidate in candidates]:
                # Picker display metadata is part of what the owner reviewed.
                # A changed file needs a fresh selection/review, not silent
                # insertion under the old confirmation screen.
                raise DriveReadError("source_changed", retryable=True)
            _, row, credential = await self._current(user_id)
            self._same_attempt(attempt, row, credential, client_id=client_id)
            if not hmac.compare_digest(str(credential["subject"]), staged_subject):
                raise DriveReadError("connection_changed")
            return cast(
                list[dict[str, Any]],
                await self.store.complete_confirmation(
                    user_id=user_id,
                    attempt_id=attempt_id,
                    lease_id=lease_id,
                    files=files,
                    processing_consent=processing_consent,
                ),
            )
        except Exception:
            await self.store.release_confirmation(
                user_id=user_id, attempt_id=attempt_id, lease_id=lease_id
            )
            raise

    async def cancel(self, *, user_id: str, attempt_id: str) -> str:
        outcome: str = await self.store.cancel(user_id=user_id, attempt_id=attempt_id)
        return outcome
