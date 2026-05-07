"""One mailbox intake for approval-gated KYC workflows.

The service stores mailbox metadata, consent status, send metadata, and
workflow state. Raw email bodies, scoped PKM export plaintext, client connector
private keys, and reviewable draft bodies must not be persisted or decrypted by
this backend lane.
"""

from __future__ import annotations

import asyncio
import base64
import email.utils
import hashlib
import html
import json
import logging
import os
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from email.message import EmailMessage
from typing import Any, Iterable

from google.auth.transport.requests import AuthorizedSession
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2 import id_token as google_id_token
from google.oauth2 import service_account

from api.utils.firebase_admin import ensure_firebase_auth_admin, get_firebase_auth_app
from db.db_client import get_db
from hushh_mcp.runtime_settings import get_firebase_credential_settings
from hushh_mcp.services.consent_db import ConsentDBService
from hushh_mcp.services.consent_request_links import build_consent_request_url, frontend_origin
from hushh_mcp.services.support_email_service import (
    _clean_text,
    _derive_project_id,
    _load_service_account_json,
    _normalize_private_key,
)

logger = logging.getLogger(__name__)

_GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"
_GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send"
_GMAIL_MESSAGES_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages"
_GMAIL_HISTORY_URL = "https://gmail.googleapis.com/gmail/v1/users/me/history"
_GMAIL_WATCH_URL = "https://gmail.googleapis.com/gmail/v1/users/me/watch"
_DEFAULT_ONE_EMAIL_ADDRESS = "one@hushh.ai"
_ONE_EMAIL_DISPLAY_NAME = "One"
_DEFAULT_KYC_SCOPE = "attr.identity.*"
_ALLOWED_KYC_DATA_SCOPES = frozenset({_DEFAULT_KYC_SCOPE})
_CONNECTOR_WRAPPING_ALG = "X25519-AES256-GCM"
_ONE_AGENT_ID = "agent_one"
_NAV_AGENT_ID = "agent_nav"
_KYC_AGENT_ID = "agent_kyc"
_KYC_REQUEST_SOURCE = "one_email_kyc_v1"
_KYC_REQUEST_ID_PREFIX = "okyc_"
_CONSENT_REQUEST_ID_MAX_LENGTH = 32
_MAX_STORED_TEXT = 500
_MAX_DRAFT_BODY = 6000
_SENSITIVE_WORKFLOW_METADATA_KEYS = frozenset(
    {"access_token", "consent_token", "token", "token_id"}
)
_KYC_WORKFLOW_STATES = {
    "needs_client_connector",
    "needs_scope",
    "needs_documents",
    "drafting",
    "waiting_on_user",
    "waiting_on_counterparty",
    "completed",
    "blocked",
}


def _runtime_environment() -> str:
    return (
        _clean_text(os.getenv("ENVIRONMENT"))
        or _clean_text(os.getenv("HUSHH_DEPLOY_ENV"))
        or "development"
    ).lower()


