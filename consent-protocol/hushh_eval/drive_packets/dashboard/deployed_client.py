"""Deployed UAT mode: Chris's request to Manish, sent to the deployed UAT backend.

The founder signs in with their own test buyer account in a separate sign-in window
(Firebase, the public UAT web config). The dashboard page keeps the Firebase ID token
and the UAT app session in memory and sends them with each call. This router forwards
a fixed whitelist to https://api.uat.hushh.ai from this server (no browser CORS), with
the paths, headers, bodies and idempotency keys the web app uses. The web app's
``/api/connectors/...`` and ``/api/consent/vault-owner-token`` routes pass the same
headers through unchanged, so UAT sees the same request.

Whitelist (anything else is refused before a network call):

=============== ====== =============================================== ==============
page route      method UAT path                                        tokens
=============== ====== =============================================== ==============
/session        POST   /api/consent/vault-owner-token                   Firebase
/owner          GET    /api/public/people/<Manish>                      none
/quote          GET    .../sharing/quote?ownerPersonRef=<Manish>        app session
/recipient      GET    .../sharing/recipient-identity                   both
/file-requests  POST   .../sharing/requests (confirm required)          both
/requests/<id>  GET    .../sharing/requests/<id> (sent from here only)  app session
/packets        GET    .../sharing/packets?ownerPersonRef=<Manish>      app session
/packets/<id>/  POST   .../sharing/packets/<id>/requests (confirm,      both
requests               Manish's listed packet only)
=============== ====== =============================================== ==============

No checkout or payment, Allow or Deny, sharing, listing, pricing or owner route can be
reached. The owner is fixed to Manish's public person reference from the founder
configuration; nothing here searches for or looks up anyone else. Tokens are never
stored or logged: the private call log keeps the operation, status, time and ids only.
"""

from __future__ import annotations

import base64
import binascii
import functools
import json
import logging
import os
import re
import threading
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID, uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StrictBool, model_validator

logger = logging.getLogger("hushh_eval.dashboard.deployed")

UAT_API_ORIGIN = "https://api.uat.hushh.ai"
UAT_APP_ORIGIN = "https://uat.one.hushh.ai"
UAT_APP_HOSTS = frozenset({"uat.one.hushh.ai", "uat.one.hussh.ai"})
SHARING = "/api/connectors/google_drive/sharing"
OWNER_NAME = "Manish"
OWNER_PROFILE_VAR = "DRIVE_PACKET_EVAL_OWNER_PROFILE"
WEB_ENV_FILE_VAR = "HUSHH_UAT_WEB_ENV_FILE"
DEFAULT_LIVE_ENV = Path("/Volumes/AnkitSSD/DevCache/p0-20261015/drive-eval-scratch/live-env.sh")
DEFAULT_STATE_DIR = Path(
    "/Volumes/AnkitSSD/DevCache/drive-packets-real-eval-20261014-private/dashboard"
)
REPO_WEB_ENV = Path(__file__).resolve().parents[4] / "hushh-webapp" / ".env.uat.local"
SIGNIN_HTML = Path(__file__).resolve().parent / "deployed_signin.html"
CALL_LOG = "deployed-calls.jsonl"
USER_AGENT = "hushh-local-dashboard/1"
MAX_BODY = 512 * 1024
PACKET_PAGES = 10
TERMINAL = frozenset({"completed", "declined", "cancelled", "expired", "no_files_shared"})

_UUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
_ID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
_CODE = re.compile(r"^[a-z_]{1,80}$")
_DAY = r"^\d{4}-\d{2}-\d{2}$"
_JWT = re.compile(r"^[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,2048}$")
_APP_TOKEN = re.compile(r"^HCT:[A-Za-z0-9_=.-]{24,8000}$")
_UID = re.compile(r"^[A-Za-z0-9_-]{6,128}$")
_CURSOR = re.compile(r"^[\x21-\x7e]{1,256}$")
_EMAIL = re.compile(r"^[^\s@]{1,64}@[^\s@]{1,190}$")
_ENV_LINE = re.compile(r"^\s*(?:export\s+)?(?P<name>[A-Z][A-Z0-9_]*)=(?P<value>.*?)\s*$")

# The page's routes and the tokens each one carries ("none", "firebase", "app", "both").
PAGE_ROUTES = {
    ("GET", "/api/deployed/config"): "none",
    ("GET", "/api/deployed/signin"): "none",
    ("POST", "/api/deployed/session"): "firebase",
    ("GET", "/api/deployed/owner"): "none",
    ("GET", "/api/deployed/quote"): "app",
    ("GET", "/api/deployed/recipient"): "both",
    ("POST", "/api/deployed/file-requests"): "both",
    ("GET", "/api/deployed/requests/{request_id}"): "app",
    ("GET", "/api/deployed/packets"): "app",
    ("POST", "/api/deployed/packets/{packet_id}/requests"): "both",
}

