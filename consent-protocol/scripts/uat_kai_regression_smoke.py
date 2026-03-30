#!/usr/bin/env python3
"""Live UAT regression smoke for the Kai test user.

Runs against the hosted UAT backend using the real Firebase/Kai auth path and
verifies the recent consent/PKM/RIA integration lanes together:

- PKM metadata + upgrade route reachability
- strict zero-knowledge developer consent/export flow
- asymmetric scope reuse behavior
- consent export refresh queue + refresh upload
- RIA implicit picks-share relationship gating

This script is intentionally UAT-only and mutates Kai test-user state.
Do not point it at production.
"""

from __future__ import annotations

import argparse
import base64
import copy
import json
import os
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote_plus

import jwt
import requests
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import (
    X25519PrivateKey,
    X25519PublicKey,
)
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from dotenv import dotenv_values

DEFAULT_BACKEND_URL = "https://consent-protocol-f2gsa4kfsq-uc.a.run.app"
DEFAULT_PROTOCOL_ENV = os.path.expanduser(
    "~/Documents/GitHub/hushh-research/consent-protocol/.env.uat-remote.local"
)
DEFAULT_WEBAPP_ENV = os.path.expanduser(
    "~/Documents/GitHub/hushh-research/hushh-webapp/.env.uat-remote.local"
)
DEFAULT_TIMEOUT = 45


def _b64encode(value: bytes) -> str:
    return base64.b64encode(value).decode("utf-8")


def _b64decode(value: str) -> bytes:
    normalized = str(value or "").strip().replace("-", "+").replace("_", "/")
    while normalized and len(normalized) % 4 != 0:
        normalized += "="
    return base64.b64decode(normalized)


def _require(config: dict[str, Any], key: str) -> str:
    value = str(config.get(key) or "").strip()
    if not value:
        raise RuntimeError(f"Missing required config value: {key}")
    return value


def _canonical_segment_id(segment_id: str) -> str:
    normalized = "".join(
        ch.lower() if ch.isalnum() or ch == "_" else "_" for ch in str(segment_id or "").strip()
    ).strip("_")
    return normalized or "root"


def _partition_domain_segments(domain_data: dict[str, Any]) -> dict[str, Any]:
    segmented: dict[str, Any] = {}
    root_payload: dict[str, Any] = {}
    for key, value in (domain_data or {}).items():
        segment_id = _canonical_segment_id(key)
        is_segment_candidate = value is not None and isinstance(value, (dict, list))
        if not is_segment_candidate or segment_id == "root":
            root_payload[key] = value
            continue
        segmented[segment_id] = value
    if root_payload or not segmented:
        segmented["root"] = root_payload
    return segmented


def _extract_path_value(value: Any, segments: list[str]) -> Any:
    if not segments:
        return copy.deepcopy(value)
    segment = segments[0]
    rest = segments[1:]
    if segment == "_items":
        if not isinstance(value, list):
            return None
        extracted = [_extract_path_value(item, rest) for item in value]
        filtered = [item for item in extracted if item is not None]
        return filtered or None
    if not isinstance(value, dict) or segment not in value:
        return None
    return _extract_path_value(value[segment], rest)


def _rebuild_projected_value(segments: list[str], value: Any) -> Any:
    if not segments:
        return copy.deepcopy(value)
    segment = segments[0]
    rest = segments[1:]
    if segment == "_items":
        if not isinstance(value, list):
            return []
        return [_rebuild_projected_value(rest, item) for item in value]
    return {segment: _rebuild_projected_value(rest, value)}


def project_domain_data_for_scope(
    domain: str, scope: str, domain_data: dict[str, Any]
) -> dict[str, Any]:
    if scope in {"pkm.read", f"attr.{domain}.*"}:
        return {domain: copy.deepcopy(domain_data)}

    prefix = f"attr.{domain}."
    if not scope.startswith(prefix):
        return {domain: {}}

    raw_path = scope[len(prefix) :].removesuffix(".*")
    normalized_segments = [
        "".join(ch.lower() if ch.isalnum() or ch == "_" else "_" for ch in segment).strip("_")
        for segment in raw_path.split(".")
    ]
    normalized_segments = [segment for segment in normalized_segments if segment]
    if not normalized_segments:
        return {domain: copy.deepcopy(domain_data)}

    extracted = _extract_path_value(domain_data, normalized_segments)
    if extracted is None:
        return {domain: {}}
    return {domain: _rebuild_projected_value(normalized_segments, extracted)}


def narrow_decrypted_export(payload: dict[str, Any], expected_scope: str | None) -> dict[str, Any]:
    if not expected_scope:
        return copy.deepcopy(payload)
    export_metadata = payload.get("__export_metadata")
    source_domain = None
    if isinstance(export_metadata, dict):
        source_domain = str(export_metadata.get("source_domain") or "").strip() or None
    if not source_domain and expected_scope.startswith("attr."):
        parts = expected_scope.split(".")
        if len(parts) >= 2:
            source_domain = parts[1]
    if not source_domain:
        return copy.deepcopy(payload)
    domain_data = payload.get(source_domain)
    if not isinstance(domain_data, dict):
        return copy.deepcopy(payload)
    narrowed = project_domain_data_for_scope(source_domain, expected_scope, domain_data)
    if "__export_metadata" in payload:
        narrowed["__export_metadata"] = copy.deepcopy(payload["__export_metadata"])
    return narrowed


