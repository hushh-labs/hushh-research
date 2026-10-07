"""Shared harness for the in-agent connector tests: an owner-cloud agent and a fake Google.

Not a test module. It builds the smallest real agent the connectors need: pod mode,
the owner's own KMS key location (so ``owner_cloud_agent()`` is true), a real
``PodCommitLog`` on a temp directory, a trusted binding naming the owner, and connector
logins in the active credential copy. Google is an ``httpx.MockTransport`` installed
under every ``httpx.AsyncClient``, so a call to any other host fails the test loudly.
"""

from __future__ import annotations

# ruff: noqa: S106 -- token-shaped strings below name test fixtures, not credentials.
import json
from dataclasses import dataclass, field
from typing import Any, Callable
from urllib.parse import parse_qs

import httpx

from hushh_mcp.services import pod_connector_credentials as store
from hushh_mcp.services import pod_connector_tokens, pod_memory_service
from hushh_mcp.services.pod_authority_store import set_active_authority_store
from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog

OWNER_HUSHH = "ha1_l6owner"
OWNER_UID = "uid-l6-owner"
SUBJECT = "google-sub-1"
EMAIL = "owner@example.com"
G = "https://www.googleapis.com/auth/"
SCOPES = {
    "gmail": (G + "gmail.readonly",),
    "gmail_manage": (G + "gmail.modify",),
    "calendar": (G + "calendar.events", G + "calendar.freebusy"),
    "drive": (G + "drive",),
    "contacts": (G + "contacts.readonly",),
}


@dataclass
class _Trust:
    binding: dict[str, Any]


@dataclass
class AuthorityStub:
    owners: list[str] = field(default_factory=lambda: [OWNER_UID])

    def trusted_subjects(self) -> list[_Trust]:
        return [_Trust({"user_id": uid, "hushh_id": OWNER_HUSHH}) for uid in self.owners]


class FakeTokens:
    """``PodGoogleTokenSource``'s contract: one token per (service, level), every ask recorded."""

    def __init__(self) -> None:
        self.asks: list[tuple[str, str]] = []
        self.forgotten: list[str] = []
        self.refuse: dict[str, str] = {}

    async def access_token(self, service: str, level: str = "read") -> str:
        self.asks.append((service, level))
        if service in self.refuse:
            raise pod_connector_tokens.ConnectorTokenError(self.refuse[service])
        return f"ya29.{service}.{level}"

    def forget(self, connector_id: str) -> None:
        self.forgotten.append(connector_id)


def credential(
    connector: str,
    scopes: tuple[str, ...],
    *,
    credential_id: str = "11111111-2222-4333-8444-555555555555",
    generation: int = 1,
    status: str = store.STATUS_CONNECTED,
    mcp: dict | None = None,
) -> store.ConnectorCredential:
    return store.ConnectorCredential(
        credential_id=credential_id,
        connector_id=connector,
        provider="mcp" if connector.startswith("mcp_") else "google",
        account_subject=SUBJECT,
        granted_scopes=("openid", "email", *scopes),
        client_profile="hussh_native",
        client_id="123456789012-abcdefghijklmnop.apps.googleusercontent.com",
        generation=generation,
        status=status,
        connected_at_ms=1,
        issued_at_ms=1,
        refresh_token="1//refresh-never-logged",
        mcp=mcp,
    )


class FakeGoogle:
    """Answers by (method, host+path); records every request. Unknown routes are 599."""

    def __init__(self) -> None:
        self.routes: dict[tuple[str, str], Callable[[httpx.Request], httpx.Response]] = {}
        self.requests: list[httpx.Request] = []

    def on(self, method: str, url: str, answer: Any, status: int = 200) -> None:
        def reply(_request: httpx.Request) -> httpx.Response:
            payload = answer(_request) if callable(answer) else answer
            # A raw stream, so both buffered and streamed readers (the Gmail reader
            # streams under a byte budget) see the body exactly once.
            return httpx.Response(
                status,
                headers={"content-type": "application/json"},
                stream=httpx.ByteStream(json.dumps(payload).encode()),
            )

        self.routes[(method, url)] = reply

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        key = (request.method, f"{request.url.scheme}://{request.url.host}{request.url.path}")
        handler = self.routes.get(key)
        if handler is None:
            return httpx.Response(599, json={"error": f"unrouted {key}"})
        return handler(request)

    def calls(self, method: str, url: str) -> list[httpx.Request]:
        return [
            r
            for r in self.requests
            if r.method == method and f"{r.url.scheme}://{r.url.host}{r.url.path}" == url
        ]