MESSAGES = {
    "not_allowed": "This page can't do that.",
    "confirm_required": "Confirm first. Nothing was sent.",
    "sign_in_required": "Sign in first.",
    "sign_in_again": "Your sign-in expired. Sign in again.",
    "session_required": "Still connecting to UAT. Try again in a moment.",
    "owner_account": "You're signed in as Manish. Sign in with your test buyer account.",
    "wrong_firebase_project": "That sign-in belongs to another Firebase project.",
    "owner_profile_missing": "Manish's profile link isn't set. See the fix at the top.",
    "firebase_config_missing": "The UAT sign-in settings weren't found. See the fix at the top.",
    "request_not_sent_here": (
        "Only requests sent from this page can be followed here. Real requests shows the rest."
    ),
    "packet_not_manish": "That isn't one of Manish's listed packets.",
    "packet_changed": "This packet changed. Check the new details.",
    "listing_changed": "This packet changed. Check the new details.",
    "packet_unavailable": "This packet isn't available right now.",
    "packet_not_ready": "This packet is still being checked.",
    "invalid_cursor": "That list page isn't valid. Reload the packets.",
    "uat_timeout": "UAT took too long. Send again. It won't be sent twice.",
    "uat_unreachable": "Couldn't reach UAT. Check the connection, then send again.",
    "uat_redirect_refused": "UAT answered with a redirect. Nothing was followed.",
    "uat_bad_response": "UAT sent an answer this page doesn't understand.",
    "verify_google_identity_required": (
        "Add a Google account to your test account once in the UAT app to receive files."
    ),
    "google_identity_required": (
        "Add a Google account to your test account once in the UAT app to receive files."
    ),
    "connection_required": "Your test account needs an active connection with Manish in UAT.",
    "request_unavailable": "Manish's profile isn't available to this account in UAT.",
    "request_changed": "This was already sent with different details. Start a new request.",
    "price_changed": "Manish changed the price. Check the new quote, then send again.",
    "date_range_required": "Choose a start and end date.",
    "sharing_unavailable": "File requests aren't available for this connection yet.",
    "connector_unavailable": "File requests aren't available for this connection yet.",
    "identity_verification_unavailable": "UAT couldn't check your Google account. Try again.",
    "invalid_argument": "UAT refused the request details.",
    "rate_limited": "UAT asked to slow down. Try again in a minute.",
    "auth_vault_owner_invalid": "UAT refused the app session. Sign in again.",
}

PROBLEMS = {
    "owner_profile_missing": (
        "Manish's profile link is not set.",
        "In the UAT app, open Manish's profile and copy its link (uat.one.hushh.ai/people/...). "
        f"Add `export {OWNER_PROFILE_VAR}=<that link>` to live-env.sh, then restart the dashboard.",
    ),
    "owner_profile_not_uat": (
        "The profile link is not a UAT link.",
        "Use the uat.one.hushh.ai/people/... link of Manish's profile.",
    ),
    "owner_profile_invalid": (
        "The profile link is not a profile link.",
        "Use the uat.one.hushh.ai/people/<id> link of Manish's profile.",
    ),
    "owner_profile_ambiguous": (
        "live-env.sh sets the profile link more than once.",
        "Keep one line.",
    ),
    "owner_profile_conflict": (
        "live-env.sh and the shell name different profile links.",
        "Keep one value.",
    ),
    "firebase_config_missing": (
        "The UAT sign-in settings were not found.",
        f"Add `export {WEB_ENV_FILE_VAR}=<path to hushh-webapp/.env.uat.local>` to live-env.sh. "
        "Only its public NEXT_PUBLIC_FIREBASE_* values are read.",
    ),
    "firebase_config_unreadable": (
        "The UAT env profile could not be read.",
        f"Check the path in {WEB_ENV_FILE_VAR}.",
    ),
    "firebase_config_not_uat": (
        "That env file is not the UAT profile.",
        "Point it at hushh-webapp/.env.uat.local (NEXT_PUBLIC_APP_ENV=uat).",
    ),
    "firebase_config_invalid": (
        "The UAT sign-in settings are incomplete.",
        "The file needs NEXT_PUBLIC_FIREBASE_API_KEY, _AUTH_DOMAIN, _PROJECT_ID and _APP_ID.",
    ),
    "firebase_config_ambiguous": (
        f"live-env.sh sets {WEB_ENV_FILE_VAR} more than once.",
        "Keep one line.",
    ),
    "firebase_config_conflict": (
        f"live-env.sh and the shell name different {WEB_ENV_FILE_VAR} files.",
        "Keep one value.",
    ),
}


class DeployedError(Exception):
    """A refusal or an upstream answer, as an HTTP status and a fixed code."""

    def __init__(self, status: int, code: str, *, upstream_request_id=None, ms=None):
        super().__init__(code)
        self.status = status
        self.code = code
        self.upstream_request_id = upstream_request_id
        self.ms = ms


class DeployedConfigError(RuntimeError):
    """The founder configuration does not give what this mode needs; a fixed code."""


def _unquote(value: str) -> str:
    text = value.strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "'\"":
        return text[1:-1].strip()
    return text


def _uuid(value: Any) -> str | None:
    if not isinstance(value, str) or not _UUID.fullmatch(value):
        return None
    return str(UUID(value))


def _exported(path: Path, name: str) -> list[str]:
    """Every ``export NAME=value`` line for one name in the founder's live-env.sh."""
    pattern = re.compile(r"^\s*export\s+" + re.escape(name) + r"=(?P<value>.*?)\s*$")
    try:
        lines = path.read_text().splitlines()
    except OSError:
        return []
    return [match.group("value") for match in map(pattern.match, lines) if match]


# --- The owner: Manish's public person reference, from the founder configuration ------------


def parse_owner_profile(value: str) -> str:
    """Manish's public person reference from his UAT profile link (/people/<ref>) or the ref.

    The app's profile page takes the reference from exactly this route segment.
    """
    text = _unquote(value)
    if _UUID.fullmatch(text):
        return str(UUID(text))
    try:
        url = urlsplit(text)
        port = url.port
    except ValueError:
        raise DeployedConfigError("owner_profile_invalid") from None
    if (
        url.scheme != "https"
        or (url.hostname or "") not in UAT_APP_HOSTS
        or port is not None
        or url.username
        or url.password
    ):
        raise DeployedConfigError("owner_profile_not_uat")
    parts = [part for part in url.path.split("/") if part]
    if len(parts) != 2 or parts[0] != "people" or not _UUID.fullmatch(parts[1]):
        raise DeployedConfigError("owner_profile_invalid")
    return str(UUID(parts[1]))