@dataclass
class AuthSession:
    firebase_id_token: str
    vault_owner_token: str
    user_id: str
    email: str
    passphrase: str


@dataclass
class ConnectorKeyPair:
    x25519_box: X25519PrivateKey
    public_key_b64: str
    key_id: str


class UatKaiSmoke:
    def __init__(
        self, *, backend_url: str, protocol_env: str, web_env: str, timeout: int = DEFAULT_TIMEOUT
    ):
        protocol_cfg = dotenv_values(protocol_env)
        web_cfg = dotenv_values(web_env)
        self.config = {**protocol_cfg, **web_cfg}
        self.backend_url = backend_url.rstrip("/")
        self.timeout = timeout
        self.user_id = _require(self.config, "KAI_TEST_USER_ID")
        self.passphrase = _require(self.config, "KAI_TEST_PASSPHRASE")
        self.developer_token = str(self.config.get("MCP_DEVELOPER_TOKEN") or "").strip() or None
        self.firebase_auth_service_account = json.loads(
            _require(self.config, "FIREBASE_AUTH_SERVICE_ACCOUNT_JSON")
        )
        self.firebase_api_key = _require(self.config, "NEXT_PUBLIC_AUTH_FIREBASE_API_KEY")
        self.session = requests.Session()
        self.auth: AuthSession | None = None
        self.vault_key_hex: str | None = None
        self.connector = self._new_connector_keypair()
        self.connector_private = self.connector.x25519_box

    def log(self, message: str) -> None:
        print(f"[uat-smoke] {message}")

    def _request(
        self,
        method: str,
        path: str,
        *,
        headers: dict[str, str] | None = None,
        json_body: Any | None = None,
        params: dict[str, Any] | None = None,
        expected: int | None = 200,
    ) -> requests.Response:
        response = self.session.request(
            method,
            f"{self.backend_url}{path}",
            headers=headers,
            json=json_body,
            params=params,
            timeout=self.timeout,
        )
        if expected is not None and response.status_code != expected:
            raise RuntimeError(
                f"{method} {path} returned {response.status_code}: {response.text[:1200]}"
            )
        return response

    def _firebase_auth_headers(self) -> dict[str, str]:
        if not self.auth:
            raise RuntimeError("Auth session not initialized")
        return {"Authorization": f"Bearer {self.auth.firebase_id_token}"}

    def _vault_headers(self) -> dict[str, str]:
        if not self.auth:
            raise RuntimeError("Auth session not initialized")
        return {"Authorization": f"Bearer {self.auth.vault_owner_token}"}

    def _new_connector_keypair(self) -> ConnectorKeyPair:
        generated_private_key = X25519PrivateKey.generate()
        public_key = generated_private_key.public_key().public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw,
        )
        return ConnectorKeyPair(
            x25519_box=generated_private_key,
            public_key_b64=_b64encode(public_key),
            key_id=f"kai-smoke-{int(time.time())}",
        )

    def authenticate(self) -> None:
        now = int(time.time())
        custom_token = jwt.encode(
            {
                "iss": self.firebase_auth_service_account["client_email"],
                "sub": self.firebase_auth_service_account["client_email"],
                "aud": "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit",
                "uid": self.user_id,
                "iat": now,
                "exp": now + 3600,
            },
            self.firebase_auth_service_account["private_key"],
            algorithm="RS256",
        )
        response = requests.post(
            f"https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key={self.firebase_api_key}",
            json={"token": custom_token, "returnSecureToken": True},
            timeout=self.timeout,
        )
        if response.status_code != 200:
            raise RuntimeError(f"Firebase custom-token exchange failed: {response.text[:1200]}")
        auth_payload = response.json()
        firebase_id_token = auth_payload["idToken"]
        email = str(auth_payload.get("email") or "").strip()

        vault_response = self._request(
            "POST",
            "/api/consent/vault-owner-token",
            headers={
                **self._firebase_auth_headers_from(firebase_id_token),
                "Content-Type": "application/json",
            },
            json_body={"userId": self.user_id},
        )
        self.auth = AuthSession(
            firebase_id_token=firebase_id_token,
            vault_owner_token=vault_response.json()["token"],
            user_id=self.user_id,
            email=email,
            passphrase=self.passphrase,
        )
        self.log("Authenticated as Kai and issued a real VAULT_OWNER token.")
        self.ensure_developer_token()

    def ensure_developer_token(self) -> None:
        payload = self._request(
            "POST",
            "/api/developer/access/enable",
            headers=self._firebase_auth_headers(),
        ).json()
        active_token = str(payload.get("raw_token") or "").strip()
        if not active_token:
            payload = self._request(
                "POST",
                "/api/developer/access/rotate-key",
                headers=self._firebase_auth_headers(),
            ).json()
            active_token = str(payload.get("raw_token") or "").strip()
        if not active_token:
            raise RuntimeError(f"Developer portal did not return an active token: {payload}")
        self.developer_token = active_token
        self.log("Ensured an active self-serve developer token for the Kai test user.")

    def _firebase_auth_headers_from(self, firebase_id_token: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {firebase_id_token}"}

    def derive_vault_key(self) -> None:
        if not self.auth:
            raise RuntimeError("Auth session not initialized")
        response = self._request(
            "POST",
            "/db/vault/get",
            headers={**self._firebase_auth_headers(), "Content-Type": "application/json"},
            json_body={"userId": self.user_id},
        )
        payload = response.json()
        wrappers = payload.get("wrappers") or []
        wrapper = next(
            (item for item in wrappers if str(item.get("method") or "").strip() == "passphrase"),
            None,
        )
        if not isinstance(wrapper, dict):
            raise RuntimeError("Kai vault state is missing a passphrase wrapper.")
        kdf = PBKDF2HMAC(
            algorithm=hashes.SHA256(),
            length=32,
            salt=_b64decode(str(wrapper["salt"])),
            iterations=100000,
        )
        wrapping_key = kdf.derive(self.passphrase.encode("utf-8"))
        vault_key = AESGCM(wrapping_key).decrypt(
            _b64decode(str(wrapper["iv"])),
            _b64decode(str(wrapper["encryptedVaultKey"])),
            None,
        )
        self.vault_key_hex = vault_key.hex()
        self.log("Derived Kai vault key locally from the passphrase wrapper.")

    def fetch_pkm_metadata(self) -> dict[str, Any]:
        response = self._request(
            "GET",
            f"/api/pkm/metadata/{quote_plus(self.user_id)}",
            headers=self._vault_headers(),
        )
        payload = response.json()
        if not any(
            str(domain.get("key") or "") == "financial" for domain in payload.get("domains", [])
        ):
            raise RuntimeError("Expected the Kai test user to have a financial PKM domain.")
        return payload

    def fetch_upgrade_status(self) -> dict[str, Any]:
        response = self._request(
            "GET",
            f"/api/pkm/upgrade/status/{quote_plus(self.user_id)}",
            headers=self._vault_headers(),
        )
        return response.json()

    def get_persona_state(self) -> dict[str, Any]:
        response = self._request(
            "GET",
            "/api/iam/persona",
            headers=self._firebase_auth_headers(),
        )
        return response.json()

    def get_consent_center_summary(self, *, actor: str) -> dict[str, Any]:
        response = self._request(
            "GET",
            "/api/consent/center/summary",
            headers=self._vault_headers(),
            params={"actor": actor},
        )
        return response.json()

    def get_consent_center_list(
        self,
        *,
        actor: str,
        surface: str,
        top: int | None = None,
        page: int = 1,
        limit: int = 20,
        query: str | None = None,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {"actor": actor, "surface": surface}
        if top is not None:
            params["top"] = top
        else:
            params["page"] = page
            params["limit"] = limit
        if query:
            params["q"] = query
        response = self._request(
            "GET",
            "/api/consent/center/list",
            headers=self._vault_headers(),
            params=params,
        )
        return response.json()

    def _fetch_domain_manifest(self, domain: str) -> dict[str, Any]:
        response = self._request(
            "GET",
            f"/api/pkm/manifest/{quote_plus(self.user_id)}/{quote_plus(domain)}",
            headers=self._vault_headers(),
        )
        return response.json()

    def _fetch_domain_blob(self, domain: str) -> dict[str, Any]:
        response = self._request(
            "GET",
            f"/api/pkm/domain-data/{quote_plus(self.user_id)}/{quote_plus(domain)}",
            headers=self._vault_headers(),
        )
        return response.json()

    def _decrypt_domain_blob(self, blob_payload: dict[str, Any]) -> dict[str, Any]:
        if not self.vault_key_hex:
            raise RuntimeError("Vault key not initialized")
        encrypted_blob = blob_payload.get("encrypted_blob") or {}
        segments = encrypted_blob.get("segments") or {}
        aes = AESGCM(bytes.fromhex(self.vault_key_hex))
        if not segments:
            decrypted = aes.decrypt(
                _b64decode(str(encrypted_blob["iv"])),
                _b64decode(str(encrypted_blob["ciphertext"]))
                + _b64decode(str(encrypted_blob["tag"])),
                None,
            )
            return json.loads(decrypted)
        domain_data: dict[str, Any] = {}
        for segment_id, segment in segments.items():
            if not isinstance(segment, dict):
                continue
            decrypted = aes.decrypt(
                _b64decode(str(segment["iv"])),
                _b64decode(str(segment["ciphertext"])) + _b64decode(str(segment["tag"])),
                None,
            )
            parsed = json.loads(decrypted)
            if segment_id == "root" and isinstance(parsed, dict):
                domain_data.update(parsed)
            else:
                domain_data[segment_id] = parsed
        return domain_data

    def _encrypt_domain_blob(self, domain_data: dict[str, Any]) -> dict[str, Any]:
        if not self.vault_key_hex:
            raise RuntimeError("Vault key not initialized")
        aes = AESGCM(bytes.fromhex(self.vault_key_hex))

        def _encrypt_json(value: Any) -> dict[str, Any]:
            iv = os.urandom(12)
            encrypted = aes.encrypt(
                iv, json.dumps(value, separators=(",", ":")).encode("utf-8"), None
            )
            return {
                "ciphertext": _b64encode(encrypted[:-16]),
                "iv": _b64encode(iv),
                "tag": _b64encode(encrypted[-16:]),
                "algorithm": "aes-256-gcm",
            }

        segments = {
            segment_id: _encrypt_json(segment_value)
            for segment_id, segment_value in _partition_domain_segments(domain_data).items()
        }
        full = _encrypt_json(domain_data)
        full["segments"] = segments
        return full

    def _build_export_payload(self, scope: str) -> tuple[dict[str, Any], int | None, int | None]:
        if scope == "pkm.read":
            raise RuntimeError("This smoke script currently validates attr.* exports only.")
        if not scope.startswith("attr."):
            raise RuntimeError(f"Unsupported scope for smoke export builder: {scope}")
        _, domain, *_ = scope.split(".")
        manifest = self._fetch_domain_manifest(domain)
        blob_payload = self._fetch_domain_blob(domain)
        domain_data = self._decrypt_domain_blob(blob_payload)
        projected = project_domain_data_for_scope(domain, scope, domain_data)
        export_payload = {
            **projected,
            "__export_metadata": {
                "scope": scope,
                "source_domain": domain,
                "manifest_version": manifest.get("manifest_version"),
                "approved_paths": manifest.get("externalizable_paths") or [],
                "approved_segment_ids": blob_payload.get("segment_ids") or [],
                "export_timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            },
        }
        return (
            export_payload,
            blob_payload.get("data_version"),
            manifest.get("manifest_version"),
        )

    def _encrypt_export_payload(
        self,
        payload: dict[str, Any],
        *,
        connector_public_key_b64: str,
        connector_key_id: str,
    ) -> dict[str, str]:
        plaintext = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        export_key = os.urandom(32)
        export_iv = os.urandom(12)
        export_ciphertext = AESGCM(export_key).encrypt(export_iv, plaintext, None)

        sender_private = X25519PrivateKey.generate()
        connector_public_key = X25519PublicKey.from_public_bytes(
            _b64decode(connector_public_key_b64)
        )
        shared_secret = sender_private.exchange(connector_public_key)
        wrapping_key = hashes.Hash(hashes.SHA256())
        wrapping_key.update(shared_secret)
        wrapping_key_bytes = wrapping_key.finalize()

        wrapped_iv = os.urandom(12)
        wrapped = AESGCM(wrapping_key_bytes).encrypt(wrapped_iv, export_key, None)
        sender_public_key = sender_private.public_key().public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw,
        )

        return {
            "encryptedData": _b64encode(export_ciphertext[:-16]),
            "encryptedIv": _b64encode(export_iv),
            "encryptedTag": _b64encode(export_ciphertext[-16:]),
            "wrappedExportKey": _b64encode(wrapped[:-16]),
            "wrappedKeyIv": _b64encode(wrapped_iv),
            "wrappedKeyTag": _b64encode(wrapped[-16:]),
            "senderPublicKey": _b64encode(sender_public_key),
            "wrappingAlg": "X25519-AES256-GCM",
            "connectorKeyId": connector_key_id,
        }

    def _decrypt_scoped_export(self, package: dict[str, Any]) -> dict[str, Any]:
        wrapped = package.get("wrapped_key_bundle") or {}
        sender_public = X25519PublicKey.from_public_bytes(
            _b64decode(str(wrapped["sender_public_key"]))
        )
        shared_secret = self.connector_private.exchange(sender_public)
        digest = hashes.Hash(hashes.SHA256())
        digest.update(shared_secret)
        wrapping_key = digest.finalize()
        export_key = AESGCM(wrapping_key).decrypt(
            _b64decode(str(wrapped["wrapped_key_iv"])),
            _b64decode(str(wrapped["wrapped_export_key"]))
            + _b64decode(str(wrapped["wrapped_key_tag"])),
            None,
        )
        plaintext = AESGCM(export_key).decrypt(
            _b64decode(str(package["iv"])),
            _b64decode(str(package["encrypted_data"])) + _b64decode(str(package["tag"])),
            None,
        )
        return json.loads(plaintext)

    def request_developer_consent(
        self,
        *,
        scope: str,
        reason: str,
        expiry_hours: int = 24,
        approval_timeout_minutes: int = 60,
    ) -> dict[str, Any]:
        payload = {
            "user_id": self.user_id,
            "scope": scope,
            "reason": reason,
            "expiry_hours": expiry_hours,
            "approval_timeout_minutes": approval_timeout_minutes,
            "connector_public_key": self.connector.public_key_b64,
            "connector_key_id": self.connector.key_id,
            "connector_wrapping_alg": "X25519-AES256-GCM",
        }
        response = self._request(
            "POST",
            "/api/v1/request-consent",
            params={"token": self.developer_token},
            headers={"Content-Type": "application/json"},
            json_body=payload,
        )
        return response.json()

    def approve_pending_request(
        self,
        *,
        request_id: str,
        scope: str,
        duration_hours: int,
    ) -> dict[str, Any]:
        export_payload, source_content_revision, source_manifest_revision = (
            self._build_export_payload(scope)
        )
        encrypted_package = self._encrypt_export_payload(
            export_payload,
            connector_public_key_b64=self.connector.public_key_b64,
            connector_key_id=self.connector.key_id,
        )
        payload = {
            "userId": self.user_id,
            "requestId": request_id,
            "sourceContentRevision": source_content_revision,
            "sourceManifestRevision": source_manifest_revision,
            "durationHours": duration_hours,
            **encrypted_package,
        }
        response = self._request(
            "POST",
            "/api/consent/pending/approve",
            headers={**self._vault_headers(), "Content-Type": "application/json"},
            json_body=payload,
        )
        return response.json()

    def developer_consent_status(self, *, scope: str) -> dict[str, Any]:
        response = self._request(
            "GET",
            "/api/v1/consent-status",
            params={
                "token": self.developer_token,
                "user_id": self.user_id,
                "scope": scope,
            },
            headers={"Content-Type": "application/json"},
        )
        return response.json()

    def cancel_pending_request(self, *, request_id: str) -> dict[str, Any] | None:
        response = self._request(
            "POST",
            "/api/consent/cancel",
            headers={**self._vault_headers(), "Content-Type": "application/json"},
            json_body={"userId": self.user_id, "requestId": request_id},
            expected=None,
        )
        if response.status_code == 404:
            return None
        if response.status_code != 200:
            raise RuntimeError(
                f"POST /api/consent/cancel returned {response.status_code}: {response.text[:1200]}"
            )
        return response.json()

    def revoke_scope_access(self, *, scope: str) -> dict[str, Any] | None:
        response = self._request(
            "POST",
            "/api/consent/revoke",
            headers={**self._vault_headers(), "Content-Type": "application/json"},
            json_body={"userId": self.user_id, "scope": scope},
            expected=None,
        )
        if response.status_code == 404:
            return None
        if response.status_code != 200:
            raise RuntimeError(
                f"POST /api/consent/revoke returned {response.status_code}: {response.text[:1200]}"
            )
        return response.json()

    def reset_smoke_scope_state(self, *, scope: str) -> None:
        status = self.developer_consent_status(scope=scope)
        request_id = str(status.get("request_id") or "").strip()
        if str(status.get("status") or "").strip().lower() == "pending" and request_id:
            self.cancel_pending_request(request_id=request_id)
            self.log(f"Cancelled stale pending consent request for {scope}.")
        revoked = self.revoke_scope_access(scope=scope)
        if (
            isinstance(revoked, dict)
            and str(revoked.get("status") or "").strip().lower() == "revoked"
        ):
            self.log(f"Revoked stale active consent for {scope}.")

    def get_encrypted_scoped_export(
        self, *, consent_token: str, expected_scope: str | None
    ) -> dict[str, Any]:
        response = self._request(
            "POST",
            "/api/v1/scoped-export",
            params={"token": self.developer_token},
            headers={"Content-Type": "application/json"},
            json_body={
                "user_id": self.user_id,
                "consent_token": consent_token,
                "expected_scope": expected_scope,
            },
        )
        return response.json()

    def mutate_financial_domain_for_refresh(self) -> dict[str, Any]:
        manifest = self._fetch_domain_manifest("financial")
        blob_payload = self._fetch_domain_blob("financial")
        domain_data = self._decrypt_domain_blob(blob_payload)
        analytics = domain_data.setdefault("analytics", {})
        if not isinstance(analytics, dict):
            raise RuntimeError("financial.analytics is not a dict")
        quality = analytics.setdefault("quality_metrics", {})
        if not isinstance(quality, dict):
            raise RuntimeError("financial.analytics.quality_metrics is not a dict")
        marker = f"uat-regression-{int(time.time())}"
        quality["regression_refresh_marker"] = marker
        encrypted_blob = self._encrypt_domain_blob(domain_data)
        summary = next(
            (
                domain.get("summary")
                for domain in self.fetch_pkm_metadata().get("domains", [])
                if str(domain.get("key") or "") == "financial"
            ),
            {},
        )
        response = self._request(
            "POST",
            "/api/pkm/store-domain",
            headers={**self._vault_headers(), "Content-Type": "application/json"},
            json_body={
                "user_id": self.user_id,
                "domain": "financial",
                "encrypted_blob": encrypted_blob,
                "summary": summary or {},
                "manifest": manifest,
                "expected_data_version": blob_payload.get("data_version"),
            },
        )
        result = response.json()
        result["marker"] = marker
        return result

    def list_refresh_jobs(self) -> dict[str, Any]:
        response = self._request(
            "GET",
            "/api/consent/export-refresh/jobs",
            params={"userId": self.user_id},
            headers=self._vault_headers(),
        )
        return response.json()

    def upload_refreshed_export(self, *, consent_token: str, granted_scope: str) -> dict[str, Any]:
        export_payload, source_content_revision, source_manifest_revision = (
            self._build_export_payload(granted_scope)
        )
        encrypted_package = self._encrypt_export_payload(
            export_payload,
            connector_public_key_b64=self.connector.public_key_b64,
            connector_key_id=self.connector.key_id,
        )
        response = self._request(
            "POST",
            "/api/consent/export-refresh/upload",
            headers={**self._vault_headers(), "Content-Type": "application/json"},
            json_body={
                "userId": self.user_id,
                "consentToken": consent_token,
                "sourceContentRevision": source_content_revision,
                "sourceManifestRevision": source_manifest_revision,
                **encrypted_package,
            },
        )
        return response.json()

    def ensure_ria_profile(self) -> dict[str, Any]:
        status_response = self._request(
            "GET",
            "/api/ria/onboarding/status",
            headers=self._firebase_auth_headers(),
        ).json()
        verification_status = str(status_response.get("verification_status") or "")
        if verification_status in {"active", "finra_verified", "bypassed"}:
            return status_response
        payload = {
            "display_name": "Kai Test Advisory",
            "requested_capabilities": ["advisory"],
            "individual_legal_name": "Kai Test Advisor",
            "individual_crd": "1234567",
            "advisory_firm_legal_name": "Kai Test Advisory LLC",
            "advisory_firm_iapd_number": "123456",
            "strategy": "Long-term quality compounders",
        }
        response = self._request(
            "POST",
            "/api/ria/onboarding/dev-activate",
            headers={**self._firebase_auth_headers(), "Content-Type": "application/json"},
            json_body=payload,
        )
        return response.json()

    def upload_ria_picks(self) -> dict[str, Any]:
        csv_content = "\n".join(
            [
                "ticker,company_name,sector,tier,investment_thesis,tier_rank,conviction_weight",
                "AAPL,Apple Inc,Technology,core,Premium installed base with durable cash flow,1,1.0",
                "MSFT,Microsoft Corp,Technology,core,Cloud and productivity compounding engine,2,0.9",
            ]
        )
        response = self._request(
            "POST",
            "/api/ria/picks",
            headers={**self._firebase_auth_headers(), "Content-Type": "application/json"},
            json_body={
                "csv_content": csv_content,
                "source_filename": "kai-smoke-picks.csv",
                "label": "Kai UAT smoke picks",
            },
        )
        return response.json()

    def request_ria_consent(self) -> dict[str, Any]:
        templates = self._request(
            "GET",
            "/api/ria/request-scopes",
            headers=self._firebase_auth_headers(),
        ).json()["items"]

        def _scope_name(scope_entry: dict[str, Any]) -> str:
            return str(scope_entry.get("name") or scope_entry.get("scope") or "").strip()

        selected_template = None
        selected_scope = None
        preferred_scope_names = [
            "attr.financial.*",
            "attr.financial.analytics.*",
        ]
        for preferred_scope in preferred_scope_names:
            for item in templates:
                for scope in item.get("scopes") or []:
                    if _scope_name(scope) == preferred_scope:
                        selected_template = item
                        selected_scope = preferred_scope
                        break
                if selected_template:
                    break
            if selected_template:
                break
        if not selected_template:
            for item in templates:
                for scope in item.get("scopes") or []:
                    scope_name = _scope_name(scope)
                    if scope_name.startswith("attr.financial."):
                        selected_template = item
                        selected_scope = scope_name
                        break
                if selected_template:
                    break
        if not selected_template:
            for item in templates:
                scopes = item.get("scopes") or []
                if scopes:
                    selected_template = item
                    selected_scope = _scope_name(scopes[0]) or None
                    if selected_scope:
                        break
        if not selected_template or not selected_scope:
            raise RuntimeError("No usable RIA investor-data scope template was found.")
        self.log(
            "Selected RIA request template "
            f"{selected_template['template_id']} with scope {selected_scope}."
        )
        response = self._request(
            "POST",
            "/api/ria/requests",
            headers={**self._firebase_auth_headers(), "Content-Type": "application/json"},
            json_body={
                "subject_user_id": self.user_id,
                "scope_template_id": selected_template["template_id"],
                "selected_scope": selected_scope,
                "reason": "Kai UAT regression self-relationship check",
            },
        )
        return response.json()

    def approve_ria_request(self, *, request_id: str) -> dict[str, Any]:
        response = self._request(
            "POST",
            "/api/consent/pending/approve",
            headers={**self._vault_headers(), "Content-Type": "application/json"},
            json_body={
                "userId": self.user_id,
                "requestId": request_id,
                "durationHours": 24,
            },
        )
        return response.json()

    def get_ria_client_detail(self) -> dict[str, Any]:
        response = self._request(
            "GET",
            f"/api/ria/clients/{quote_plus(self.user_id)}",
            headers=self._firebase_auth_headers(),
        )
        return response.json()

    def get_market_insights(self, *, pick_source: str | None = None) -> dict[str, Any]:
        params = {"pick_source": pick_source} if pick_source else None
        response = self._request(
            "GET",
            f"/api/kai/market/insights/{quote_plus(self.user_id)}",
            headers=self._vault_headers(),
            params=params,
        )
        return response.json()

    def run(self) -> None:
        self.authenticate()
        self.derive_vault_key()

        metadata = self.fetch_pkm_metadata()
        self.log(
            f"PKM metadata reachable with domains={[domain.get('key') for domain in metadata.get('domains', [])]}."
        )

        persona_state = self.get_persona_state()
        if str(persona_state.get("last_active_persona") or "") not in {"investor", "ria"}:
            raise RuntimeError(f"Unexpected persona state payload: {persona_state}")

        investor_summary = self.get_consent_center_summary(actor="investor")
        investor_preview = self.get_consent_center_list(
            actor="investor",
            surface="pending",
            top=5,
        )
        if investor_summary.get("actor") != "investor":
            raise RuntimeError(f"Unexpected investor consent summary payload: {investor_summary}")
        if investor_preview.get("page") != 1 or investor_preview.get("limit") != 5:
            raise RuntimeError(
                f"Unexpected investor consent preview pagination contract: {investor_preview}"
            )
        if len(investor_preview.get("items") or []) > 5:
            raise RuntimeError(
                f"Investor consent preview returned more than 5 rows: {investor_preview}"
            )
        investor_pending_count = int((investor_summary.get("counts") or {}).get("pending") or 0)
        if investor_pending_count < len(investor_preview.get("items") or []):
            raise RuntimeError(
                "Investor consent summary count is smaller than the preview payload: "
                f"{investor_summary} {investor_preview}"
            )
        self.log("Investor consent summary + top-5 preview contract passed.")

        upgrade_status = self.fetch_upgrade_status()
        self.log(f"PKM upgrade route reachable with status={upgrade_status.get('upgrade_status')}.")

        narrow_scope = "attr.financial.analytics.quality_metrics"
        broader_scope = "attr.financial.analytics.*"
        self.reset_smoke_scope_state(scope=narrow_scope)
        self.reset_smoke_scope_state(scope=broader_scope)

        narrow_request = self.request_developer_consent(
            scope=narrow_scope,
            reason="Kai smoke narrow financial analytics request",
            expiry_hours=24,
            approval_timeout_minutes=60,
        )
        if narrow_request.get("status") != "pending":
            raise RuntimeError(f"Expected narrow request to be pending, got: {narrow_request}")
        self.approve_pending_request(
            request_id=str(narrow_request["request_id"]),
            scope=narrow_scope,
            duration_hours=24,
        )
        narrow_status = self.developer_consent_status(scope=narrow_scope)
        if (
            narrow_status.get("status") != "granted"
            or narrow_status.get("coverage_kind") != "exact"
        ):
            raise RuntimeError(f"Unexpected narrow consent status: {narrow_status}")
        self.log("Strict ZK narrow consent request -> approval -> status path passed.")

        broader_request = self.request_developer_consent(
            scope=broader_scope,
            reason="Kai smoke broader analytics request",
            expiry_hours=168,
            approval_timeout_minutes=60,
        )
        if broader_request.get("status") != "pending":
            raise RuntimeError(
                "Expected narrower-active -> broader request to remain pending, "
                f"got: {broader_request}"
            )
        broader_approval = self.approve_pending_request(
            request_id=str(broader_request["request_id"]),
            scope=broader_scope,
            duration_hours=168,
        )
        broader_grant_handle = str(broader_approval["consent_token"])
        reused_narrow = self.request_developer_consent(
            scope=narrow_scope,
            reason="Kai smoke reuse check",
            expiry_hours=24,
            approval_timeout_minutes=60,
        )
        if (
            reused_narrow.get("status") != "already_granted"
            or reused_narrow.get("coverage_kind") != "superset"
        ):
            raise RuntimeError(f"Expected broader-active -> narrower reuse, got: {reused_narrow}")
        scoped_export = self.get_encrypted_scoped_export(
            consent_token=broader_grant_handle,
            expected_scope=narrow_scope,
        )
        if scoped_export.get("coverage_kind") != "superset":
            raise RuntimeError(f"Expected superset scoped export, got: {scoped_export}")
        decrypted_export = self._decrypt_scoped_export(scoped_export)
        narrowed_export = narrow_decrypted_export(decrypted_export, narrow_scope)
        quality_metrics = (
            narrowed_export.get("financial", {}).get("analytics", {}).get("quality_metrics", {})
        )
        if not isinstance(quality_metrics, dict) or not quality_metrics:
            raise RuntimeError("Failed to decrypt/narrow the broader encrypted export locally.")
        self.log("Asymmetric scope reuse and encrypted export retrieval passed.")

        mutation_result = self.mutate_financial_domain_for_refresh()
        if not mutation_result.get("success"):
            raise RuntimeError(f"Financial domain mutation failed: {mutation_result}")
        jobs_payload = self.list_refresh_jobs()
        jobs = jobs_payload.get("jobs") or []
        matching_job = next(
            (job for job in jobs if str(job.get("consentToken") or "") == broader_grant_handle),
            None,
        )
        if not isinstance(matching_job, dict):
            raise RuntimeError(
                f"Expected refresh job for broader consent token, got: {jobs_payload}"
            )
        if str(matching_job.get("status") or "") != "pending":
            raise RuntimeError(f"Expected pending refresh job, got: {matching_job}")
        refreshed = self.upload_refreshed_export(
            consent_token=broader_grant_handle,
            granted_scope=broader_scope,
        )
        if not refreshed.get("success"):
            raise RuntimeError(f"Refresh upload failed: {refreshed}")
        refreshed_export = self.get_encrypted_scoped_export(
            consent_token=broader_grant_handle,
            expected_scope=narrow_scope,
        )
        if str(refreshed_export.get("export_refresh_status") or "") != "current":
            raise RuntimeError(
                f"Expected refresh status=current after upload, got: {refreshed_export}"
            )
        refreshed_plaintext = self._decrypt_scoped_export(refreshed_export)
        if (
            refreshed_plaintext.get("financial", {})
            .get("analytics", {})
            .get("quality_metrics", {})
            .get("regression_refresh_marker")
            != mutation_result["marker"]
        ):
            raise RuntimeError("Refreshed export did not include the latest PKM mutation marker.")
        self.log("Consent export refresh queue + refresh upload path passed.")

        ria_status = self.ensure_ria_profile()
        self.log(
            f"RIA profile ready with verification_status={ria_status.get('verification_status')}."
        )
        picks_upload = self.upload_ria_picks()
        if not picks_upload.get("upload_id"):
            raise RuntimeError(f"RIA pick upload failed: {picks_upload}")
        ria_request = self.request_ria_consent()
        if str(ria_request.get("status") or "").lower() != "requested":
            raise RuntimeError(f"RIA request creation failed: {ria_request}")
        ria_summary = self.get_consent_center_summary(actor="ria")
        ria_preview = self.get_consent_center_list(actor="ria", surface="pending", top=5)
        if ria_preview.get("page") != 1 or ria_preview.get("limit") != 5:
            raise RuntimeError(f"Unexpected RIA consent preview pagination contract: {ria_preview}")
        if len(ria_preview.get("items") or []) > 5:
            raise RuntimeError(f"RIA consent preview returned more than 5 rows: {ria_preview}")
        if int((ria_summary.get("counts") or {}).get("pending") or 0) < 1:
            raise RuntimeError(
                f"Expected at least one pending RIA consent after request: {ria_summary}"
            )
        if not any(
            str(item.get("request_id") or item.get("id") or "")
            == str(ria_request.get("request_id") or "")
            for item in (ria_preview.get("items") or [])
        ):
            raise RuntimeError(
                f"Expected RIA pending preview to include the new request: {ria_request} {ria_preview}"
            )
        self.log("RIA consent summary + top-5 preview contract passed.")
        self.approve_ria_request(request_id=str(ria_request["request_id"]))
        client_detail = self.get_ria_client_detail()
        relationship_shares = client_detail.get("relationship_shares") or []
        if not relationship_shares:
            raise RuntimeError(f"Expected implicit relationship share grant, got: {client_detail}")
        picks_feed_status = str(client_detail.get("picks_feed_status") or "")
        if picks_feed_status not in {"ready", "pending"}:
            raise RuntimeError(f"Unexpected picks feed status: {client_detail}")
        market_home = self.get_market_insights()
        ria_source = next(
            (
                source
                for source in (market_home.get("pick_sources") or [])
                if str(source.get("kind") or "") == "ria"
            ),
            None,
        )
        if not isinstance(ria_source, dict):
            raise RuntimeError(
                f"Expected Kai market home to expose an ria:* source, got: {market_home}"
            )
        explicit_market_home = self.get_market_insights(pick_source=str(ria_source["id"]))
        if str(explicit_market_home.get("active_pick_source") or "") != str(ria_source["id"]):
            raise RuntimeError(
                f"Expected Kai market home to resolve the ria:* source, got: {explicit_market_home.get('active_pick_source')}"
            )
        if not explicit_market_home.get("pick_rows"):
            raise RuntimeError(
                "Expected active RIA pick rows once the implicit share grant is active."
            )
        self.log("RIA implicit picks-share relationship gate passed.")

        self.log("All live Kai UAT smoke checks passed.")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the Kai UAT regression smoke.")
    parser.add_argument("--backend-url", default=DEFAULT_BACKEND_URL)
    parser.add_argument("--protocol-env", default=DEFAULT_PROTOCOL_ENV)
    parser.add_argument("--web-env", default=DEFAULT_WEBAPP_ENV)
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    runner = UatKaiSmoke(
        backend_url=args.backend_url,
        protocol_env=args.protocol_env,
        web_env=args.web_env,
        timeout=args.timeout,
    )
    runner.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