def query(request: httpx.Request) -> dict[str, list[str]]:
    return parse_qs(request.url.query.decode())


def body(request: httpx.Request) -> Any:
    return json.loads(request.content or b"null")


def install(monkeypatch, tmp_path, *, connectors: dict[str, store.ConnectorCredential]):
    """An owner-cloud agent holding ``connectors``; returns (log, tokens, google)."""
    import hushh_mcp.config as config

    monkeypatch.setenv("HUSSH_POD_MODE", "1")
    monkeypatch.setenv("HUSSH_ID", OWNER_HUSHH)
    monkeypatch.setenv("HUSSH_POD_KMS_KEY", "projects/p/locations/l/keyRings/r/cryptoKeys/k")
    monkeypatch.delenv("HUSSH_POD_KEY_VAULT_KEY", raising=False)
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "owner-project")
    monkeypatch.setattr(config, "APP_SIGNING_KEY", "l6-test-signing-key-" + "x" * 32)
    log = PodCommitLog(LocalObjectStore(str(tmp_path / "log")), b"\x11" * 32, owner_id=OWNER_HUSHH)
    monkeypatch.setattr(pod_memory_service, "_resolve_log", lambda: log)
    tokens = FakeTokens()
    monkeypatch.setattr(pod_connector_tokens, "_SOURCE", tokens)
    set_active_authority_store(AuthorityStub())  # type: ignore[arg-type]
    store.set_active_connector_credentials(connectors)
    google = FakeGoogle()
    real = httpx.AsyncClient

    def client(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = httpx.MockTransport(google)
        return real(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", client)
    return log, tokens, google


def uninstall() -> None:
    store.set_active_connector_credentials({})
    set_active_authority_store(None)


def tool_context(owner: str = OWNER_UID, **extra: Any) -> Any:
    """An ADK tool context as the agent's own chat route builds its state."""
    from types import SimpleNamespace

    from hushh_mcp.one_adk.request_secrets import store_request_secret
    from hushh_mcp.services.pod_session_authority import LOCAL_TOKEN_PREFIX

    state = {
        "temp:one_execution_surface": "typed_chat",
        "hussh:user_id": owner,
        "hussh:consent_token": store_request_secret(LOCAL_TOKEN_PREFIX + "sid", ttl_seconds=60),
        "hussh:conversation_id": "conv-l6",
        "hussh:timezone": "UTC",
        **extra,
    }
    return SimpleNamespace(state=state, user_id=owner)


GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me"
CALENDAR = "https://www.googleapis.com/calendar/v3"


def gmail_message(message_id: str, subject: str = "Hello", sender: str = "Ravi <r@x.com>") -> dict:
    return {
        "id": message_id,
        "threadId": "t-" + message_id,
        "internalDate": "1759700000000",
        "labelIds": ["INBOX", "UNREAD"],
        "snippet": "a snippet",
        "payload": {
            "headers": [
                {"name": "From", "value": sender},
                {"name": "Subject", "value": subject},
                {"name": "Date", "value": "Mon, 6 Oct 2025 10:00:00 +0000"},
            ]
        },
    }


def route_inbox(google: FakeGoogle, ids: tuple[str, ...] = ("m1", "m2")) -> None:
    google.on("GET", f"{GMAIL}/profile", {"emailAddress": EMAIL, "historyId": "100"})

    def listing(request: httpx.Request) -> dict:
        size = int(query(request).get("maxResults", ["100"])[0])
        return {
            "messages": [{"id": i, "threadId": "t-" + i} for i in ids][:size],
            "resultSizeEstimate": len(ids),
        }

    google.on("GET", f"{GMAIL}/messages", listing)
    for message_id in ids:
        google.on("GET", f"{GMAIL}/messages/{message_id}", gmail_message(message_id))
        google.on(
            "GET",
            f"{GMAIL}/threads/t-{message_id}",
            {"id": "t-" + message_id, "messages": [gmail_message(message_id)]},
        )