def resolve_owner_profile(
    *, live_env: Path = DEFAULT_LIVE_ENV, environ: Mapping[str, str] | None = None
) -> str:
    """Exactly one reference: live-env.sh and the shell must agree; no lookup of anyone."""
    environ = os.environ if environ is None else environ
    lines = _exported(live_env, OWNER_PROFILE_VAR)
    if len(lines) > 1:
        raise DeployedConfigError("owner_profile_ambiguous")
    found = {parse_owner_profile(value) for value in lines}
    exported = (environ.get(OWNER_PROFILE_VAR) or "").strip()
    if exported:
        found.add(parse_owner_profile(exported))
    if not found:
        raise DeployedConfigError("owner_profile_missing")
    if len(found) > 1:
        raise DeployedConfigError("owner_profile_conflict")
    return found.pop()


# --- Sign-in: the public UAT web config (NEXT_PUBLIC_FIREBASE_*), nothing else ---------------


@dataclass(frozen=True)
class FirebaseWebConfig:
    api_key: str = field(repr=False)
    auth_domain: str
    project_id: str
    app_id: str

    def public(self) -> dict:
        return {
            "apiKey": self.api_key,
            "authDomain": self.auth_domain,
            "projectId": self.project_id,
            "appId": self.app_id,
        }


_FIREBASE_KEYS = {
    "NEXT_PUBLIC_FIREBASE_API_KEY": ("api_key", re.compile(r"^AIza[0-9A-Za-z_-]{35}$")),
    "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN": (
        "auth_domain",
        re.compile(
            r"^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
            r"(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$"
        ),
    ),
    "NEXT_PUBLIC_FIREBASE_PROJECT_ID": (
        "project_id",
        re.compile(r"^[a-z][a-z0-9-]{4,28}[a-z0-9]$"),
    ),
    "NEXT_PUBLIC_FIREBASE_APP_ID": ("app_id", re.compile(r"^1:\d{4,20}:web:[0-9a-f]{6,40}$")),
}


def read_firebase_web_config(path: Path) -> FirebaseWebConfig:
    """The four public Firebase web keys from the UAT env profile.

    Only NEXT_PUBLIC_APP_ENV and these keys are kept; any other line (the profile also
    holds server secrets) is skipped without keeping its value.
    """
    wanted = {"NEXT_PUBLIC_APP_ENV", *_FIREBASE_KEYS}
    values: dict[str, str] = {}
    try:
        lines = path.read_text().splitlines()
    except OSError:
        raise DeployedConfigError("firebase_config_unreadable") from None
    for line in lines:
        match = _ENV_LINE.match(line)
        if match and match.group("name") in wanted:
            values[match.group("name")] = _unquote(match.group("value"))
    if values.get("NEXT_PUBLIC_APP_ENV") != "uat":
        raise DeployedConfigError("firebase_config_not_uat")
    fields: dict[str, str] = {}
    for key, (attribute, pattern) in _FIREBASE_KEYS.items():
        value = values.get(key, "")
        if not pattern.fullmatch(value):
            raise DeployedConfigError("firebase_config_invalid")
        fields[attribute] = value
    return FirebaseWebConfig(**fields)


def resolve_firebase_web_config(
    *,
    live_env: Path = DEFAULT_LIVE_ENV,
    environ: Mapping[str, str] | None = None,
    repo_env: Path = REPO_WEB_ENV,
) -> FirebaseWebConfig:
    """The UAT env profile named in live-env.sh or the shell, else this checkout's own."""
    environ = os.environ if environ is None else environ
    lines = _exported(live_env, WEB_ENV_FILE_VAR)
    if len(lines) > 1:
        raise DeployedConfigError("firebase_config_ambiguous")
    named = {_unquote(value) for value in lines}
    exported = (environ.get(WEB_ENV_FILE_VAR) or "").strip()
    if exported:
        named.add(_unquote(exported))
    if len(named) > 1:
        raise DeployedConfigError("firebase_config_conflict")
    path = Path(named.pop()).expanduser() if named else repo_env
    if not path.is_file():
        raise DeployedConfigError("firebase_config_missing")
    return read_firebase_web_config(path)


def signin_csp(auth_domain: str | None) -> str:
    """The sign-in window's own policy: this server plus Google sign-in, nothing else."""
    frame = f"https://{auth_domain}" if auth_domain else "'none'"
    return "; ".join(
        (
            "default-src 'none'",
            "script-src 'self' https://apis.google.com",
            "connect-src 'self' https://identitytoolkit.googleapis.com "
            "https://securetoken.googleapis.com",
            f"frame-src {frame}",
            "img-src 'self' data:",
            "style-src 'self' 'unsafe-inline'",
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'none'",
        )
    )


# --- The UAT client: a fixed host and a fixed whitelist ------------------------------------


def check_api_origin(origin: str, *, allow_loopback_stub: bool = False) -> str:
    """Only the UAT backend. A 127.0.0.1 stub is accepted for tests when asked explicitly."""
    if origin == UAT_API_ORIGIN:
        return origin
    if allow_loopback_stub:
        try:
            url = urlsplit(origin)
            port = url.port
        except ValueError:
            port = None
            url = None
        if (
            url is not None
            and url.scheme == "http"
            and url.hostname == "127.0.0.1"
            and port
            and url.path in ("", "/")
            and not url.query
            and not url.username
            and not url.password
        ):
            return origin.rstrip("/")
    raise DeployedConfigError("api_origin_refused")


