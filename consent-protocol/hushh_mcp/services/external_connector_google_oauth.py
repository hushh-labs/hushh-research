"""Drive's Google OAuth adapter over the shared external-connector lifecycle.

Mail/Calendar keep their existing domain and clients. No transport verification
or Drive execution is inferred from consent; activation enters `verifying`.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import os
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from urllib.parse import urlencode

import httpx
import requests
from google.auth.transport.requests import Request
from google.oauth2 import id_token

from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.external_connector_credentials_service import (
    ExternalConnectorCredentialError,
)
from hushh_mcp.services.external_connector_lifecycle_store import ExternalConnectorLifecycleStore
from hushh_mcp.services.google_drive_adapter import (
    DRIVE_FILE_SCOPE,
    DRIVE_POLICY,
    LIVE_POLICY_HASH,
    GoogleDriveAdapter,
)

CONNECTOR_ID = "google_drive"
AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"  # noqa: S105 - public provider URL, not a token
REVOKE_URL = "https://oauth2.googleapis.com/revoke"
SCOPES = ("openid", "email", DRIVE_FILE_SCOPE)
LIVE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive"
LIVE_SCOPES = ("openid", "email", LIVE_DRIVE_SCOPE)
REGISTRY_SCOPES = (*SCOPES, LIVE_DRIVE_SCOPE)
DriveProfile = Literal["selected", "live"]
RESPONSE_LIMIT = 256 * 1024


class DriveOAuthError(RuntimeError):
    def __init__(self, code: str, *, status_code: int = 400):
        super().__init__(code)
        self.status_code = status_code


class _BoundedIdentityRequest(Request):
    def __call__(self, *args, **kwargs):
        kwargs["timeout"] = 5
        return super().__call__(*args, **kwargs)


def _attempt_aad(row: dict[str, Any], purpose: str) -> str:
    return json.dumps(
        [
            "external-connector-attempt-v2",
            purpose,
            row["user_id"],
            row["connector_id"],
            row["attempt_id"],
            row["connection_generation"],
        ],
        separators=(",", ":"),
    )


def _scopes(value: Any) -> set[str]:
    if not isinstance(value, str):
        return set()
    return {
        "email" if item == "https://www.googleapis.com/auth/userinfo.email" else item
        for item in value.split()
    }


class ExternalConnectorGoogleOAuth:
    def __init__(self, *, db, registry, credentials, state_codec, lifecycle=None):
        self.registry = registry
        self.credentials = credentials
        self.state_codec = state_codec
        self.lifecycle = lifecycle or ExternalConnectorLifecycleStore(db)

    async def _configuration(self):
        connector = await self.registry.get_connector(CONNECTOR_ID)
        if connector is None or connector.auth_style != "oauth":
            raise DriveOAuthError("connector_unavailable", status_code=503)
        if (
            connector.oauth_authorize_url != AUTHORIZE_URL
            or connector.oauth_token_url != TOKEN_URL
            or frozenset(connector.oauth_scopes)
            not in {frozenset(SCOPES), frozenset(REGISTRY_SCOPES)}
            or connector.oauth_client_id_env != "GOOGLE_DRIVE_OAUTH_CLIENT_ID"
            or connector.oauth_client_secret_env != "GOOGLE_DRIVE_OAUTH_CLIENT_SECRET"  # noqa: S105 - configuration key name
        ):
            raise DriveOAuthError("connector_configuration_invalid", status_code=503)
        client_id = os.getenv("GOOGLE_DRIVE_OAUTH_CLIENT_ID", "").strip()
        client_secret = os.getenv("GOOGLE_DRIVE_OAUTH_CLIENT_SECRET", "").strip()
        if not client_id or not client_secret:
            raise DriveOAuthError("connector_unavailable", status_code=503)
        return connector, client_id, client_secret

    async def start(
        self,
        *,
        user_id: str,
        redirect_uri: str,
        flow: str = "web",
        profile: DriveProfile = "selected",
    ) -> dict[str, Any]:
        if not connector_feature_enabled("google_drive_connection", user_id):
            raise DriveOAuthError("connector_unavailable", status_code=403)
        connector, client_id, _ = await self._configuration()
        if profile not in {"selected", "live"} or (
            profile == "live"
            and (
                not connector_feature_enabled("google_drive_live", user_id)
                or set(connector.oauth_scopes) != set(REGISTRY_SCOPES)
                or connector.capability_policy != DRIVE_POLICY
            )
        ):
            raise DriveOAuthError("profile_unavailable", status_code=403)
        if flow not in {"web", "native"} or redirect_uri not in connector.registered_redirect_uris:
            raise DriveOAuthError("redirect_not_registered")
        # A native provider callback is backend-only, never an app/universal link.
        if (flow == "native") != redirect_uri.endswith("/api/connectors/oauth/native/callback"):
            raise DriveOAuthError("redirect_flow_mismatch")
        attempt_id, verifier, nonce = (secrets.token_urlsafe(32) for _ in range(3))
        # The generation is assigned atomically in start_attempt. PKCE material
        # uses owner/connector/attempt binding; pending tokens additionally bind generation.
        aad = json.dumps(
            ["external-connector-pkce-v2", user_id, CONNECTOR_ID, attempt_id], separators=(",", ":")
        )
        encrypted = self.credentials.encrypt_secret(
            json.dumps({"verifier": verifier, "nonce": nonce, "profile": profile}), aad=aad
        )
        attempt = await self.lifecycle.start_attempt(
            user_id=user_id,
            connector_id=CONNECTOR_ID,
            attempt_id=attempt_id,
            client_id=client_id,
            redirect_uri=redirect_uri,
            flow=flow,
            ciphertext=encrypted["ciphertext"],
            iv=encrypted["iv"],
        )
        query = dict(
            client_id=client_id,
            redirect_uri=redirect_uri,
            response_type="code",
            scope=" ".join(LIVE_SCOPES if profile == "live" else SCOPES),
            state=self.state_codec._signed_state(attempt_id),
            code_challenge=self.state_codec._pkce_challenge(verifier),
            code_challenge_method="S256",
            nonce=nonce,
            access_type="offline",
            prompt="consent",
            include_granted_scopes="false",
        )
        return {
            "authorizeUrl": f"{AUTHORIZE_URL}?{urlencode(query)}",
            "attemptId": attempt_id,
            "connectorId": CONNECTOR_ID,
            "expiresAt": attempt["expires_at"].isoformat(),
        }

    async def _post(self, url: str, data: dict[str, str]) -> dict[str, Any]:
        # Fixed endpoints only, no redirects and no response/request-body logging.
        if url not in {TOKEN_URL, REVOKE_URL}:
            raise DriveOAuthError("connector_configuration_invalid", status_code=503)
        try:
            async with (
                asyncio.timeout(20),
                httpx.AsyncClient(timeout=15, follow_redirects=False) as client,
            ):
                async with client.stream(
                    "POST", url, data=data, headers={"Accept": "application/json"}
                ) as response:
                    payload = bytearray()
                    async for chunk in response.aiter_bytes():
                        payload.extend(chunk)
                        if len(payload) > RESPONSE_LIMIT:
                            raise DriveOAuthError("provider_response_too_large", status_code=502)
                    if url == REVOKE_URL and response.status_code == 200:
                        return {}
                    try:
                        parsed = json.loads(payload)
                    except (ValueError, UnicodeError):
                        raise DriveOAuthError("provider_unavailable", status_code=502) from None
                    if not isinstance(parsed, dict):
                        raise DriveOAuthError("provider_unavailable", status_code=502)
                    if response.status_code != 200:
                        if response.status_code == 400 and parsed.get("error") == "invalid_grant":
                            raise DriveOAuthError("grant_rejected", status_code=401)
                        raise DriveOAuthError("provider_unavailable", status_code=503)
                    return parsed
        except (httpx.HTTPError, TimeoutError):
            raise DriveOAuthError("provider_unavailable", status_code=503) from None

    def _verify_identity(
        self, encoded: str, *, client_id: str, nonce: str | None
    ) -> dict[str, str]:
        try:
            # Official verifier checks signature, audience, issuer and expiry.
            with requests.Session() as session:
                claims = id_token.verify_oauth2_token(
                    encoded, _BoundedIdentityRequest(session=session), audience=client_id
                )
            subject, email = claims.get("sub"), claims.get("email")
            if (
                not isinstance(subject, str)
                or not 1 <= len(subject) <= 255
                or not isinstance(email, str)
                or not 1 <= len(email) <= 254
                or claims.get("email_verified") is not True
                or claims.get("aud") != client_id
                or claims.get("azp", client_id) != client_id
                or (
                    nonce is not None
                    and not hmac.compare_digest(str(claims.get("nonce", "")), nonce)
                )
            ):
                raise ValueError("identity mismatch")
            return {"subject": subject, "accountLabel": email}
        except Exception:
            raise DriveOAuthError("identity_not_verified", status_code=401) from None

    def _token_fields(
        self,
        token: dict[str, Any],
        *,
        previous: dict[str, Any] | None = None,
        profile: DriveProfile = "selected",
    ) -> dict[str, Any]:
        expected = set(LIVE_SCOPES if profile == "live" else SCOPES)
        scopes = _scopes(token.get("scope"))
        # Refresh may omit scope: RFC 6749 preserves the grant from this exact
        # encrypted envelope. Initial authorization must explicitly report it.
        if "scope" not in token and previous:
            scopes = set(previous["grantedScopes"])
        if not expected.issubset(scopes):
            raise DriveOAuthError("insufficient_scope", status_code=403)
        allowed = (expected, expected | {DRIVE_FILE_SCOPE}) if profile == "live" else (expected,)
        if scopes not in allowed:
            # Do not accidentally accept a pre-existing broad Drive or combined
            # Gmail grant for the selected-file product boundary.
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
        refresh = token.get("refresh_token")
        if refresh is not None and (not isinstance(refresh, str) or not 1 <= len(refresh) <= 16384):
            raise DriveOAuthError("provider_response_invalid", status_code=502)
        return dict(
            accessToken=access,
            refreshToken=refresh,
            grantedScopes=sorted(scopes),
            expiresAt=(datetime.now(UTC) + timedelta(seconds=expiry)).isoformat(),
        )

    async def _exchange(self, *, state: str, code: str, owner: str | None) -> tuple[dict, dict]:
        attempt_id = self.state_codec._verify_state(state)
        attempt = await self.lifecycle.claim_attempt(attempt_id=attempt_id, user_id=owner)
        if attempt is None or attempt["connector_id"] != CONNECTOR_ID:
            raise DriveOAuthError("attempt_unavailable", status_code=409)
        if not connector_feature_enabled("google_drive_connection", attempt["user_id"]):
            raise DriveOAuthError("connector_unavailable", status_code=403)
        connector, client_id, client_secret = await self._configuration()
        if (
            attempt["oauth_client_id"] != client_id
            or attempt["redirect_uri"] not in connector.registered_redirect_uris
        ):
            raise DriveOAuthError("attempt_configuration_changed", status_code=409)
        aad = json.dumps(
            ["external-connector-pkce-v2", attempt["user_id"], CONNECTOR_ID, attempt_id],
            separators=(",", ":"),
        )
        try:
            proof = json.loads(
                self.credentials.decrypt_secret(
                    ciphertext=attempt["code_verifier_ciphertext"],
                    iv=attempt["code_verifier_iv"],
                    aad=aad,
                )
            )
        except (ValueError, ExternalConnectorCredentialError):
            raise DriveOAuthError("attempt_unavailable", status_code=409) from None
        token = await self._post(
            TOKEN_URL,
            dict(
                grant_type="authorization_code",
                code=code,
                redirect_uri=attempt["redirect_uri"],
                client_id=client_id,
                client_secret=client_secret,
                code_verifier=proof["verifier"],
            ),
        )
        profile = proof.get("profile", "selected")
        if profile not in {"selected", "live"} or (
            profile == "live"
            and (
                not connector_feature_enabled("google_drive_live", attempt["user_id"])
                or set(connector.oauth_scopes) != set(REGISTRY_SCOPES)
                or connector.capability_policy != DRIVE_POLICY
            )
        ):
            raise DriveOAuthError("attempt_configuration_changed", status_code=409)
        credential = self._token_fields(token, profile=profile)
        identity = await asyncio.to_thread(
            self._verify_identity,
            str(token.get("id_token", "")),
            client_id=client_id,
            nonce=proof["nonce"],
        )
        credential.update(identity, oauthClientId=client_id, profile=profile)
        return attempt, credential

    def _seal_activation(self, attempt: dict, current: dict, credential: dict) -> dict:
        if not connector_feature_enabled("google_drive_connection", attempt["user_id"]):
            raise DriveOAuthError("connector_unavailable", status_code=403)
        credential = dict(credential)
        # Never preserve a refresh token across a different account, client, or
        # disconnect/reconnect generation. Both identities were verified by OIDC.
        if (
            not credential.get("refreshToken")
            and current.get("credential_ciphertext")
            and current.get("envelope_version") == 2
        ):
            previous = self.credentials.open_credential(
                user_id=attempt["user_id"], connector_id=CONNECTOR_ID, row=current
            )
            if (
                current["connection_generation"] == attempt["connection_generation"]
                and previous.get("subject") == credential.get("subject")
                and previous.get("oauthClientId") == credential.get("oauthClientId")
                and previous.get("profile", "selected") == credential.get("profile", "selected")
            ):
                credential["refreshToken"] = previous.get("refreshToken")
        if not credential.get("refreshToken"):
            raise DriveOAuthError("offline_consent_required", status_code=409)
        return self.credentials.seal_credential(
            user_id=attempt["user_id"],
            connector_id=CONNECTOR_ID,
            generation=current["connection_generation"] + 1,
            version=current["credential_version"] + 1,
            secret=credential,
            expires_at=datetime.fromisoformat(credential["expiresAt"]),
        )

    async def complete(self, *, state: str, code: str, expected_user_id: str) -> dict[str, str]:
        attempt, credential = await self._exchange(state=state, code=code, owner=expected_user_id)
        if attempt["flow"] != "web":
            raise DriveOAuthError("attempt_flow_mismatch", status_code=409)
        connector, client_id, _ = await self._configuration()
        if (
            attempt["oauth_client_id"] != client_id
            or attempt["redirect_uri"] not in connector.registered_redirect_uris
        ):
            raise DriveOAuthError("attempt_configuration_changed", status_code=409)
        result = await self.lifecycle.finalize(
            attempt_id=attempt["attempt_id"],
            user_id=expected_user_id,
            seal=lambda attempt, current: self._seal_activation(attempt, current, credential),
        )
        if result is None:
            raise DriveOAuthError("attempt_unavailable", status_code=409)
        status = "verifying"
        if credential["profile"] == "live":
            try:
                if await self.verify_live(user_id=expected_user_id):
                    status = "connected"
            except (DriveOAuthError, ExternalConnectorCredentialError):
                pass  # The staged grant remains unverified and cannot serve live reads.
        return {"connectorId": CONNECTOR_ID, "status": status}

    async def complete_native(self, *, state: str, code: str) -> dict[str, str]:
        attempt, credential = await self._exchange(state=state, code=code, owner=None)
        encrypted = self.credentials.encrypt_secret(
            json.dumps(credential), aad=_attempt_aad(attempt, "pending")
        )
        staged = await self.lifecycle.stage_native(
            attempt_id=attempt["attempt_id"],
            ciphertext=encrypted["ciphertext"],
            iv=encrypted["iv"],
            expires_at=datetime.fromisoformat(credential["expiresAt"]),
        )
        if not staged:
            raise DriveOAuthError("attempt_unavailable", status_code=409)
        return {"attemptId": attempt["attempt_id"], "outcome": "ready"}

    async def pending_native(self, *, user_id: str) -> dict[str, str] | None:
        if not connector_feature_enabled("google_drive_connection", user_id):
            return None
        attempt = await self.lifecycle.pending_native(user_id=user_id, connector_id=CONNECTOR_ID)
        if not attempt:
            return None
        return {"attemptId": attempt["attempt_id"], "expiresAt": attempt["expires_at"].isoformat()}

    async def finalize_native(self, *, attempt_id: str, user_id: str) -> dict[str, str]:
        connector, client_id, _ = await self._configuration()

        def seal(attempt, current):
            if attempt["flow"] != "native" or attempt["connector_id"] != CONNECTOR_ID:
                raise DriveOAuthError("attempt_flow_mismatch", status_code=409)
            if (
                attempt["oauth_client_id"] != client_id
                or attempt["redirect_uri"] not in connector.registered_redirect_uris
            ):
                raise DriveOAuthError("attempt_configuration_changed", status_code=409)
            credential = json.loads(
                self.credentials.decrypt_secret(
                    ciphertext=attempt["pending_credential_ciphertext"],
                    iv=attempt["pending_credential_iv"],
                    aad=_attempt_aad(attempt, "pending"),
                )
            )
            return self._seal_activation(attempt, current, credential)

        result = await self.lifecycle.finalize(attempt_id=attempt_id, user_id=user_id, seal=seal)
        if result is None:
            raise DriveOAuthError("attempt_unavailable", status_code=409)
        status = "verifying"
        try:
            row, credential = await self.current_credential(user_id=user_id)
            if (
                row["connection_generation"] == result["connection_generation"]
                and credential.get("profile") == "live"
            ):
                if await self.verify_live(user_id=user_id):
                    status = "connected"
        except (DriveOAuthError, ExternalConnectorCredentialError):
            pass
        return {"connectorId": CONNECTOR_ID, "status": status}

    async def current_credential(
        self, *, user_id: str, required_profile: DriveProfile | None = None
    ) -> tuple[dict, dict]:
        """Internal only. Execution additionally enforces policy before/after I/O."""
        row = await self.lifecycle.read(user_id=user_id, connector_id=CONNECTOR_ID)
        if (
            not row
            or row["status"] not in {"connected", "verifying"}
            or row["envelope_version"] != 2
        ):
            raise DriveOAuthError("reconnect_required", status_code=401)
        credential = self.credentials.open_credential(
            user_id=user_id, connector_id=CONNECTOR_ID, row=row
        )
        profile = credential.get("profile", "selected")
        if profile not in {"selected", "live"} or (
            required_profile is not None and profile != required_profile
        ):
            raise DriveOAuthError("reconnect_required", status_code=401)
        expected = set(LIVE_SCOPES if profile == "live" else SCOPES)
        scopes = set(credential.get("grantedScopes", []))
        allowed = (expected, expected | {DRIVE_FILE_SCOPE}) if profile == "live" else (expected,)
        if scopes not in allowed:
            raise DriveOAuthError("reconnect_required", status_code=401)
        connector, client_id, client_secret = await self._configuration()
        if profile == "live" and (
            connector.capability_policy != DRIVE_POLICY
            or set(connector.oauth_scopes) != set(REGISTRY_SCOPES)
        ):
            raise DriveOAuthError("connector_configuration_invalid", status_code=503)
        if credential.get("oauthClientId") != client_id:
            raise DriveOAuthError("reconnect_required", status_code=401)
        if row["credential_expires_at"] > datetime.now(UTC) + timedelta(seconds=90):
            return row, credential
        common = dict(
            user_id=user_id,
            connector_id=CONNECTOR_ID,
            generation=row["connection_generation"],
            version=row["credential_version"],
        )
        lease_id = secrets.token_urlsafe(24)
        if not await self.lifecycle.claim_refresh(**common, lease_id=lease_id):
            raise DriveOAuthError("refresh_in_progress", status_code=409)
        try:
            token = await self._post(
                TOKEN_URL,
                dict(
                    grant_type="refresh_token",
                    refresh_token=credential["refreshToken"],
                    client_id=client_id,
                    client_secret=client_secret,
                ),
            )
            refreshed = {
                **credential,
                **self._token_fields(token, previous=credential, profile=profile),
            }
            refreshed["refreshToken"] = refreshed.get("refreshToken") or credential["refreshToken"]
            if token.get("id_token"):
                identity = await asyncio.to_thread(
                    self._verify_identity, token["id_token"], client_id=client_id, nonce=None
                )
                if identity["subject"] != credential["subject"]:
                    raise DriveOAuthError("identity_not_verified", status_code=401)
                refreshed.update(identity)
            encrypted = self.credentials.seal_credential(
                user_id=user_id,
                connector_id=CONNECTOR_ID,
                generation=common["generation"],
                version=common["version"] + 1,
                secret=refreshed,
                expires_at=datetime.fromisoformat(refreshed["expiresAt"]),
            )
            if not await self.lifecycle.settle_refresh(
                **common, lease_id=lease_id, envelope=encrypted
            ):
                raise DriveOAuthError("connection_changed", status_code=409)
        except DriveOAuthError as error:
            await self.lifecycle.settle_refresh(
                **common, lease_id=lease_id, rejected=str(error) == "grant_rejected"
            )
            raise
        updated = await self.lifecycle.read(user_id=user_id, connector_id=CONNECTOR_ID)
        if (
            not updated
            or updated["connection_generation"] != common["generation"]
            or updated["status"] not in {"connected", "verifying"}
        ):
            raise DriveOAuthError("connection_changed", status_code=409)
        return updated, self.credentials.open_credential(
            user_id=user_id, connector_id=CONNECTOR_ID, row=updated
        )

    async def verify_live(self, *, user_id: str) -> bool:
        """Prove the current broad grant against Drive before exposing it as connected."""
        if not connector_feature_enabled("google_drive_live", user_id):
            raise DriveOAuthError("connector_unavailable", status_code=403)
        row, credential = await self.current_credential(user_id=user_id, required_profile="live")
        await GoogleDriveAdapter().account(access_token=credential["accessToken"])
        return await self.lifecycle.mark_verified(
            user_id=user_id,
            connector_id=CONNECTOR_ID,
            generation=row["connection_generation"],
            version=row["credential_version"],
            policy_hash=LIVE_POLICY_HASH,
        )

    async def disconnect(self, *, user_id: str) -> dict[str, str]:
        old = await self.lifecycle.disconnect(user_id=user_id, connector_id=CONNECTOR_ID)
        if not old.get("credential_ciphertext"):
            return {
                "status": "revoked",
                "connectorId": CONNECTOR_ID,
                "revocationOutcome": old.get("revocation_outcome", "not_attempted"),
            }
        outcome = "unavailable"
        try:
            # Legacy envelopes have no verified OAuth client/identity binding;
            # never revoke an unknown project's grant (it could include Mail).
            if old.get("envelope_version") != 2:
                raise DriveOAuthError("revocation_identity_unverified", status_code=409)
            credential = self.credentials.open_credential(
                user_id=user_id, connector_id=CONNECTOR_ID, row=old
            )
            token = credential.get("refreshToken") or credential.get("accessToken")
            if token:
                # Bound work more tightly than the durable reconnect fence.
                async with asyncio.timeout(10):
                    await self._post(REVOKE_URL, {"token": token})
                outcome = "revoked"
        except (DriveOAuthError, ExternalConnectorCredentialError, TimeoutError):
            outcome = "failed"
        await self.lifecycle.record_revocation(
            user_id=user_id,
            connector_id=CONNECTOR_ID,
            generation=old["connection_generation"] + 1,
            outcome=outcome,
        )
        return {"status": "revoked", "connectorId": CONNECTOR_ID, "revocationOutcome": outcome}