class OneEmailKycError(RuntimeError):
    """Raised when One email KYC processing cannot continue."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int = 500,
        code: str = "ONE_EMAIL_KYC_ERROR",
        payload: dict[str, Any] | None = None,
    ) -> None:
        self.status_code = status_code
        self.code = code
        self.payload = payload or {}
        super().__init__(message)


@dataclass(frozen=True)
class OneEmailKycConfig:
    service_account_info: dict[str, str]
    service_account_email: str
    private_key: str
    project_id: str | None
    client_id: str | None
    delegated_user: str
    mailbox_email: str
    pubsub_topic: str | None
    webhook_audience: str | None
    webhook_service_account_email: str | None
    webhook_auth_enabled: bool
    watch_label_ids: tuple[str, ...]
    default_kyc_scope: str
    strict_client_zk_enabled: bool
    configured: bool

    @classmethod
    def from_env(cls) -> "OneEmailKycConfig":
        firebase_credentials = get_firebase_credential_settings()
        service_account_info = _load_service_account_json(
            os.getenv("ONE_EMAIL_SERVICE_ACCOUNT_JSON")
        ) or _load_service_account_json(firebase_credentials.admin_credentials_json)

        service_account_email = (
            _clean_text(service_account_info.get("client_email"))
            if service_account_info
            else _clean_text(os.getenv("GOOGLE_SERVICE_ACCOUNT_EMAIL"))
        )
        private_key = (
            _normalize_private_key(service_account_info.get("private_key"))
            if service_account_info
            else _normalize_private_key(os.getenv("GOOGLE_PRIVATE_KEY"))
        )
        project_id = (
            _clean_text(service_account_info.get("project_id"))
            if service_account_info
            else _clean_text(os.getenv("GOOGLE_SERVICE_ACCOUNT_PROJECT_ID"))
        ) or _derive_project_id(service_account_email)
        client_id = (
            _clean_text(service_account_info.get("client_id")) if service_account_info else None
        ) or None

        if service_account_info is None and service_account_email and private_key:
            service_account_info = {
                "type": "service_account",
                "client_email": service_account_email,
                "private_key": private_key,
                "token_uri": "https://oauth2.googleapis.com/token",
            }
            if project_id:
                service_account_info["project_id"] = project_id
            if client_id:
                service_account_info["client_id"] = client_id

        mailbox_email = _clean_text(os.getenv("ONE_EMAIL_ADDRESS")) or _DEFAULT_ONE_EMAIL_ADDRESS
        delegated_user = _clean_text(os.getenv("ONE_EMAIL_DELEGATED_USER")) or mailbox_email
        raw_labels = _clean_text(os.getenv("ONE_EMAIL_WATCH_LABEL_IDS")) or "INBOX"
        label_ids = tuple(label.strip() for label in raw_labels.split(",") if label.strip())
        webhook_auth_enabled = _env_bool(
            "ONE_EMAIL_WEBHOOK_AUTH_ENABLED",
            _env_bool(
                "GMAIL_WEBHOOK_AUTH_ENABLED",
                _runtime_environment() not in {"development", "dev", "local", "test"},
            ),
        )
        default_scope = _validate_kyc_data_scope(
            _clean_text(os.getenv("ONE_EMAIL_KYC_DEFAULT_SCOPE")) or _DEFAULT_KYC_SCOPE
        )

        configured = bool(service_account_info and delegated_user and mailbox_email)
        return cls(
            service_account_info=service_account_info or {},
            service_account_email=service_account_email,
            private_key=private_key,
            project_id=project_id or None,
            client_id=client_id,
            delegated_user=delegated_user,
            mailbox_email=mailbox_email.lower(),
            pubsub_topic=_clean_text(os.getenv("ONE_EMAIL_PUBSUB_TOPIC")) or None,
            webhook_audience=(
                _clean_text(os.getenv("ONE_EMAIL_WEBHOOK_AUDIENCE"))
                or _clean_text(os.getenv("GMAIL_WEBHOOK_AUDIENCE"))
                or None
            ),
            webhook_service_account_email=(
                _clean_text(os.getenv("ONE_EMAIL_WEBHOOK_SERVICE_ACCOUNT_EMAIL"))
                or _clean_text(os.getenv("GMAIL_WEBHOOK_SERVICE_ACCOUNT_EMAIL"))
                or None
            ),
            webhook_auth_enabled=webhook_auth_enabled,
            watch_label_ids=label_ids,
            default_kyc_scope=default_scope,
            strict_client_zk_enabled=_env_bool("ONE_EMAIL_KYC_STRICT_CLIENT_ZK_ENABLED", True),
            configured=configured,
        )


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _validate_kyc_data_scope(scope: str) -> str:
    normalized = _clean_text(scope)
    if normalized not in _ALLOWED_KYC_DATA_SCOPES:
        raise OneEmailKycError(
            "One email KYC default scope is not approved for this lane.",
            status_code=503,
            code="ONE_KYC_SCOPE_NOT_ALLOWED",
            payload={
                "scope": normalized,
                "allowed_scopes": sorted(_ALLOWED_KYC_DATA_SCOPES),
            },
        )
    return normalized


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _epoch_ms_now() -> int:
    return int(_utcnow().timestamp() * 1000)


def _json(value: Any) -> str:
    return json.dumps(value, default=_json_default, separators=(",", ":"), sort_keys=True)


def _json_default(value: Any) -> str:
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def _kyc_consent_request_id(workflow_id: str) -> str:
    suffix_limit = _CONSENT_REQUEST_ID_MAX_LENGTH - len(_KYC_REQUEST_ID_PREFIX)
    return f"{_KYC_REQUEST_ID_PREFIX}{_clean_text(workflow_id)[:suffix_limit]}"


def _kyc_consent_request_url(consent_request_id: str | None) -> str | None:
    if not consent_request_id:
        return None
    return build_consent_request_url(request_id=consent_request_id, view="incoming")


def _public_key_fingerprint(public_key: str) -> str:
    normalized = _clean_text(public_key)
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def _validate_connector_key_id(value: str | None) -> str:
    key_id = _clean_text(value)
    if not key_id:
        raise OneEmailKycError(
            "KYC client connector key id is required.",
            status_code=400,
            code="ONE_KYC_CLIENT_CONNECTOR_KEY_ID_REQUIRED",
        )
    if not re.fullmatch(r"[A-Za-z0-9._:-]{3,120}", key_id):
        raise OneEmailKycError(
            "KYC client connector key id contains unsupported characters.",
            status_code=400,
            code="ONE_KYC_CLIENT_CONNECTOR_KEY_ID_INVALID",
        )
    return key_id


def _validate_connector_public_key(value: str | None) -> str:
    public_key = _clean_text(value)
    if len(public_key) < 32:
        raise OneEmailKycError(
            "KYC client connector public key is required.",
            status_code=400,
            code="ONE_KYC_CLIENT_CONNECTOR_PUBLIC_KEY_REQUIRED",
        )
    return public_key


def _validate_connector_wrapping_alg(value: str | None) -> str:
    wrapping_alg = _clean_text(value) or _CONNECTOR_WRAPPING_ALG
    if wrapping_alg != _CONNECTOR_WRAPPING_ALG:
        raise OneEmailKycError(
            "KYC client connector uses an unsupported wrapping algorithm.",
            status_code=400,
            code="ONE_KYC_CLIENT_CONNECTOR_WRAPPING_UNSUPPORTED",
            payload={"supported_wrapping_alg": _CONNECTOR_WRAPPING_ALG},
        )
    return wrapping_alg


def _is_legacy_consent_request_url(value: Any) -> bool:
    return isinstance(value, str) and "/profile?" in value


def _normalize_field_key(value: Any) -> str:
    return re.sub(r"[^a-z0-9]", "", _clean_text(value).lower())


def _truncate(value: str | None, limit: int = _MAX_STORED_TEXT) -> str | None:
    text = re.sub(r"\s+", " ", _clean_text(value))
    if not text:
        return None
    return text[:limit]


def _decode_b64url(data: str | None) -> str:
    value = _clean_text(data)
    if not value:
        return ""
    padded = value + ("=" * (-len(value) % 4))
    return base64.urlsafe_b64decode(padded.encode("utf-8")).decode("utf-8", errors="replace")


def _header_map(message: dict[str, Any]) -> dict[str, str]:
    headers: dict[str, str] = {}
    for item in message.get("payload", {}).get("headers", []) or []:
        name = _clean_text(item.get("name")).lower()
        value = _clean_text(item.get("value"))
        if name and value and name not in headers:
            headers[name] = value
    return headers


def _extract_addresses(*values: str | None) -> list[str]:
    parsed = email.utils.getaddresses([value or "" for value in values if value])
    addresses = []
    for _, address in parsed:
        normalized = address.strip().lower()
        if normalized and "@" in normalized and normalized not in addresses:
            addresses.append(normalized)
    return addresses


def _without_addresses(values: list[str], excluded: set[str]) -> list[str]:
    return [value for value in values if value not in excluded]


def _extract_name(value: str | None) -> str | None:
    parsed = email.utils.getaddresses([value or ""])
    if not parsed:
        return None
    name = _truncate(parsed[0][0], 120)
    return name or None


def _iter_payload_parts(payload: dict[str, Any]) -> Iterable[dict[str, Any]]:
    yield payload
    for part in payload.get("parts", []) or []:
        if isinstance(part, dict):
            yield from _iter_payload_parts(part)


def _strip_html(value: str) -> str:
    without_tags = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", value, flags=re.I | re.S)
    without_tags = re.sub(r"<[^>]+>", " ", without_tags)
    return html.unescape(without_tags)


def _message_text(message: dict[str, Any]) -> str:
    plain: list[str] = []
    html_parts: list[str] = []
    payload = message.get("payload") if isinstance(message.get("payload"), dict) else {}
    for part in _iter_payload_parts(payload):
        mime_type = _clean_text(part.get("mimeType")).lower()
        body = part.get("body") if isinstance(part.get("body"), dict) else {}
        data = _decode_b64url(body.get("data"))
        if not data:
            continue
        if mime_type == "text/plain":
            plain.append(data)
        elif mime_type == "text/html":
            html_parts.append(_strip_html(data))
    return "\n".join(plain or html_parts)


def _metadata_from_row(row: dict[str, Any]) -> dict[str, Any]:
    value = row.get("metadata")
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def _redact_sensitive_workflow_metadata(value: dict[str, Any]) -> dict[str, Any]:
    return {
        key: item
        for key, item in value.items()
        if str(key).strip().lower() not in _SENSITIVE_WORKFLOW_METADATA_KEYS
    }


def _json_list_from_row(row: dict[str, Any], key: str) -> list[Any]:
    value = row.get(key)
    if isinstance(value, list):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, list) else []
        except json.JSONDecodeError:
            return []
    return []


class OneEmailKycService:
    """Processes broker KYC emails addressed to One."""

    def __init__(
        self, *, db: Any | None = None, consent_db: ConsentDBService | None = None
    ) -> None:
        self._db = db
        self._consent_db = consent_db
        self._config: OneEmailKycConfig | None = None
        self._sessions: dict[tuple[str, ...], AuthorizedSession] = {}

    @property
    def db(self):
        if self._db is None:
            self._db = get_db()
        return self._db

    @property
    def consent_db(self) -> ConsentDBService:
        if self._consent_db is None:
            self._consent_db = ConsentDBService()
        return self._consent_db

    @property
    def config(self) -> OneEmailKycConfig:
        if self._config is None:
            self._config = OneEmailKycConfig.from_env()
        return self._config

    def _public_connector(self, row: dict[str, Any] | None) -> dict[str, Any] | None:
        if not row:
            return None
        return {
            "user_id": row.get("user_id"),
            "connector_key_id": row.get("connector_key_id"),
            "connector_public_key": row.get("connector_public_key"),
            "connector_wrapping_alg": row.get("connector_wrapping_alg") or _CONNECTOR_WRAPPING_ALG,
            "public_key_fingerprint": row.get("public_key_fingerprint"),
            "status": row.get("status"),
            "created_at": _iso(row.get("created_at")),
            "updated_at": _iso(row.get("updated_at")),
            "rotated_at": _iso(row.get("rotated_at")),
            "revoked_at": _iso(row.get("revoked_at")),
        }

    def _get_active_client_connector(self, user_id: str | None) -> dict[str, Any] | None:
        user = _clean_text(user_id)
        if not user:
            return None
        sql = """
            SELECT *
            FROM one_kyc_client_connectors
            WHERE user_id = :user_id
              AND status = 'active'
            ORDER BY updated_at DESC
            LIMIT 1
        """
        rows = self.db.execute_raw(sql, {"user_id": user}).data or []
        return self._public_connector(dict(rows[0])) if rows else None

    async def get_client_connector(self, *, user_id: str) -> dict[str, Any]:
        connector = self._get_active_client_connector(user_id)
        return {"configured": connector is not None, "connector": connector}

    async def register_client_connector(
        self,
        *,
        user_id: str,
        connector_public_key: str,
        connector_key_id: str,
        connector_wrapping_alg: str = _CONNECTOR_WRAPPING_ALG,
        public_key_fingerprint: str | None = None,
    ) -> dict[str, Any]:
        user = _clean_text(user_id)
        if not user:
            raise OneEmailKycError(
                "KYC client connector user id is required.",
                status_code=400,
                code="ONE_KYC_CLIENT_CONNECTOR_USER_REQUIRED",
            )
        public_key = _validate_connector_public_key(connector_public_key)
        key_id = _validate_connector_key_id(connector_key_id)
        wrapping_alg = _validate_connector_wrapping_alg(connector_wrapping_alg)
        fingerprint = _clean_text(public_key_fingerprint) or _public_key_fingerprint(public_key)
        self.db.execute_raw(
            """
            UPDATE one_kyc_client_connectors
            SET status = 'rotated',
                rotated_at = NOW(),
                updated_at = NOW()
            WHERE user_id = :user_id
              AND connector_key_id <> :connector_key_id
              AND status = 'active'
            """,
            {"user_id": user, "connector_key_id": key_id},
        )
        rows = self.db.execute_raw(
            """
            INSERT INTO one_kyc_client_connectors (
              user_id,
              connector_key_id,
              connector_public_key,
              connector_wrapping_alg,
              public_key_fingerprint,
              status,
              updated_at
            )
            VALUES (
              :user_id,
              :connector_key_id,
              :connector_public_key,
              :connector_wrapping_alg,
              :public_key_fingerprint,
              'active',
              NOW()
            )
            ON CONFLICT (user_id, connector_key_id) DO UPDATE SET
              connector_public_key = EXCLUDED.connector_public_key,
              connector_wrapping_alg = EXCLUDED.connector_wrapping_alg,
              public_key_fingerprint = EXCLUDED.public_key_fingerprint,
              status = 'active',
              revoked_at = NULL,
              updated_at = NOW()
            RETURNING *
            """,
            {
                "user_id": user,
                "connector_key_id": key_id,
                "connector_public_key": public_key,
                "connector_wrapping_alg": wrapping_alg,
                "public_key_fingerprint": fingerprint,
            },
        ).data
        connector = self._public_connector(dict(rows[0])) if rows else None
        return {"configured": connector is not None, "connector": connector}

    def _authorized_session(self, scopes: tuple[str, ...]) -> AuthorizedSession:
        cfg = self.config
        if not cfg.configured:
            raise OneEmailKycError(
                "One email KYC is not configured. Provide ONE_EMAIL_SERVICE_ACCOUNT_JSON "
                "or FIREBASE_ADMIN_CREDENTIALS_JSON and ONE_EMAIL_ADDRESS.",
                status_code=503,
                code="ONE_EMAIL_KYC_NOT_CONFIGURED",
            )
        key = tuple(sorted(scopes))
        if key not in self._sessions:
            credentials = service_account.Credentials.from_service_account_info(
                cfg.service_account_info,
                scopes=list(key),
                subject=cfg.delegated_user,
            )
            self._sessions[key] = AuthorizedSession(credentials)
        return self._sessions[key]

    def _get_json_sync(self, url: str, *, params: dict[str, Any] | None = None) -> dict[str, Any]:
        response = self._authorized_session((_GMAIL_READONLY_SCOPE,)).get(
            url,
            params=params,
            timeout=20,
        )
        try:
            payload = response.json()
        except Exception:
            payload = {}
        if response.status_code >= 400:
            raise OneEmailKycError(
                "Gmail read failed.",
                status_code=502,
                code="ONE_EMAIL_GMAIL_READ_FAILED",
                payload={"status": response.status_code, "payload": payload},
            )
        return payload if isinstance(payload, dict) else {}

    def _post_json_sync(
        self,
        url: str,
        *,
        json_payload: dict[str, Any],
        scopes: tuple[str, ...],
    ) -> dict[str, Any]:
        response = self._authorized_session(scopes).post(url, json=json_payload, timeout=20)
        try:
            payload = response.json()
        except Exception:
            payload = {}
        if response.status_code >= 400:
            raise OneEmailKycError(
                "Gmail write failed.",
                status_code=502,
                code="ONE_EMAIL_GMAIL_WRITE_FAILED",
                payload={"status": response.status_code, "payload": payload},
            )
        return payload if isinstance(payload, dict) else {}

    def _verify_webhook_ingress_sync(self, headers: dict[str, str]) -> dict[str, Any]:
        cfg = self.config
        if not cfg.webhook_auth_enabled:
            return {"verified": False, "auth_disabled": True}
        if not cfg.webhook_audience:
            raise OneEmailKycError(
                "One email webhook audience is not configured.",
                status_code=503,
                code="ONE_EMAIL_WEBHOOK_AUDIENCE_MISSING",
            )

        normalized_headers = {
            _clean_text(key).lower(): value for key, value in headers.items() if _clean_text(key)
        }
        authorization = _clean_text(normalized_headers.get("authorization"))
        if not authorization.startswith("Bearer "):
            raise OneEmailKycError(
                "Missing One email Pub/Sub bearer token.",
                status_code=401,
                code="ONE_EMAIL_WEBHOOK_UNAUTHORIZED",
            )
        token = authorization.removeprefix("Bearer ").strip()
        try:
            claims = google_id_token.verify_oauth2_token(
                token,
                GoogleAuthRequest(),
                audience=cfg.webhook_audience,
            )
        except Exception as exc:
            raise OneEmailKycError(
                "One email Pub/Sub token validation failed.",
                status_code=401,
                code="ONE_EMAIL_WEBHOOK_TOKEN_INVALID",
            ) from exc

        expected_email = _clean_text(cfg.webhook_service_account_email).lower()
        if expected_email:
            token_email = _clean_text(claims.get("email")).lower()
            if token_email != expected_email:
                raise OneEmailKycError(
                    "One email Pub/Sub token subject is not authorized.",
                    status_code=403,
                    code="ONE_EMAIL_WEBHOOK_SUBJECT_FORBIDDEN",
                )
        if "email_verified" in claims and not bool(claims.get("email_verified")):
            raise OneEmailKycError(
                "One email Pub/Sub token email is not verified.",
                status_code=403,
                code="ONE_EMAIL_WEBHOOK_EMAIL_UNVERIFIED",
            )
        return claims

    async def verify_webhook_ingress(self, *, headers: dict[str, str]) -> dict[str, Any]:
        return await asyncio.to_thread(self._verify_webhook_ingress_sync, headers)

    async def renew_watch(self) -> dict[str, Any]:
        cfg = self.config
        if not cfg.pubsub_topic:
            self._upsert_mailbox_state(watch_status="not_configured")
            return {"accepted": True, "watch_status": "not_configured"}
        payload: dict[str, Any] = {"topicName": cfg.pubsub_topic}
        if cfg.watch_label_ids:
            payload["labelIds"] = list(cfg.watch_label_ids)
        response = await asyncio.to_thread(
            self._post_json_sync,
            _GMAIL_WATCH_URL,
            json_payload=payload,
            scopes=(_GMAIL_READONLY_SCOPE,),
        )
        expiration = _google_epoch_ms_to_datetime(response.get("expiration"))
        history_id = _clean_text(response.get("historyId")) or None
        self._upsert_mailbox_state(
            history_id=history_id,
            watch_status="active",
            watch_expiration_at=expiration,
            last_watch_renewed=True,
        )
        return {
            "accepted": True,
            "watch_status": "active",
            "history_id": history_id,
            "watch_expiration_at": expiration.isoformat() if expiration else None,
            "mailbox": cfg.mailbox_email,
        }

    async def handle_push_notification(
        self,
        payload: dict[str, Any],
        *,
        headers: dict[str, str],
    ) -> dict[str, Any]:
        await self.verify_webhook_ingress(headers=headers)
        notification = self._decode_pubsub_notification(payload)
        message_id = _clean_text(notification.get("message_id")) or _clean_text(
            notification.get("messageId")
        )
        if message_id:
            result = await self.process_message_id(
                message_id, history_id=notification.get("historyId")
            )
            return {"accepted": True, "handled": True, "mode": "message_id", "result": result}

        history_id = _clean_text(notification.get("historyId"))
        if not history_id:
            raise OneEmailKycError(
                "One email webhook payload is missing historyId.",
                status_code=400,
                code="ONE_EMAIL_WEBHOOK_HISTORY_ID_MISSING",
            )
        state = self._get_mailbox_state()
        previous_history_id = _clean_text(state.get("history_id") if state else None)
        if not previous_history_id:
            self._upsert_mailbox_state(history_id=history_id, last_notification=True)
            return {"accepted": True, "handled": False, "reason": "history_primed"}

        ids = await asyncio.to_thread(
            self._list_message_ids_from_history,
            previous_history_id,
        )
        results = []
        for item_id in ids:
            results.append(await self.process_message_id(item_id, history_id=history_id))
        self._upsert_mailbox_state(history_id=history_id, last_notification=True)
        return {
            "accepted": True,
            "handled": bool(results),
            "message_count": len(results),
            "results": results,
        }

    async def process_message_id(
        self,
        message_id: str,
        *,
        history_id: str | None = None,
    ) -> dict[str, Any]:
        existing = self._workflow_by_message_id(message_id)
        if existing:
            has_stale_consent_url = _is_legacy_consent_request_url(
                (existing.get("metadata") or {}).get("consent_request_url")
            )
            if existing.get("status") == "needs_client_connector":
                connector = self._get_active_client_connector(existing.get("user_id"))
                if connector:
                    repaired = self._update_workflow(
                        existing["workflow_id"],
                        status="needs_scope",
                        last_error_code=None,
                        last_error_message=None,
                        metadata={
                            **existing.get("metadata", {}),
                            "client_connector_key_id": connector["connector_key_id"],
                            "client_connector_fingerprint": connector.get("public_key_fingerprint"),
                            "strict_client_zk": True,
                        },
                    )
                    workflow = await self._ensure_consent_request(repaired, connector=connector)
                    return {
                        "handled": True,
                        "reason": "client_connector_repaired",
                        "workflow": workflow,
                    }
            if existing.get("status") == "needs_scope" and (
                not existing.get("consent_request_id") or has_stale_consent_url
            ):
                workflow = await self._ensure_consent_request(existing)
                return {
                    "handled": True,
                    "reason": "consent_request_repaired",
                    "workflow": workflow,
                }
            return {"handled": False, "reason": "duplicate", "workflow": existing}

        message = await asyncio.to_thread(self._fetch_message, message_id)
        return await self._process_message(message, history_id=history_id)

    def _decode_pubsub_notification(self, payload: dict[str, Any]) -> dict[str, Any]:
        message = payload.get("message")
        if not isinstance(message, dict):
            raise OneEmailKycError(
                "One email webhook payload must contain a Pub/Sub message object.",
                status_code=400,
                code="ONE_EMAIL_WEBHOOK_INVALID_PAYLOAD",
            )
        raw_data = _clean_text(message.get("data"))
        if not raw_data:
            return {}
        try:
            decoded = base64.b64decode(raw_data).decode("utf-8")
            parsed = json.loads(decoded)
        except Exception as exc:
            raise OneEmailKycError(
                "One email webhook Pub/Sub data is invalid.",
                status_code=400,
                code="ONE_EMAIL_WEBHOOK_DATA_INVALID",
            ) from exc
        if not isinstance(parsed, dict):
            raise OneEmailKycError(
                "One email webhook Pub/Sub data must decode to an object.",
                status_code=400,
                code="ONE_EMAIL_WEBHOOK_DATA_INVALID",
            )
        for key in ("historyId", "message_id", "messageId"):
            if parsed.get(key) is not None:
                parsed[key] = str(parsed[key])
        return parsed

    def _list_message_ids_from_history(self, start_history_id: str) -> list[str]:
        params = {
            "startHistoryId": start_history_id,
            "historyTypes": "messageAdded",
        }
        response = self._get_json_sync(_GMAIL_HISTORY_URL, params=params)
        ids: list[str] = []
        for history_item in response.get("history", []) or []:
            if not isinstance(history_item, dict):
                continue
            for added in history_item.get("messagesAdded", []) or []:
                message = added.get("message") if isinstance(added, dict) else None
                item_id = _clean_text(message.get("id") if isinstance(message, dict) else None)
                if item_id and item_id not in ids:
                    ids.append(item_id)
        return ids

    def _fetch_message(self, message_id: str) -> dict[str, Any]:
        return self._get_json_sync(
            f"{_GMAIL_MESSAGES_URL}/{message_id}",
            params={"format": "full"},
        )

    async def _process_message(
        self,
        message: dict[str, Any],
        *,
        history_id: str | None,
    ) -> dict[str, Any]:
        headers = _header_map(message)
        from_header = headers.get("from")
        from_addresses = _extract_addresses(from_header)
        sender_email = from_addresses[0] if from_addresses else None
        subject = headers.get("subject") or "(no subject)"
        gmail_message_id = _clean_text(message.get("id"))
        gmail_thread_id = _clean_text(message.get("threadId"))
        rfc_message_id = _clean_text(headers.get("message-id")) or None
        body_text = _message_text(message)
        body_hash = hashlib.sha256(body_text.encode("utf-8")).hexdigest() if body_text else None
        snippet = None
        mailbox = self.config.mailbox_email
        participants = [
            item
            for item in _extract_addresses(
                headers.get("from"),
                headers.get("to"),
                headers.get("cc"),
                headers.get("reply-to"),
            )
            if item != mailbox
        ]
        recipient_participants = _without_addresses(
            _extract_addresses(headers.get("to"), headers.get("cc"), headers.get("reply-to")),
            {mailbox},
        )

        if sender_email == mailbox:
            return {"handled": False, "reason": "self_sent_message", "message_id": gmail_message_id}

        is_kyc = self._looks_like_kyc(subject=subject, body=body_text)
        recipient_user_match = self._match_verified_user(recipient_participants)
        if recipient_user_match.get("user_id") or recipient_user_match.get("error_code") in (
            "ambiguous_identity_resolution",
            "ambiguous_user_match",
        ):
            user_match = {
                **recipient_user_match,
                "matched_from": "recipients",
            }
        else:
            user_match = {
                **self._match_verified_user(participants),
                "matched_from": "participants",
            }
        common = {
            "workflow_id": uuid.uuid4().hex,
            "user_id": user_match.get("user_id"),
            "gmail_message_id": gmail_message_id,
            "gmail_thread_id": gmail_thread_id,
            "gmail_history_id": history_id,
            "sender_email": sender_email,
            "sender_name": _extract_name(from_header),
            "participant_emails": participants,
            "subject": _truncate(subject, 500),
            "snippet": snippet,
            "counterparty_label": self._counterparty_label(sender_email, from_header),
            "rfc_message_id": rfc_message_id,
            "metadata": {
                "source": _KYC_REQUEST_SOURCE,
                "body_sha256": body_hash,
                "classification": "kyc" if is_kyc else "unsupported",
                "request_summary": "Broker-style KYC intake email",
                "one_agent_id": _ONE_AGENT_ID,
                "nav_agent_id": _NAV_AGENT_ID,
                "kyc_agent_id": _KYC_AGENT_ID,
                "identity_match_source": user_match.get("matched_from"),
                "identity_matched_by": user_match.get("matched_by"),
            },
        }

        if not user_match.get("user_id"):
            workflow = self._insert_workflow(
                **common,
                status="blocked",
                required_fields=[],
                requested_scope=None,
                last_error_code=user_match.get("error_code") or "user_not_found",
                last_error_message=user_match.get("message")
                or "No unique verified Hussh user matched the email participants.",
            )
            return {"handled": True, "workflow": workflow, "blocked": True}

        if not is_kyc:
            workflow = self._insert_workflow(
                **common,
                status="blocked",
                required_fields=[],
                requested_scope=None,
                last_error_code="unsupported_email_task",
                last_error_message="One email intake only handles KYC-style requests in this lane.",
            )
            return {"handled": True, "workflow": workflow, "blocked": True}

        connector = self._get_active_client_connector(user_match.get("user_id"))
        if not connector:
            workflow = self._insert_workflow(
                **common,
                status="needs_client_connector",
                required_fields=self._extract_required_fields(subject=subject, body=body_text),
                requested_scope=self.config.default_kyc_scope,
                last_error_code="kyc_client_connector_missing",
                last_error_message=(
                    "Unlock the KYC workspace once so One can register a client-held connector key."
                ),
            )
            return {"handled": True, "workflow": workflow, "blocked": False}

        required_fields = self._extract_required_fields(subject=subject, body=body_text)
        workflow_common = {
            **common,
            "metadata": {
                **common["metadata"],
                "client_connector_key_id": connector["connector_key_id"],
                "client_connector_fingerprint": connector.get("public_key_fingerprint"),
                "strict_client_zk": True,
            },
        }
        workflow = self._insert_workflow(
            **workflow_common,
            status="needs_scope",
            required_fields=required_fields,
            requested_scope=self.config.default_kyc_scope,
            last_error_code=None,
            last_error_message=None,
        )
        workflow = await self._ensure_consent_request(workflow, connector=connector)
        return {"handled": True, "workflow": workflow, "blocked": False}

    def _looks_like_kyc(self, *, subject: str, body: str) -> bool:
        haystack = f"{subject}\n{body}".lower()
        patterns = (
            "kyc",
            "know your customer",
            "customer due diligence",
            "due diligence",
            "broker api",
            "broker onboarding",
            "questionnaire",
            "aml",
            "beneficial owner",
            "identity verification",
            "accreditation",
            "compliance form",
        )
        return any(pattern in haystack for pattern in patterns)

    def _extract_required_fields(self, *, subject: str, body: str) -> list[str]:
        haystack = f"{subject}\n{body}".lower()
        known_fields = {
            "full_name": ("full name", "legal name", "name of applicant"),
            "date_of_birth": ("date of birth", "dob", "birth date"),
            "address": ("address", "residential address", "mailing address"),
            "phone_number": ("phone", "mobile", "telephone"),
            "email": ("email", "e-mail"),
            "tax_residency": ("tax residency", "tax residence", "tax status"),
            "nationality": ("nationality", "citizenship"),
            "employment": ("employment", "occupation", "employer"),
            "source_of_funds": ("source of funds", "source of wealth"),
            "brokerage_profile": ("brokerage", "broker account", "trading experience"),
        }
        fields = [
            field
            for field, aliases in known_fields.items()
            if any(alias in haystack for alias in aliases)
        ]
        if not fields:
            fields.append("identity_profile")
        return fields

    def _counterparty_label(self, sender_email: str | None, from_header: str | None) -> str:
        name = _extract_name(from_header)
        if name:
            return name
        if sender_email and "@" in sender_email:
            return sender_email.split("@", 1)[1]
        return "Broker counterparty"

    def _match_verified_user(self, emails: list[str]) -> dict[str, Any]:
        unique_emails = sorted({email.lower() for email in emails if email})
        if not unique_emails:
            return {"user_id": None, "error_code": "no_participant_email"}
        rows = self._find_actor_identity_rows(unique_emails)
        alias_rows = self._find_verified_email_alias_rows(unique_emails)
        rows.extend(alias_rows)
        user_ids = sorted(
            {str(row.get("user_id") or "").strip() for row in rows if row.get("user_id")}
        )
        if len(user_ids) == 1:
            matched_by = "actor_verified_email_alias" if alias_rows else "actor_identity_cache"
            return {"user_id": user_ids[0], "matched_by": matched_by}
        if len(user_ids) > 1:
            return {
                "user_id": None,
                "error_code": (
                    "ambiguous_identity_resolution" if alias_rows else "ambiguous_user_match"
                ),
                "message": "Multiple verified Hussh users matched the email participants.",
            }

        firebase_matches = self._find_firebase_users_by_email(unique_emails)
        if len(firebase_matches) == 1:
            return {"user_id": firebase_matches[0], "matched_by": "firebase_auth"}
        if len(firebase_matches) > 1:
            return {
                "user_id": None,
                "error_code": "ambiguous_user_match",
                "message": "Multiple Firebase users matched the email participants.",
            }
        return {
            "user_id": None,
            "error_code": "user_not_found",
            "message": "No verified Hussh user matched the email participants.",
        }

    def _find_actor_identity_rows(self, emails: list[str]) -> list[dict[str, Any]]:
        if not emails:
            return []
        sql = """
            SELECT user_id, email
            FROM actor_identity_cache
            WHERE email_verified = TRUE
              AND LOWER(email) = ANY(:emails)
        """
        try:
            return [dict(row) for row in self.db.execute_raw(sql, {"emails": emails}).data]
        except Exception as exc:
            logger.warning("one_email_kyc.actor_identity_lookup_failed reason=%s", exc)
            return []

    def _find_verified_email_alias_rows(self, emails: list[str]) -> list[dict[str, Any]]:
        if not emails:
            return []
        sql = """
            SELECT user_id, email, email_normalized
            FROM actor_verified_email_aliases
            WHERE verification_status = 'verified'
              AND revoked_at IS NULL
              AND email_normalized = ANY(:emails)
        """
        try:
            return [dict(row) for row in self.db.execute_raw(sql, {"emails": emails}).data]
        except Exception as exc:
            logger.warning("one_email_kyc.actor_verified_alias_lookup_failed reason=%s", exc)
            return []

    def _find_firebase_users_by_email(self, emails: list[str]) -> list[str]:
        configured, _ = ensure_firebase_auth_admin()
        if not configured:
            return []
        try:
            from firebase_admin import auth as firebase_auth
        except Exception:
            return []
        app = get_firebase_auth_app()
        matches: list[str] = []
        for email_address in emails:
            try:
                user = firebase_auth.get_user_by_email(email_address, app=app)
            except Exception:
                continue
            if bool(getattr(user, "email_verified", False)):
                uid = _clean_text(getattr(user, "uid", None))
                if uid and uid not in matches:
                    matches.append(uid)
        return matches

    async def _create_consent_request(
        self,
        *,
        workflow: dict[str, Any],
        connector: dict[str, Any],
        consent_request_id: str,
        required_fields: list[str],
    ) -> None:
        expires_at = _epoch_ms_now() + 24 * 60 * 60 * 1000
        reason = (
            f"One needs approval to retrieve scoped identity data for a KYC request from "
            f"{workflow.get('counterparty_label') or 'the broker'}."
        )
        await self.consent_db.insert_event(
            user_id=workflow["user_id"],
            agent_id=_KYC_AGENT_ID,
            scope=workflow["requested_scope"],
            action="REQUESTED",
            request_id=consent_request_id,
            scope_description="One KYC needs a scoped identity export to draft the broker reply.",
            expires_at=expires_at,
            poll_timeout_at=expires_at,
            metadata={
                "request_source": _KYC_REQUEST_SOURCE,
                "requester_actor_type": "developer",
                "requester_label": "One KYC",
                "developer_app_display_name": "One KYC",
                "requester_entity_id": _KYC_AGENT_ID,
                "connector_public_key": connector["connector_public_key"],
                "connector_key_id": connector["connector_key_id"],
                "connector_wrapping_alg": connector.get("connector_wrapping_alg")
                or _CONNECTOR_WRAPPING_ALG,
                "connector_public_key_fingerprint": connector.get("public_key_fingerprint"),
                "reason": reason,
                "workflow_id": workflow["workflow_id"],
                "gmail_thread_id": workflow.get("gmail_thread_id"),
                "gmail_message_id": workflow.get("gmail_message_id"),
                "required_fields": required_fields,
                "workflow_url": f"{frontend_origin()}/one/kyc?workflowId={workflow['workflow_id']}",
                "request_url": _kyc_consent_request_url(consent_request_id),
                "speaker_persona": "one",
                "delegate_agent_id": "kyc",
                "consent_reviewer_agent_id": _NAV_AGENT_ID,
            },
        )

    async def _ensure_consent_request(
        self,
        workflow: dict[str, Any],
        *,
        connector: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        existing_request_id = _clean_text(workflow.get("consent_request_id"))
        if existing_request_id:
            metadata = workflow.get("metadata", {})
            if _is_legacy_consent_request_url(metadata.get("consent_request_url")):
                return self._update_workflow(
                    workflow["workflow_id"],
                    metadata={
                        **metadata,
                        "consent_request_url": _kyc_consent_request_url(existing_request_id),
                    },
                )
            return workflow

        connector = connector or self._get_active_client_connector(workflow.get("user_id"))
        if not connector:
            return self._update_workflow(
                workflow["workflow_id"],
                status="needs_client_connector",
                last_error_code="kyc_client_connector_missing",
                last_error_message=(
                    "Unlock the KYC workspace once so One can register a client-held connector key."
                ),
                metadata={
                    **workflow.get("metadata", {}),
                    "strict_client_zk": True,
                    "client_connector_required": True,
                },
            )

        consent_request_id = _kyc_consent_request_id(workflow["workflow_id"])
        await self._create_consent_request(
            workflow=workflow,
            connector=connector,
            consent_request_id=consent_request_id,
            required_fields=workflow.get("required_fields") or [],
        )
        return self._update_workflow(
            workflow["workflow_id"],
            status="needs_scope"
            if workflow.get("status") == "needs_client_connector"
            else workflow.get("status"),
            consent_request_id=consent_request_id,
            metadata={
                **workflow.get("metadata", {}),
                "consent_request_url": _kyc_consent_request_url(consent_request_id),
                "client_connector_key_id": connector["connector_key_id"],
                "client_connector_fingerprint": connector.get("public_key_fingerprint"),
                "strict_client_zk": True,
            },
        )

    async def list_workflows(self, *, user_id: str) -> dict[str, Any]:
        sql = """
            SELECT *
            FROM one_kyc_workflows
            WHERE user_id = :user_id
            ORDER BY created_at DESC
            LIMIT 100
        """
        rows = [
            self._public_workflow(dict(row))
            for row in self.db.execute_raw(sql, {"user_id": user_id}).data
        ]
        return {"workflows": rows}

    async def get_workflow(self, *, user_id: str, workflow_id: str) -> dict[str, Any]:
        workflow = self._get_workflow_for_user(user_id=user_id, workflow_id=workflow_id)
        if not workflow:
            raise OneEmailKycError(
                "KYC workflow not found.",
                status_code=404,
                code="ONE_KYC_WORKFLOW_NOT_FOUND",
            )
        return workflow

    async def refresh_workflow(self, *, user_id: str, workflow_id: str) -> dict[str, Any]:
        workflow = await self.get_workflow(user_id=user_id, workflow_id=workflow_id)
        if workflow["status"] == "needs_client_connector":
            workflow = await self._ensure_consent_request(workflow)
        if workflow["status"] not in {"needs_scope", "needs_documents"} or not workflow.get(
            "consent_request_id"
        ):
            return workflow
        status = await self.consent_db.get_request_status(user_id, workflow["consent_request_id"])
        action = _clean_text(status.get("action") if status else None).upper()
        if action == "CONSENT_GRANTED":
            token_id = _clean_text(status.get("token_id") if status else None)
            export_package = await self._get_validated_consent_export(
                workflow=workflow,
                consent_token=token_id,
            )
            if not export_package:
                return self._update_workflow(
                    workflow_id,
                    last_error_code="scoped_export_pending",
                    last_error_message="Consent is granted; One is waiting for the scoped encrypted export.",
                )
            export_metadata = self._public_export_metadata(export_package)
            workflow = self._update_workflow(
                workflow_id,
                status="waiting_on_user",
                draft_status="ready",
                draft_subject=self._reply_subject(workflow.get("subject")),
                draft_body=None,
                last_error_code=None,
                last_error_message=None,
                metadata={
                    **_redact_sensitive_workflow_metadata(workflow.get("metadata", {})),
                    "consent_export": export_metadata,
                    "client_draft_required": True,
                    "draft_revision": int(
                        (workflow.get("metadata") or {}).get("draft_revision") or 0
                    )
                    + 1,
                },
            )
        elif action in {"CONSENT_DENIED", "DENIED", "REVOKED"}:
            workflow = self._update_workflow(
                workflow_id,
                status="blocked",
                last_error_code="consent_not_granted",
                last_error_message="The scoped KYC consent request was denied or revoked.",
            )
        return workflow

    async def get_workflow_consent_export(
        self,
        *,
        user_id: str,
        workflow_id: str,
    ) -> dict[str, Any]:
        workflow = await self.get_workflow(user_id=user_id, workflow_id=workflow_id)
        if workflow.get("status") != "waiting_on_user" or workflow.get("draft_status") != "ready":
            raise OneEmailKycError(
                "KYC workflow export is only available for a ready client draft.",
                status_code=409,
                code="ONE_KYC_EXPORT_NOT_READY",
            )
        request_id = _clean_text(workflow.get("consent_request_id"))
        user = _clean_text(workflow.get("user_id"))
        if not request_id or not user:
            raise OneEmailKycError(
                "KYC workflow has no active consent request.",
                status_code=409,
                code="ONE_KYC_CONSENT_REVALIDATION_MISSING",
            )
        status = await self.consent_db.get_request_status(user, request_id)
        if _clean_text(status.get("action") if status else None).upper() != "CONSENT_GRANTED":
            raise OneEmailKycError(
                "KYC consent is not active enough to load the encrypted export.",
                status_code=409,
                code="ONE_KYC_CONSENT_NOT_ACTIVE",
            )
        token_id = _clean_text(status.get("token_id") if status else None)
        export_package = await self._get_validated_consent_export(
            workflow=workflow,
            consent_token=token_id,
        )
        if not export_package:
            raise OneEmailKycError(
                "KYC consent export is unavailable.",
                status_code=404,
                code="ONE_KYC_EXPORT_UNAVAILABLE",
            )
        self._validate_send_export_binding(workflow=workflow, export_package=export_package)
        return self._public_encrypted_export(export_package)

    async def _get_validated_consent_export(
        self,
        *,
        workflow: dict[str, Any],
        consent_token: str | None,
    ) -> dict[str, Any] | None:
        if not consent_token:
            return None
        export_package = await self.consent_db.get_consent_export(consent_token)
        if not export_package:
            return None
        self._validate_consent_export(workflow=workflow, export_package=export_package)
        return export_package

    def _public_encrypted_export(self, export_package: dict[str, Any]) -> dict[str, Any]:
        generated_at = export_package.get("export_generated_at")
        if isinstance(generated_at, datetime):
            generated_at = generated_at.isoformat()
        return {
            "status": "success",
            "encrypted_data": export_package.get("encrypted_data"),
            "iv": export_package.get("iv"),
            "tag": export_package.get("tag"),
            "wrapped_key_bundle": export_package.get("wrapped_key_bundle"),
            "scope": export_package.get("scope"),
            "export_revision": export_package.get("export_revision"),
            "export_generated_at": generated_at,
            "export_refresh_status": export_package.get("refresh_status"),
        }

    def _validate_consent_export(
        self,
        *,
        workflow: dict[str, Any],
        export_package: dict[str, Any],
    ) -> None:
        expected_scope = _validate_kyc_data_scope(_clean_text(workflow.get("requested_scope")))
        if _clean_text(export_package.get("scope")) != expected_scope:
            raise OneEmailKycError(
                "KYC scoped export does not match the requested workflow scope.",
                status_code=409,
                code="ONE_KYC_EXPORT_SCOPE_MISMATCH",
            )
        if export_package.get("refresh_status") != "current":
            raise OneEmailKycError(
                "KYC scoped export is stale and must be refreshed before drafting or sending.",
                status_code=409,
                code="ONE_KYC_EXPORT_NOT_CURRENT",
            )
        if not export_package.get("is_strict_zero_knowledge"):
            raise OneEmailKycError(
                "KYC scoped export must use strict wrapped-key encryption.",
                status_code=409,
                code="ONE_KYC_EXPORT_NOT_STRICT",
            )
        metadata = workflow.get("metadata", {})
        expected_key_id = _clean_text(
            metadata.get("client_connector_key_id") if isinstance(metadata, dict) else None
        )
        if not expected_key_id:
            connector = self._get_active_client_connector(workflow.get("user_id"))
            expected_key_id = _clean_text(connector.get("connector_key_id") if connector else None)
        actual_key_id = _clean_text(export_package.get("connector_key_id"))
        if not expected_key_id:
            raise OneEmailKycError(
                "KYC client connector key id is required for scoped export validation.",
                status_code=409,
                code="ONE_KYC_CLIENT_CONNECTOR_KEY_ID_MISSING",
            )
        if actual_key_id != expected_key_id:
            raise OneEmailKycError(
                "KYC scoped export connector key does not match the client-held KYC key.",
                status_code=409,
                code="ONE_KYC_CONNECTOR_KEY_MISMATCH",
            )
        wrapping_alg = _clean_text(export_package.get("connector_wrapping_alg")) or _clean_text(
            (export_package.get("wrapped_key_bundle") or {}).get("wrapping_alg")
        )
        if wrapping_alg != _CONNECTOR_WRAPPING_ALG:
            raise OneEmailKycError(
                "KYC scoped export uses an unsupported connector wrapping algorithm.",
                status_code=409,
                code="ONE_KYC_CONNECTOR_WRAPPING_MISMATCH",
            )

    def _public_export_metadata(self, export_package: dict[str, Any]) -> dict[str, Any]:
        generated_at = export_package.get("export_generated_at")
        if isinstance(generated_at, datetime):
            generated_at = generated_at.isoformat()
        return {
            "scope": export_package.get("scope"),
            "export_revision": export_package.get("export_revision"),
            "export_generated_at": generated_at,
            "refresh_status": export_package.get("refresh_status"),
            "connector_key_id": export_package.get("connector_key_id"),
            "connector_wrapping_alg": export_package.get("connector_wrapping_alg"),
            "is_strict_zero_knowledge": export_package.get("is_strict_zero_knowledge"),
        }

    def _validate_send_export_binding(
        self,
        *,
        workflow: dict[str, Any],
        export_package: dict[str, Any],
        consent_export_revision: int | None = None,
    ) -> None:
        metadata = workflow.get("metadata", {})
        workflow_export = metadata.get("consent_export") if isinstance(metadata, dict) else None
        if not isinstance(workflow_export, dict):
            raise OneEmailKycError(
                "KYC workflow is not bound to the approved export revision.",
                status_code=409,
                code="ONE_KYC_DRAFT_EXPORT_BINDING_MISSING",
            )
        current_export = self._public_export_metadata(export_package)
        if consent_export_revision is not None and str(consent_export_revision) != str(
            current_export.get("export_revision") or ""
        ):
            raise OneEmailKycError(
                "KYC approved reply must be regenerated because the approved export changed.",
                status_code=409,
                code="ONE_KYC_DRAFT_EXPORT_STALE",
            )
        compared_fields = (
            "scope",
            "export_revision",
            "export_generated_at",
            "connector_key_id",
            "connector_wrapping_alg",
        )
        for field in compared_fields:
            if (
                str(workflow_export.get(field) or "").strip()
                != str(current_export.get(field) or "").strip()
            ):
                raise OneEmailKycError(
                    "KYC approved reply must be regenerated because the approved export changed.",
                    status_code=409,
                    code="ONE_KYC_DRAFT_EXPORT_STALE",
                )

    def _extract_approved_field_values(
        self,
        *,
        approved_payload: dict[str, Any],
        required_fields: list[str],
    ) -> tuple[dict[str, str], list[str]]:
        field_aliases = {
            "full_name": (
                "full_name",
                "fullName",
                "legal_name",
                "legalName",
                "name",
                "display_name",
            ),
            "date_of_birth": ("date_of_birth", "dateOfBirth", "dob", "birth_date", "birthDate"),
            "address": ("address", "residential_address", "residentialAddress", "mailing_address"),
            "phone_number": ("phone_number", "phoneNumber", "phone", "mobile", "telephone"),
            "email": ("email", "email_address", "emailAddress"),
            "tax_residency": ("tax_residency", "taxResidency", "tax_residence", "taxResidence"),
            "nationality": ("nationality", "citizenship"),
            "employment": ("employment", "occupation", "employer"),
            "source_of_funds": ("source_of_funds", "sourceOfFunds", "source_of_wealth"),
            "brokerage_profile": ("brokerage_profile", "brokerageProfile", "trading_experience"),
            "identity_profile": ("identity", "profile", "identity_profile", "identityProfile"),
        }
        source = approved_payload.get("identity")
        if not isinstance(source, dict):
            source = approved_payload
        values: dict[str, str] = {}
        missing: list[str] = []
        for field in required_fields or ["identity_profile"]:
            aliases = field_aliases.get(field, (field,))
            value = self._find_approved_value(source, aliases)
            if value is None:
                missing.append(field)
            else:
                values[field] = value
        return values, missing

    def _find_approved_value(self, value: Any, aliases: tuple[str, ...]) -> str | None:
        normalized_aliases = {_normalize_field_key(alias) for alias in aliases}
        if isinstance(value, dict):
            for key, item in value.items():
                if key == "__export_metadata":
                    continue
                if _normalize_field_key(key) in normalized_aliases:
                    formatted = self._format_approved_value(item)
                    if formatted:
                        return formatted
            for key, item in value.items():
                if key == "__export_metadata":
                    continue
                formatted = self._find_approved_value(item, aliases)
                if formatted:
                    return formatted
        elif isinstance(value, list):
            for item in value:
                formatted = self._find_approved_value(item, aliases)
                if formatted:
                    return formatted
        return None

    def _format_approved_value(self, value: Any) -> str | None:
        if value is None:
            return None
        if isinstance(value, str):
            return _truncate(value, 500)
        if isinstance(value, (int, float, bool)):
            return _truncate(str(value), 500)
        if isinstance(value, list):
            items = [self._format_approved_value(item) for item in value]
            joined = ", ".join(item for item in items if item)
            return _truncate(joined, 500)
        if isinstance(value, dict):
            public_items = []
            for key, item in value.items():
                if key == "__export_metadata":
                    continue
                formatted = self._format_approved_value(item)
                if formatted:
                    public_items.append(f"{key.replace('_', ' ')}: {formatted}")
            return _truncate("; ".join(public_items), 1000)
        return None

    def _reply_subject(self, subject: str | None) -> str:
        value = _clean_text(subject) or "KYC request"
        if value.lower().startswith("re:"):
            return value[:500]
        return f"Re: {value}"[:500]

    async def approve_draft(self, *, user_id: str, workflow_id: str) -> dict[str, Any]:
        raise OneEmailKycError(
            "KYC draft approval now requires a client-generated approved reply body.",
            status_code=410,
            code="ONE_KYC_CLIENT_APPROVED_BODY_REQUIRED",
        )

    async def send_approved_reply(
        self,
        *,
        user_id: str,
        workflow_id: str,
        approved_subject: str | None,
        approved_body: str,
        client_draft_hash: str | None = None,
        consent_export_revision: int | None = None,
        pkm_writeback_artifact_hash: str | None = None,
    ) -> dict[str, Any]:
        workflow = await self.get_workflow(user_id=user_id, workflow_id=workflow_id)
        if (
            workflow.get("draft_status") == "sent"
            or workflow.get("status") == "waiting_on_counterparty"
        ):
            return workflow
        if workflow.get("status") != "waiting_on_user" or workflow.get("draft_status") != "ready":
            raise OneEmailKycError(
                "KYC workflow is not ready for approved reply send.",
                status_code=409,
                code="ONE_KYC_DRAFT_NOT_READY",
            )
        body = _clean_text(approved_body)
        if not body:
            raise OneEmailKycError(
                "Approved KYC reply body is required.",
                status_code=400,
                code="ONE_KYC_APPROVED_BODY_REQUIRED",
            )
        if len(body) > _MAX_DRAFT_BODY:
            raise OneEmailKycError(
                "Approved KYC reply body is too long.",
                status_code=400,
                code="ONE_KYC_APPROVED_BODY_TOO_LONG",
            )
        subject = (
            _truncate(approved_subject, 500)
            or workflow.get("draft_subject")
            or self._reply_subject(workflow.get("subject"))
        )
        writeback_artifact_hash = _truncate(pkm_writeback_artifact_hash, 128)
        if not re.fullmatch(r"[a-f0-9]{64}", writeback_artifact_hash or ""):
            raise OneEmailKycError(
                "Approved KYC send requires a predeclared encrypted PKM writeback artifact hash.",
                status_code=400,
                code="ONE_KYC_WRITEBACK_ARTIFACT_HASH_INVALID",
            )
        send_attempt_id = uuid.uuid4().hex
        await self._require_sendable_consent(
            workflow,
            consent_export_revision=consent_export_revision,
        )
        pending = self._update_workflow(
            workflow_id,
            send_attempt_id=send_attempt_id,
            send_status="sending",
            client_draft_hash=_truncate(client_draft_hash, 128),
            pkm_writeback_status="pending",
            pkm_writeback_artifact_hash=writeback_artifact_hash,
            metadata={
                **workflow.get("metadata", {}),
                "send_attempt_id": send_attempt_id,
                "send_status": "sending",
                "client_draft_hash": _truncate(client_draft_hash, 128),
                "approved_send_hash": hashlib.sha256(body.encode("utf-8")).hexdigest(),
                "pkm_writeback_status": "pending",
                "pkm_writeback_artifact_hash": writeback_artifact_hash,
            },
        )
        try:
            send_result = await asyncio.to_thread(
                self._send_approved_reply,
                pending,
                approved_subject=subject,
                approved_body=body,
            )
        except Exception:
            self._update_workflow(
                workflow_id,
                send_status="failed",
                pkm_writeback_status="not_started",
                metadata={
                    **pending.get("metadata", {}),
                    "send_status": "failed",
                    "send_failed_at": _utcnow().isoformat(),
                    "pkm_writeback_status": "not_started",
                },
            )
            raise
        return self._update_workflow(
            workflow_id,
            status="waiting_on_counterparty",
            draft_status="sent",
            send_status="sent",
            sent_message_id=send_result.get("id"),
            sent_at=_utcnow(),
            approved_send_hash=hashlib.sha256(body.encode("utf-8")).hexdigest(),
            metadata={
                **pending.get("metadata", {}),
                "send_status": "sent",
                "sent_message_id": send_result.get("id"),
                "sent_at": _utcnow().isoformat(),
            },
        )

    async def _require_sendable_consent(
        self,
        workflow: dict[str, Any],
        *,
        consent_export_revision: int | None = None,
    ) -> None:
        request_id = _clean_text(workflow.get("consent_request_id"))
        user_id = _clean_text(workflow.get("user_id"))
        if not request_id or not user_id:
            raise OneEmailKycError(
                "KYC draft has no active consent request to revalidate.",
                status_code=409,
                code="ONE_KYC_CONSENT_REVALIDATION_MISSING",
            )
        status = await self.consent_db.get_request_status(user_id, request_id)
        if _clean_text(status.get("action") if status else None).upper() != "CONSENT_GRANTED":
            raise OneEmailKycError(
                "KYC consent is not active enough to send this draft.",
                status_code=409,
                code="ONE_KYC_CONSENT_NOT_ACTIVE",
            )
        token_id = _clean_text(status.get("token_id") if status else None)
        export_package = await self._get_validated_consent_export(
            workflow=workflow,
            consent_token=token_id,
        )
        if not export_package:
            raise OneEmailKycError(
                "KYC consent export is unavailable, so One cannot send this draft.",
                status_code=409,
                code="ONE_KYC_EXPORT_UNAVAILABLE",
            )
        self._validate_send_export_binding(
            workflow=workflow,
            export_package=export_package,
            consent_export_revision=consent_export_revision,
        )

    async def redraft(
        self,
        *,
        user_id: str,
        workflow_id: str,
        instructions: str,
        source: str = "text",
    ) -> dict[str, Any]:
        workflow = await self.get_workflow(user_id=user_id, workflow_id=workflow_id)
        if workflow.get("status") != "waiting_on_user" or workflow.get("draft_status") != "ready":
            raise OneEmailKycError(
                "KYC draft is not ready for redraft.",
                status_code=409,
                code="ONE_KYC_DRAFT_NOT_READY",
            )
        cleaned_instructions = _truncate(instructions, 1000)
        if not cleaned_instructions:
            raise OneEmailKycError(
                "KYC redraft instructions are required.",
                status_code=400,
                code="ONE_KYC_REDRAFT_INSTRUCTIONS_REQUIRED",
            )
        source_value = source if source in {"text", "voice"} else "text"
        metadata = workflow.get("metadata", {})
        revision = int(metadata.get("draft_revision") or 1) + 1
        return self._update_workflow(
            workflow_id,
            draft_status="ready",
            metadata={
                **metadata,
                "draft_revision": revision,
                "last_redraft_source": source_value,
                "last_redraft_at": _utcnow().isoformat(),
                "last_redraft_instruction_hash": hashlib.sha256(
                    cleaned_instructions.encode("utf-8")
                ).hexdigest(),
                "client_draft_required": True,
            },
        )

    async def reject_draft(
        self,
        *,
        user_id: str,
        workflow_id: str,
        reason: str | None = None,
    ) -> dict[str, Any]:
        workflow = await self.get_workflow(user_id=user_id, workflow_id=workflow_id)
        if workflow.get("status") != "waiting_on_user" or workflow.get("draft_status") != "ready":
            raise OneEmailKycError(
                "KYC draft is not ready for rejection.",
                status_code=409,
                code="ONE_KYC_DRAFT_NOT_READY",
            )
        return self._update_workflow(
            workflow_id,
            status="blocked",
            draft_status="rejected",
            last_error_code="draft_rejected",
            last_error_message=_truncate(reason, 300) or "The user rejected the KYC draft.",
            metadata={**workflow.get("metadata", {}), "rejected_at": _utcnow().isoformat()},
        )

    async def mark_writeback_complete(
        self,
        *,
        user_id: str,
        workflow_id: str,
        artifact_hash: str,
        status: str = "succeeded",
        error_message: str | None = None,
    ) -> dict[str, Any]:
        workflow = await self.get_workflow(user_id=user_id, workflow_id=workflow_id)
        normalized_status = _clean_text(status).lower() or "succeeded"
        if normalized_status not in {"succeeded", "failed"}:
            raise OneEmailKycError(
                "KYC PKM writeback status is invalid.",
                status_code=400,
                code="ONE_KYC_WRITEBACK_STATUS_INVALID",
            )
        if (
            workflow.get("status") != "waiting_on_counterparty"
            or workflow.get("draft_status") != "sent"
            or workflow.get("send_status") != "sent"
        ):
            raise OneEmailKycError(
                "KYC PKM writeback can only be marked after the approved reply is sent.",
                status_code=409,
                code="ONE_KYC_WRITEBACK_NOT_READY",
            )
        truncated_artifact_hash = _truncate(artifact_hash, 128)
        if not re.fullmatch(r"[a-f0-9]{64}", truncated_artifact_hash or ""):
            raise OneEmailKycError(
                "KYC PKM writeback artifact hash is invalid.",
                status_code=400,
                code="ONE_KYC_WRITEBACK_ARTIFACT_HASH_INVALID",
            )
        metadata = workflow.get("metadata", {})
        expected_artifact_hash = _clean_text(workflow.get("pkm_writeback_artifact_hash")) or (
            _clean_text(metadata.get("pkm_writeback_artifact_hash"))
            if isinstance(metadata, dict)
            else ""
        )
        if not expected_artifact_hash:
            raise OneEmailKycError(
                "KYC PKM writeback has no predeclared artifact hash.",
                status_code=409,
                code="ONE_KYC_WRITEBACK_ARTIFACT_HASH_MISSING",
            )
        if truncated_artifact_hash != expected_artifact_hash:
            raise OneEmailKycError(
                "KYC PKM writeback artifact hash does not match the approved send.",
                status_code=409,
                code="ONE_KYC_WRITEBACK_ARTIFACT_HASH_MISMATCH",
            )
        if workflow.get("pkm_writeback_status") == "succeeded":
            if (
                normalized_status == "succeeded"
                and workflow.get("pkm_writeback_artifact_hash") == truncated_artifact_hash
            ):
                return workflow
            raise OneEmailKycError(
                "KYC PKM writeback is already complete.",
                status_code=409,
                code="ONE_KYC_WRITEBACK_ALREADY_COMPLETED",
            )
        attempt_count = int(workflow.get("pkm_writeback_attempt_count") or 0) + 1
        completed_at = _utcnow() if normalized_status == "succeeded" else None
        metadata = {
            **workflow.get("metadata", {}),
            "pkm_writeback_status": normalized_status,
            "pkm_writeback_artifact_hash": truncated_artifact_hash,
            "pkm_writeback_attempt_count": attempt_count,
            "pkm_writeback_last_error": _truncate(error_message, 500),
        }
        if completed_at:
            metadata["pkm_writeback_completed_at"] = completed_at.isoformat()
        return self._update_workflow(
            workflow_id,
            pkm_writeback_status=normalized_status,
            pkm_writeback_artifact_hash=truncated_artifact_hash,
            pkm_writeback_attempt_count=attempt_count,
            pkm_writeback_last_error=_truncate(error_message, 500),
            pkm_writeback_completed_at=completed_at,
            metadata=metadata,
        )

    async def purge_terminal_drafts(self, *, older_than_days: int = 30) -> dict[str, Any]:
        days = max(1, min(int(older_than_days or 30), 365))
        sql = """
            UPDATE one_kyc_workflows
            SET
              draft_body = NULL,
              metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                'draft_body_redacted_at', NOW(),
                'draft_body_retention_days', :days
              ),
              updated_at = NOW()
            WHERE draft_body IS NOT NULL
              AND status IN ('waiting_on_counterparty', 'completed', 'blocked')
              AND updated_at < NOW() - (:days * INTERVAL '1 day')
            RETURNING workflow_id
        """
        rows = self.db.execute_raw(sql, {"days": days}).data or []
        return {"purged": len(rows), "older_than_days": days}

    def _send_approved_reply(
        self,
        workflow: dict[str, Any],
        *,
        approved_subject: str,
        approved_body: str,
    ) -> dict[str, Any]:
        recipient = _clean_text(workflow.get("sender_email"))
        if not recipient:
            raise OneEmailKycError(
                "KYC workflow has no sender email to reply to.",
                status_code=409,
                code="ONE_KYC_REPLY_RECIPIENT_MISSING",
            )
        msg = EmailMessage()
        msg["To"] = recipient
        msg["From"] = f"{_ONE_EMAIL_DISPLAY_NAME} <{self.config.mailbox_email}>"
        msg["Subject"] = approved_subject
        rfc_message_id = _clean_text(workflow.get("rfc_message_id"))
        if rfc_message_id:
            msg["In-Reply-To"] = rfc_message_id
            msg["References"] = rfc_message_id
        msg.set_content(approved_body)
        encoded = base64.urlsafe_b64encode(msg.as_bytes()).decode("utf-8")
        payload: dict[str, Any] = {"raw": encoded}
        thread_id = _clean_text(workflow.get("gmail_thread_id"))
        if thread_id:
            payload["threadId"] = thread_id
        return self._post_json_sync(
            f"{_GMAIL_MESSAGES_URL}/send",
            json_payload=payload,
            scopes=(_GMAIL_SEND_SCOPE,),
        )

    def _get_mailbox_state(self) -> dict[str, Any] | None:
        sql = """
            SELECT *
            FROM one_email_mailbox_state
            WHERE mailbox_email = :mailbox_email
            LIMIT 1
        """
        rows = self.db.execute_raw(sql, {"mailbox_email": self.config.mailbox_email}).data
        return dict(rows[0]) if rows else None

    def _upsert_mailbox_state(
        self,
        *,
        history_id: str | None = None,
        watch_status: str | None = None,
        watch_expiration_at: datetime | None = None,
        last_watch_renewed: bool = False,
        last_notification: bool = False,
    ) -> None:
        sql = """
            INSERT INTO one_email_mailbox_state (
              mailbox_email,
              history_id,
              watch_status,
              watch_expiration_at,
              last_watch_renewed_at,
              last_notification_at,
              updated_at
            )
            VALUES (
              :mailbox_email,
              :history_id,
              COALESCE(:watch_status, 'unknown'),
              :watch_expiration_at,
              CASE WHEN :last_watch_renewed THEN NOW() ELSE NULL END,
              CASE WHEN :last_notification THEN NOW() ELSE NULL END,
              NOW()
            )
            ON CONFLICT (mailbox_email) DO UPDATE SET
              history_id = COALESCE(EXCLUDED.history_id, one_email_mailbox_state.history_id),
              watch_status = CASE
                WHEN :watch_status IS NOT NULL THEN EXCLUDED.watch_status
                ELSE one_email_mailbox_state.watch_status
              END,
              watch_expiration_at = COALESCE(EXCLUDED.watch_expiration_at, one_email_mailbox_state.watch_expiration_at),
              last_watch_renewed_at = COALESCE(EXCLUDED.last_watch_renewed_at, one_email_mailbox_state.last_watch_renewed_at),
              last_notification_at = COALESCE(EXCLUDED.last_notification_at, one_email_mailbox_state.last_notification_at),
              updated_at = NOW()
        """
        self.db.execute_raw(
            sql,
            {
                "mailbox_email": self.config.mailbox_email,
                "history_id": _clean_text(history_id) or None,
                "watch_status": watch_status,
                "watch_expiration_at": watch_expiration_at,
                "last_watch_renewed": bool(last_watch_renewed),
                "last_notification": bool(last_notification),
            },
        )

    def _workflow_by_message_id(self, gmail_message_id: str) -> dict[str, Any] | None:
        sql = """
            SELECT *
            FROM one_kyc_workflows
            WHERE gmail_message_id = :gmail_message_id
            LIMIT 1
        """
        rows = self.db.execute_raw(sql, {"gmail_message_id": gmail_message_id}).data
        return self._public_workflow(dict(rows[0])) if rows else None

    def _get_workflow_for_user(self, *, user_id: str, workflow_id: str) -> dict[str, Any] | None:
        sql = """
            SELECT *
            FROM one_kyc_workflows
            WHERE user_id = :user_id
              AND workflow_id = :workflow_id
            LIMIT 1
        """
        rows = self.db.execute_raw(sql, {"user_id": user_id, "workflow_id": workflow_id}).data
        return self._public_workflow(dict(rows[0])) if rows else None

    def _insert_workflow(self, **values: Any) -> dict[str, Any]:
        status = _clean_text(values.get("status"))
        if status not in _KYC_WORKFLOW_STATES:
            raise OneEmailKycError(
                f"Unsupported KYC workflow status: {status}",
                status_code=500,
                code="ONE_KYC_INVALID_WORKFLOW_STATUS",
            )
        sql = """
            INSERT INTO one_kyc_workflows (
              workflow_id,
              user_id,
              status,
              gmail_message_id,
              gmail_thread_id,
              gmail_history_id,
              sender_email,
              sender_name,
              participant_emails,
              subject,
              snippet,
              counterparty_label,
              rfc_message_id,
              required_fields,
              requested_scope,
              last_error_code,
              last_error_message,
              metadata,
              updated_at
            )
            VALUES (
              :workflow_id,
              :user_id,
              :status,
              :gmail_message_id,
              :gmail_thread_id,
              :gmail_history_id,
              :sender_email,
              :sender_name,
              CAST(:participant_emails AS jsonb),
              :subject,
              :snippet,
              :counterparty_label,
              :rfc_message_id,
              CAST(:required_fields AS jsonb),
              :requested_scope,
              :last_error_code,
              :last_error_message,
              CAST(:metadata AS jsonb),
              NOW()
            )
            RETURNING *
        """
        params = {
            **values,
            "participant_emails": _json(values.get("participant_emails") or []),
            "required_fields": _json(values.get("required_fields") or []),
            "metadata": _json(values.get("metadata") or {}),
        }
        result = self.db.execute_raw(sql, params).data
        if not result:
            raise OneEmailKycError(
                "KYC workflow insert returned no row.",
                status_code=500,
                code="ONE_KYC_WORKFLOW_INSERT_FAILED",
            )
        return self._public_workflow(dict(result[0]))

    def _update_workflow(self, workflow_id: str, **values: Any) -> dict[str, Any]:
        allowed = {
            "status",
            "consent_request_id",
            "draft_subject",
            "draft_status",
            "send_attempt_id",
            "send_status",
            "sent_message_id",
            "sent_at",
            "client_draft_hash",
            "approved_send_hash",
            "pkm_writeback_status",
            "pkm_writeback_artifact_hash",
            "pkm_writeback_attempt_count",
            "pkm_writeback_last_error",
            "pkm_writeback_completed_at",
            "last_error_code",
            "last_error_message",
            "metadata",
        }
        updates = {key: value for key, value in values.items() if key in allowed}
        if not updates:
            workflow = self._get_workflow_by_id(workflow_id)
            if workflow:
                return workflow
            raise OneEmailKycError("KYC workflow not found.", status_code=404)
        params: dict[str, Any] = {"workflow_id": workflow_id}
        for key in allowed:
            params[f"set_{key}"] = key in updates
            params[key] = _json(updates.get(key) or {}) if key == "metadata" else updates.get(key)
        sql = """
            UPDATE one_kyc_workflows
            SET
              status = CASE WHEN :set_status THEN :status ELSE status END,
              consent_request_id = CASE
                WHEN :set_consent_request_id THEN :consent_request_id
                ELSE consent_request_id
              END,
              draft_subject = CASE
                WHEN :set_draft_subject THEN :draft_subject
                ELSE draft_subject
              END,
              draft_status = CASE
                WHEN :set_draft_status THEN :draft_status
                ELSE draft_status
              END,
              send_attempt_id = CASE
                WHEN :set_send_attempt_id THEN :send_attempt_id
                ELSE send_attempt_id
              END,
              send_status = CASE
                WHEN :set_send_status THEN :send_status
                ELSE send_status
              END,
              sent_message_id = CASE
                WHEN :set_sent_message_id THEN :sent_message_id
                ELSE sent_message_id
              END,
              sent_at = CASE
                WHEN :set_sent_at THEN :sent_at
                ELSE sent_at
              END,
              client_draft_hash = CASE
                WHEN :set_client_draft_hash THEN :client_draft_hash
                ELSE client_draft_hash
              END,
              approved_send_hash = CASE
                WHEN :set_approved_send_hash THEN :approved_send_hash
                ELSE approved_send_hash
              END,
              pkm_writeback_status = CASE
                WHEN :set_pkm_writeback_status THEN :pkm_writeback_status
                ELSE pkm_writeback_status
              END,
              pkm_writeback_artifact_hash = CASE
                WHEN :set_pkm_writeback_artifact_hash THEN :pkm_writeback_artifact_hash
                ELSE pkm_writeback_artifact_hash
              END,
              pkm_writeback_attempt_count = CASE
                WHEN :set_pkm_writeback_attempt_count THEN :pkm_writeback_attempt_count
                ELSE pkm_writeback_attempt_count
              END,
              pkm_writeback_last_error = CASE
                WHEN :set_pkm_writeback_last_error THEN :pkm_writeback_last_error
                ELSE pkm_writeback_last_error
              END,
              pkm_writeback_completed_at = CASE
                WHEN :set_pkm_writeback_completed_at THEN :pkm_writeback_completed_at
                ELSE pkm_writeback_completed_at
              END,
              last_error_code = CASE
                WHEN :set_last_error_code THEN :last_error_code
                ELSE last_error_code
              END,
              last_error_message = CASE
                WHEN :set_last_error_message THEN :last_error_message
                ELSE last_error_message
              END,
              metadata = CASE
                WHEN :set_metadata THEN CAST(:metadata AS jsonb)
                ELSE metadata
              END,
              updated_at = NOW()
            WHERE workflow_id = :workflow_id
            RETURNING *
        """
        rows = self.db.execute_raw(sql, params).data
        if not rows:
            raise OneEmailKycError(
                "KYC workflow not found.",
                status_code=404,
                code="ONE_KYC_WORKFLOW_NOT_FOUND",
            )
        return self._public_workflow(dict(rows[0]))

    def _get_workflow_by_id(self, workflow_id: str) -> dict[str, Any] | None:
        rows = self.db.execute_raw(
            "SELECT * FROM one_kyc_workflows WHERE workflow_id = :workflow_id LIMIT 1",
            {"workflow_id": workflow_id},
        ).data
        return self._public_workflow(dict(rows[0])) if rows else None

    def _public_workflow(self, row: dict[str, Any]) -> dict[str, Any]:
        metadata = _redact_sensitive_workflow_metadata(_metadata_from_row(row))
        required_fields = _json_list_from_row(row, "required_fields")
        participant_emails = _json_list_from_row(row, "participant_emails")
        consent_request_id = row.get("consent_request_id")
        return {
            "workflow_id": row.get("workflow_id"),
            "user_id": row.get("user_id"),
            "status": row.get("status"),
            "gmail_thread_id": row.get("gmail_thread_id"),
            "gmail_message_id": row.get("gmail_message_id"),
            "sender_email": row.get("sender_email"),
            "sender_name": row.get("sender_name"),
            "participant_emails": participant_emails,
            "subject": row.get("subject"),
            "snippet": row.get("snippet"),
            "counterparty_label": row.get("counterparty_label"),
            "required_fields": required_fields,
            "requested_scope": row.get("requested_scope"),
            "consent_request_id": consent_request_id,
            "consent_export": metadata.get("consent_export"),
            "consent_request_url": (
                _kyc_consent_request_url(consent_request_id)
                if _is_legacy_consent_request_url(metadata.get("consent_request_url"))
                else metadata.get("consent_request_url")
                or _kyc_consent_request_url(consent_request_id)
            ),
            "workflow_url": metadata.get("workflow_url"),
            "draft_subject": row.get("draft_subject"),
            "draft_body": None,
            "draft_status": row.get("draft_status"),
            "send_attempt_id": row.get("send_attempt_id") or metadata.get("send_attempt_id"),
            "send_status": row.get("send_status") or metadata.get("send_status"),
            "sent_message_id": row.get("sent_message_id") or metadata.get("sent_message_id"),
            "sent_at": _iso(row.get("sent_at")) or metadata.get("sent_at"),
            "client_draft_hash": row.get("client_draft_hash") or metadata.get("client_draft_hash"),
            "approved_send_hash": row.get("approved_send_hash")
            or metadata.get("approved_send_hash"),
            "pkm_writeback_status": row.get("pkm_writeback_status")
            or metadata.get("pkm_writeback_status"),
            "pkm_writeback_artifact_hash": row.get("pkm_writeback_artifact_hash")
            or metadata.get("pkm_writeback_artifact_hash"),
            "pkm_writeback_attempt_count": row.get("pkm_writeback_attempt_count")
            or metadata.get("pkm_writeback_attempt_count"),
            "pkm_writeback_last_error": row.get("pkm_writeback_last_error")
            or metadata.get("pkm_writeback_last_error"),
            "pkm_writeback_completed_at": _iso(row.get("pkm_writeback_completed_at"))
            or metadata.get("pkm_writeback_completed_at"),
            "last_error_code": row.get("last_error_code"),
            "last_error_message": row.get("last_error_message"),
            "metadata": metadata,
            "created_at": _iso(row.get("created_at")),
            "updated_at": _iso(row.get("updated_at")),
        }


def _iso(value: Any) -> str | None:
    if isinstance(value, datetime):
        return value.isoformat()
    text = _clean_text(value)
    return text or None


def _google_epoch_ms_to_datetime(value: Any) -> datetime | None:
    try:
        milliseconds = int(value)
    except Exception:
        return None
    if milliseconds <= 0:
        return None
    return datetime.fromtimestamp(milliseconds / 1000, tz=timezone.utc)


_one_email_kyc_service: OneEmailKycService | None = None


def get_one_email_kyc_service() -> OneEmailKycService:
    global _one_email_kyc_service
    if _one_email_kyc_service is None:
        _one_email_kyc_service = OneEmailKycService()
    return _one_email_kyc_service