@dataclass(frozen=True)
class Operation:
    name: str
    method: str
    path: re.Pattern[str]
    auth: str
    params: frozenset[str] = frozenset()
    timeout: float = 20.0


def operations(owner_ref: str) -> dict[str, Operation]:
    """The whole whitelist, bound to one owner reference."""
    owner = re.escape(str(UUID(owner_ref)))
    sharing = re.escape(SHARING)
    return {
        item.name: item
        for item in (
            Operation("session", "POST", re.compile(r"/api/consent/vault-owner-token"), "firebase"),
            Operation("owner", "GET", re.compile(rf"/api/public/people/{owner}"), "none"),
            Operation(
                "quote",
                "GET",
                re.compile(rf"{sharing}/quote"),
                "app",
                frozenset({"ownerPersonRef"}),
            ),
            Operation("recipient", "GET", re.compile(rf"{sharing}/recipient-identity"), "both"),
            Operation(
                "file_request", "POST", re.compile(rf"{sharing}/requests"), "both", timeout=45.0
            ),
            Operation("status", "GET", re.compile(rf"{sharing}/requests/{_ID}"), "app"),
            Operation(
                "packets",
                "GET",
                re.compile(rf"{sharing}/packets"),
                "app",
                frozenset({"ownerPersonRef", "cursor"}),
            ),
            Operation(
                "packet_request",
                "POST",
                re.compile(rf"{sharing}/packets/{_ID}/requests"),
                "both",
                timeout=45.0,
            ),
        )
    }


def allowed(method: str, path: str, owner_ref: str) -> str | None:
    """The whitelisted operation for exactly this method and path, else None."""
    for item in operations(owner_ref).values():
        if item.method == method and item.path.fullmatch(path):
            return item.name
    return None


@dataclass(frozen=True)
class Reply:
    status: int
    data: dict
    upstream_request_id: str
    ms: int


def _error_code(data: Any, status: int) -> str:
    detail = data.get("detail") if isinstance(data, dict) else None
    source = detail if isinstance(detail, dict) else data if isinstance(data, dict) else {}
    code = source.get("code") if isinstance(source, dict) else None
    if isinstance(code, str) and _CODE.fullmatch(code.lower()):
        return code.lower()
    fallback = {401: "sign_in_again", 404: "not_found", 409: "conflict", 429: "rate_limited"}
    return fallback.get(status, "uat_error" if status >= 500 else "request_failed")


class UatClient:
    """Calls the deployed UAT backend for the whitelist only; never follows a redirect."""

    def __init__(
        self,
        owner_ref: str,
        *,
        api_origin: str = UAT_API_ORIGIN,
        transport: httpx.AsyncBaseTransport | None = None,
        allow_loopback_stub: bool = False,
    ):
        self.owner_ref = str(UUID(owner_ref))
        self.api_origin = check_api_origin(api_origin, allow_loopback_stub=allow_loopback_stub)
        self.operations = operations(self.owner_ref)
        self._transport = transport

    @property
    def api_host(self) -> str:
        return urlsplit(self.api_origin).netloc

    def _headers(self, item: Operation, firebase_token: str | None, app_token: str | None):
        headers = {"x-request-id": str(uuid4())}
        if item.auth in ("firebase", "both"):
            if not firebase_token:
                raise DeployedError(401, "sign_in_required")
            headers["Authorization"] = f"Bearer {firebase_token}"
        if item.auth == "both":
            if not app_token:
                raise DeployedError(401, "session_required")
            headers["X-Hushh-Consent"] = app_token
        if item.auth == "app":
            if not app_token:
                raise DeployedError(401, "session_required")
            headers["Authorization"] = f"Bearer {app_token}"
        if item.method == "POST":
            headers["Content-Type"] = "application/json"
        return headers

    async def call(
        self,
        name: str,
        path: str,
        *,
        firebase_token: str | None = None,
        app_token: str | None = None,
        params: Mapping[str, str] | None = None,
        body: dict | None = None,
    ) -> Reply:
        item = self.operations.get(name)
        if item is None or allowed(item.method, path, self.owner_ref) != name:
            raise DeployedError(404, "not_allowed")
        query = dict(params or {})
        if set(query) - item.params:
            raise DeployedError(404, "not_allowed")
        if "ownerPersonRef" in item.params and query.get("ownerPersonRef") != self.owner_ref:
            raise DeployedError(404, "not_allowed")
        headers = self._headers(item, firebase_token, app_token)
        content = json.dumps(body or {}, separators=(",", ":")) if item.method == "POST" else None
        upstream_id = headers["x-request-id"]
        started = time.monotonic()
        try:
            async with httpx.AsyncClient(
                base_url=self.api_origin,
                transport=self._transport,
                follow_redirects=False,
                trust_env=False,
                headers={"Accept": "application/json", "User-Agent": USER_AGENT},
            ) as client:
                async with client.stream(
                    item.method,
                    path,
                    params=query or None,
                    headers=headers,
                    content=content,
                    timeout=item.timeout,
                ) as response:
                    raw = bytearray()
                    async for chunk in response.aiter_bytes():
                        raw.extend(chunk)
                        if len(raw) > MAX_BODY:
                            break
                    status = response.status_code
        except httpx.TimeoutException:
            raise DeployedError(504, "uat_timeout", upstream_request_id=upstream_id) from None
        except httpx.HTTPError:
            raise DeployedError(502, "uat_unreachable", upstream_request_id=upstream_id) from None
        ms = int((time.monotonic() - started) * 1000)
        context = {"upstream_request_id": upstream_id, "ms": ms}
        if 300 <= status < 400:
            raise DeployedError(502, "uat_redirect_refused", **context)
        if len(raw) > MAX_BODY:
            raise DeployedError(502, "uat_bad_response", **context)
        try:
            data = json.loads(bytes(raw)) if raw else {}
        except ValueError:
            data = None
        if status >= 400:
            raise DeployedError(status, _error_code(data, status), **context)
        if not isinstance(data, dict):
            raise DeployedError(502, "uat_bad_response", **context)
        return Reply(status, data, upstream_id, ms)


# --- The private call log ----------------------------------------------------------------


class CallLog:
    """Append-only JSONL under the private dashboard directory (0700 directory, 0600 file).

    Each line holds the operation, HTTP status, time and request ids, never a token,
    header or body.
    """

    def __init__(self, state_dir: Path | None):
        self.path = Path(state_dir) / CALL_LOG if state_dir else None
        self._lock = threading.Lock()

    def record(
        self,
        *,
        op: str,
        status: int,
        ms: int | None,
        upstream_request_id: str | None,
        request_id: str | None = None,
        code: str | None = None,
    ) -> None:
        if self.path is None:
            return
        entry = {
            "at": datetime.now(UTC).isoformat(timespec="seconds"),
            "op": op if op in _OPERATION_NAMES else "unknown",
            "status": int(status),
            "ms": int(ms) if isinstance(ms, int) else None,
            "upstream_request_id": _uuid(upstream_request_id),
            "request_id": _uuid(request_id),
            "code": code if isinstance(code, str) and _CODE.fullmatch(code) else None,
        }
        line = json.dumps(entry, sort_keys=True) + "\n"
        try:
            with self._lock:
                self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                descriptor = os.open(self.path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
                with os.fdopen(descriptor, "a", encoding="utf-8") as handle:
                    handle.write(line)
                os.chmod(self.path, 0o600)
        except OSError:
            logger.warning("deployed call log unavailable")

    def sent_requests(self) -> set[str]:
        """Requests this dashboard sent before (followable after a restart)."""
        if self.path is None:
            return set()
        try:
            lines = self.path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return set()
        found = set()
        for line in lines:
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            if (
                isinstance(entry, dict)
                and entry.get("op") in ("file_request", "packet_request")
                and isinstance(entry.get("status"), int)
                and 200 <= entry["status"] < 300
                and _uuid(entry.get("request_id"))
            ):
                found.add(_uuid(entry["request_id"]))
        return found


_OPERATION_NAMES = frozenset(operations("00000000-0000-4000-8000-000000000000"))


# --- Tokens from the page ----------------------------------------------------------------


def page_tokens(request: Request) -> tuple[str | None, str | None]:
    """(Firebase ID token, UAT app session) from this page's headers, shape-checked."""
    authorization = request.headers.get("authorization", "")
    firebase_token = authorization[7:].strip() if authorization.startswith("Bearer ") else ""
    app_token = request.headers.get("x-hushh-consent", "").strip()
    return (
        firebase_token if _JWT.fullmatch(firebase_token) else None,
        app_token if _APP_TOKEN.fullmatch(app_token) else None,
    )


def firebase_subject(token: str, project_id: str) -> str:
    """The uid of a Firebase ID token, read without verifying it: UAT verifies it.

    Refuses a token for another Firebase project or one that has expired, so nothing
    is sent for it.
    """
    try:
        segment = token.split(".")[1]
        payload = json.loads(base64.urlsafe_b64decode(segment + "=" * (-len(segment) % 4)))
    except (IndexError, ValueError, binascii.Error):
        raise DeployedError(401, "sign_in_again") from None
    if not isinstance(payload, dict):
        raise DeployedError(401, "sign_in_again")
    if (
        payload.get("aud") != project_id
        or payload.get("iss") != f"https://securetoken.google.com/{project_id}"
    ):
        raise DeployedError(401, "wrong_firebase_project")
    expires = payload.get("exp")
    if not isinstance(expires, int | float) or expires <= time.time():
        raise DeployedError(401, "sign_in_again")
    subject = payload.get("sub")
    if not isinstance(subject, str) or not _UID.fullmatch(subject):
        raise DeployedError(401, "sign_in_again")
    return subject


# --- Request bodies from the page ----------------------------------------------------------


class FileRequestBody(BaseModel):
    """The profile's Request files form. ``confirm`` is set only by the confirm dialog."""

    model_config = ConfigDict(extra="forbid")
    purpose: str = Field(min_length=1, max_length=2000)
    periodStart: str = Field(pattern=_DAY)
    periodEnd: str = Field(pattern=_DAY)
    clientRequestId: UUID
    expectedQuoteVersion: int = Field(ge=0, strict=True)
    timeZone: str | None = Field(default=None, min_length=1, max_length=64)
    confirm: StrictBool | None = None

    @model_validator(mode="after")
    def _valid(self):
        if not self.purpose.strip():
            raise ValueError("purpose")
        start, end = date.fromisoformat(self.periodStart), date.fromisoformat(self.periodEnd)
        if end < start:
            raise ValueError("period")
        if self.timeZone is not None:
            if not re.fullmatch(r"[A-Za-z0-9_+\-/]{1,64}", self.timeZone):
                raise ValueError("timeZone")
            try:
                ZoneInfo(self.timeZone)
            except (ZoneInfoNotFoundError, ValueError):
                raise ValueError("timeZone") from None
        return self


class PacketRequestBody(BaseModel):
    """One listed packet version; ``confirm`` is set only by the confirm dialog."""

    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=1, strict=True)
    clientRequestId: UUID
    confirm: StrictBool | None = None


# --- Shaping UAT answers for the page ------------------------------------------------------


def _cents(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def money(cents: int | None) -> str | None:
    return None if cents is None else f"${cents / 100:,.2f}"


def shape_quote(data: dict, owner_name: str = OWNER_NAME) -> dict:
    flags = ("paymentRequired", "priceReady", "payoutReady", "paymentsReady")
    version = data.get("version")
    if not isinstance(version, int) or isinstance(version, bool) or version < 0:
        raise DeployedError(502, "uat_bad_response")
    if any(not isinstance(data.get(name), bool) for name in flags):
        raise DeployedError(502, "uat_bad_response")
    amount = _cents(data.get("amountCents"))
    if not data["paymentRequired"]:
        line = "No payment needed."
    elif data["priceReady"] and amount is not None:
        line = f"About {money(amount)}. You pay only if files are found."
    else:
        line = f"{owner_name} sets the price. You see it before you pay."
    note = None
    if data["paymentRequired"] and not data["payoutReady"]:
        note = "We'll ask the owner to set up payouts."
    elif data["paymentRequired"] and not data["paymentsReady"]:
        note = "Payments are unavailable. You can still send your request."
    return {
        "version": version,
        "amountCents": amount,
        "paymentRequired": data["paymentRequired"],
        "priceReady": data["priceReady"],
        "line": line,
        "note": note,
    }


_PAYMENT_LINES = {
    "awaiting_owner": "You pay only after {owner} approves.",
    "preparing": "Getting the payment ready.",
    "payable": "Pay in the UAT app to get the files. Nothing is charged here.",
    "link_expired": "The payment link expired. Open the UAT app for a new one.",
    "request_expired": "The request expired before payment.",
    "paid": "Paid.",
    "refund_pending": "A refund is on its way.",
    "refunded": "Refunded.",
    "partially_refunded": "Partly refunded.",
}

_STATUS_WORDS = {
    "pending": (
        "Waiting for {owner}",
        "{owner} has the request. Nothing happens until he answers.",
    ),
    "approved": ("{owner} approved", "The files are being shared."),
    "partial": ("Some files shared", "{owner} shared part of what you asked for."),
    "completed": ("Files shared", "Open the UAT app to see the files."),
    "declined": ("{owner} declined", "Nothing was shared or charged."),
    "cancelled": ("Cancelled", "Nothing was shared."),
    "expired": ("Expired", "{owner} didn't answer in time."),
    "no_files_shared": ("No files shared", "{owner} didn't find matching files."),
}


def shape_status(data: dict, owner_name: str = OWNER_NAME) -> dict:
    """The requester's own view in plain words; the page polls it every 5 seconds."""
    status = data.get("status")
    status = status if isinstance(status, str) and _CODE.fullmatch(status) else "unknown"
    word, detail = _STATUS_WORDS.get(status, (f"Status: {status}", ""))
    payment = data.get("payment") if isinstance(data.get("payment"), dict) else {}
    price = data.get("price") if isinstance(data.get("price"), dict) else {}
    pay_state = payment.get("state") if isinstance(payment.get("state"), str) else None
    pay_in_app = pay_state == "payable" or payment.get("nextAction") == "pay"
    if pay_in_app:
        word = "{owner} approved. Pay in the UAT app"
    amount = next(
        (
            _cents(value)
            for value in (
                price.get("finalCents"),
                price.get("currentCents"),
                price.get("estimateCents"),
                data.get("quotedAmountCents"),
            )
            if _cents(value) is not None
        ),
        None,
    )
    revision = data.get("revision")
    return {
        "requestId": _uuid(data.get("requestId")),
        "status": status,
        "revision": revision if isinstance(revision, int) else None,
        "word": word.format(owner=owner_name),
        "detail": detail.format(owner=owner_name),
        "payment": _PAYMENT_LINES.get(pay_state or "", "").format(owner=owner_name) or None,
        "payInApp": bool(pay_in_app),
        "price": money(amount),
        "terminal": status in TERMINAL,
    }


_CHECKING_TITLE = "Packet being checked"
_CHECKING_SUMMARIES = frozenset({"Coverage is being checked.", "Evidence is being prepared."})
_PARTIAL_DRIVE = "this is not a complete inventory of matching records."


def _documents(count: int) -> str:
    return f"{count:,} {'document' if count == 1 else 'documents'}"


def shape_packet(item: Any) -> dict:
    """A buyer row: never the packet's files (a buyer view carries none anyway)."""
    if not isinstance(item, dict):
        raise DeployedError(502, "uat_bad_response")
    packet_id = _uuid(item.get("packetId"))
    version, revision = item.get("version"), item.get("listingRevision")
    count, can_request = item.get("documentCount"), item.get("canRequest")
    title = item.get("title")
    summary = item.get("coverageSummary")
    description = item.get("description") if isinstance(item.get("description"), str) else ""
    if (
        packet_id is None
        or not isinstance(version, int)
        or version < 1
        or not isinstance(revision, int)
        or revision < 0
        or not isinstance(count, int)
        or count < 0
        or not isinstance(can_request, bool)
        or not isinstance(title, str)
        or not title.strip()
        or len(title) > 250
    ):
        raise DeployedError(502, "uat_bad_response")
    checking = title == _CHECKING_TITLE or summary in _CHECKING_SUMMARIES
    summary = None if checking or not isinstance(summary, str) else summary[:2000]
    price = _cents(item.get("priceCents"))
    return {
        "packetId": packet_id,
        "version": version,
        "listingRevision": revision,
        "title": title,
        "summary": summary,
        "documents": _documents(count),
        "priceCents": price if can_request else None,
        "price": money(price) if can_request else None,
        "canRequest": can_request,
        "line": " · ".join(part for part in (_documents(count), summary) if part)
        if can_request
        else "Not available right now",
        "notes": ["It may not include every matching file."]
        if _PARTIAL_DRIVE in description
        else [],
    }


def shape_packets(data: dict) -> dict:
    items = data.get("packets")
    cursor = data.get("nextCursor")
    if not isinstance(items, list) or len(items) > 50:
        raise DeployedError(502, "uat_bad_response")
    if cursor is not None and (not isinstance(cursor, str) or not _CURSOR.fullmatch(cursor)):
        raise DeployedError(502, "uat_bad_response")
    rows = [shape_packet(item) for item in items]
    rows.sort(key=lambda row: not row["canRequest"])
    return {"packets": rows, "nextCursor": cursor}


# --- The router ----------------------------------------------------------------------------


def _json(payload: dict, status: int = 200) -> JSONResponse:
    return JSONResponse(payload, status_code=status, headers={"Cache-Control": "no-store"})


def _refusal(error: DeployedError) -> JSONResponse:
    message = MESSAGES.get(error.code, "UAT didn't accept that. Try again.")
    return _json({"error": error.code, "message": message}, status=error.status)


def _answers(handler):
    """Turn a DeployedError into the page's {"error", "message"} answer."""

    @functools.wraps(handler)
    async def wrapper(*args, **kwargs):
        try:
            return await handler(*args, **kwargs)
        except DeployedError as error:
            return _refusal(error)

    return wrapper


def create_deployed_router(
    *,
    owner_user_id: str | None = None,
    state_dir: Path | None = DEFAULT_STATE_DIR,
    live_env: Path = DEFAULT_LIVE_ENV,
    environ: Mapping[str, str] | None = None,
    repo_env: Path = REPO_WEB_ENV,
    owner_ref: str | None = None,
    firebase: FirebaseWebConfig | None = None,
    client: UatClient | None = None,
    signin_html: Path = SIGNIN_HTML,
) -> APIRouter:
    """The /api/deployed routes. A missing setting is reported on the page, never guessed.

    ``owner_user_id`` (the dashboard's owner id) refuses a sign-in as Manish himself.
    """
    problems: list[str] = []
    if client is None:
        if owner_ref is None:
            try:
                owner_ref = resolve_owner_profile(live_env=live_env, environ=environ)
            except DeployedConfigError as error:
                problems.append(str(error))
        client = UatClient(owner_ref) if owner_ref else None
    if firebase is None:
        try:
            firebase = resolve_firebase_web_config(
                live_env=live_env, environ=environ, repo_env=repo_env
            )
        except DeployedConfigError as error:
            problems.append(str(error))
    calls = CallLog(state_dir)
    sent: set[str] = calls.sent_requests()
    router = APIRouter(prefix="/api/deployed")

    def need_client() -> UatClient:
        if client is None:
            raise DeployedError(503, "owner_profile_missing")
        return client

    async def run(name: str, path: str, *, pick_id=None, request_id=None, **kwargs) -> Reply:
        uat = need_client()
        try:
            reply = await uat.call(name, path, **kwargs)
        except DeployedError as error:
            calls.record(
                op=name,
                status=error.status,
                ms=error.ms,
                upstream_request_id=error.upstream_request_id,
                request_id=request_id,
                code=error.code,
            )
            logger.info("deployed %s refused or failed: %s %s", name, error.status, error.code)
            raise
        found = pick_id(reply.data) if pick_id else request_id
        calls.record(
            op=name,
            status=reply.status,
            ms=reply.ms,
            upstream_request_id=reply.upstream_request_id,
            request_id=found,
        )
        logger.info("deployed %s: %s in %s ms", name, reply.status, reply.ms)
        return reply

    def request_id_of(data: dict) -> str | None:
        return _uuid(data.get("requestId"))

    @router.get("/config")
    async def config():
        return _json(
            {
                "api_host": client.api_host if client else "api.uat.hushh.ai",
                "app_origin": UAT_APP_ORIGIN,
                "owner": {"name": OWNER_NAME, "ready": client is not None},
                "firebase": firebase.public() if firebase else None,
                "problems": [
                    {
                        "code": code,
                        "message": PROBLEMS.get(code, (code, ""))[0],
                        "fix": PROBLEMS.get(code, (code, ""))[1],
                    }
                    for code in problems
                ],
            }
        )

    @router.get("/signin")
    async def signin():
        return FileResponse(
            signin_html,
            media_type="text/html; charset=utf-8",
            headers={
                "Content-Security-Policy": signin_csp(firebase.auth_domain if firebase else None),
                "Referrer-Policy": "strict-origin-when-cross-origin",
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
            },
        )

    @router.post("/session")
    @_answers
    async def session(request: Request):
        firebase_token, _ = page_tokens(request)
        if firebase is None:
            raise DeployedError(503, "firebase_config_missing")
        if not firebase_token:
            raise DeployedError(401, "sign_in_required")
        uid = firebase_subject(firebase_token, firebase.project_id)
        if owner_user_id and uid == owner_user_id:
            raise DeployedError(403, "owner_account")
        reply = await run(
            "session",
            "/api/consent/vault-owner-token",
            firebase_token=firebase_token,
            body={"userId": uid},
        )
        token, expires = reply.data.get("token"), reply.data.get("expiresAt")
        if not isinstance(token, str) or not _APP_TOKEN.fullmatch(token):
            raise DeployedError(502, "uat_bad_response")
        if not isinstance(expires, int) or isinstance(expires, bool):
            raise DeployedError(502, "uat_bad_response")
        return _json({"appToken": token, "expiresAt": expires})

    @router.get("/owner")
    @_answers
    async def owner():
        uat = need_client()
        reply = await run("owner", f"/api/public/people/{uat.owner_ref}")
        name = reply.data.get("displayName")
        shown = name.strip() if isinstance(name, str) and 0 < len(name.strip()) <= 120 else None
        return _json({"name": OWNER_NAME, "uat_display_name": shown})

    @router.get("/quote")
    @_answers
    async def quote(request: Request):
        _, app_token = page_tokens(request)
        uat = need_client()
        reply = await run(
            "quote",
            f"{SHARING}/quote",
            app_token=app_token,
            params={"ownerPersonRef": uat.owner_ref},
        )
        return _json(shape_quote(reply.data))

    @router.get("/recipient")
    @_answers
    async def recipient(request: Request):
        firebase_token, app_token = page_tokens(request)
        reply = await run(
            "recipient",
            f"{SHARING}/recipient-identity",
            firebase_token=firebase_token,
            app_token=app_token,
        )
        email = reply.data.get("email")
        if not isinstance(email, str) or len(email) > 254 or not _EMAIL.fullmatch(email):
            raise DeployedError(502, "uat_bad_response")
        return _json({"email": email})

    @router.post("/file-requests")
    @_answers
    async def file_request(request: Request, body: FileRequestBody):
        if body.confirm is not True:
            raise DeployedError(428, "confirm_required")
        firebase_token, app_token = page_tokens(request)
        uat = need_client()
        upstream = {
            "ownerPersonRef": uat.owner_ref,
            "clientRequestId": str(body.clientRequestId),
            "expectedQuoteVersion": body.expectedQuoteVersion,
            "purpose": {
                "purpose": body.purpose.strip(),
                "periodStart": body.periodStart,
                "periodEnd": body.periodEnd,
            },
        }
        if body.timeZone:
            upstream["timeZone"] = body.timeZone
        reply = await run(
            "file_request",
            f"{SHARING}/requests",
            firebase_token=firebase_token,
            app_token=app_token,
            body=upstream,
            pick_id=request_id_of,
        )
        request_id = request_id_of(reply.data)
        if request_id is None:
            raise DeployedError(502, "uat_bad_response")
        sent.add(request_id)
        status = reply.data.get("status")
        return _json(
            {"requestId": request_id, "status": status if isinstance(status, str) else None},
            status=202,
        )

    @router.get("/requests/{request_id}")
    @_answers
    async def request_status(request: Request, request_id: str):
        known = _uuid(request_id)
        if known is None or known not in sent:
            raise DeployedError(404, "request_not_sent_here")
        _, app_token = page_tokens(request)
        reply = await run(
            "status", f"{SHARING}/requests/{known}", app_token=app_token, request_id=known
        )
        if reply.data.get("direction") != "outgoing" or request_id_of(reply.data) != known:
            raise DeployedError(404, "request_not_sent_here")
        return _json(shape_status(reply.data))

    async def packet_page(app_token: str | None, cursor: str | None) -> dict:
        uat = need_client()
        params = {"ownerPersonRef": uat.owner_ref}
        if cursor:
            params["cursor"] = cursor
        reply = await run("packets", f"{SHARING}/packets", app_token=app_token, params=params)
        return shape_packets(reply.data)

    @router.get("/packets")
    @_answers
    async def packets(request: Request, cursor: str | None = None):
        if cursor is not None and not _CURSOR.fullmatch(cursor):
            raise DeployedError(422, "invalid_cursor")
        _, app_token = page_tokens(request)
        return _json(await packet_page(app_token, cursor))

    @router.post("/packets/{packet_id}/requests")
    @_answers
    async def packet_request(request: Request, packet_id: str, body: PacketRequestBody):
        if body.confirm is not True:
            raise DeployedError(428, "confirm_required")
        wanted = _uuid(packet_id)
        if wanted is None:
            raise DeployedError(404, "packet_not_manish")
        firebase_token, app_token = page_tokens(request)
        listed, cursor = None, None
        for _page in range(PACKET_PAGES):  # Manish's own buyer list, before anything is sent
            page = await packet_page(app_token, cursor)
            listed = next((row for row in page["packets"] if row["packetId"] == wanted), None)
            cursor = page["nextCursor"]
            if listed is not None or not cursor:
                break
        if listed is None:
            raise DeployedError(404, "packet_not_manish")
        if listed["version"] != body.version:
            raise DeployedError(409, "packet_changed")
        if not listed["canRequest"]:
            raise DeployedError(409, "packet_unavailable")
        reply = await run(
            "packet_request",
            f"{SHARING}/packets/{wanted}/requests",
            firebase_token=firebase_token,
            app_token=app_token,
            body={"version": body.version, "clientRequestId": str(body.clientRequestId)},
            pick_id=request_id_of,
        )
        request_id = request_id_of(reply.data)
        existing = reply.data.get("existingAccess")
        if request_id is None or not isinstance(existing, bool):
            raise DeployedError(502, "uat_bad_response")
        sent.add(request_id)
        return _json({"requestId": request_id, "existingAccess": existing}, status=202)

    @router.api_route(
        "/{rest:path}",
        methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        include_in_schema=False,
    )
    async def refused(rest: str):
        return _refusal(DeployedError(404, "not_allowed"))

    return router
