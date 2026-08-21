"""Bridge to the owner's local Hussh One Hermes machine.

Hermes is the owner's own computer, linked to their account as a trusted
device. It already runs an authenticated HTTP API on loopback (the gateway API
server), so this service is a thin, bounded client for it — status, scheduled
jobs, and one natural-language turn.

SECURITY POSTURE (mirrors hushh-webapp/lib/hermes/config.ts; keep them in step):

* Off unless explicitly enabled. There is no route from a hosted backend to a
  person's laptop, so an enabled bridge in a deployed environment could only
  point somewhere it should not. ``HERMES_LOCAL_BRIDGE_ENABLED`` gates it.
* Loopback only. A non-loopback base URL would turn an authenticated agent tool
  into a server-side request forgery primitive.
* The Hermes credential is read from the environment and never returned to a
  caller, echoed into a tool result, or logged.
* The relayed prompt is bounded, and Hermes's in-band agent failures are
  surfaced as failures rather than passed off as answers.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

import httpx

DEFAULT_BASE_URL = "http://127.0.0.1:8642"
_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}

STATUS_TIMEOUT_SECONDS = 5.0
JOBS_TIMEOUT_SECONDS = 8.0
#: A relayed turn runs a real agent on the machine; it is slow by nature.
RELAY_TIMEOUT_SECONDS = 120.0

MAX_PROMPT_CHARS = 4_000


class HermesBridgeError(RuntimeError):
    """A bridge failure the caller should surface as a named boundary."""

    def __init__(self, message: str, *, status: str) -> None:
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class HermesBridgeConfig:
    enabled: bool
    base_url: str
    api_key: str
    disabled_reason: str | None


def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def is_loopback_base_url(candidate: str) -> bool:
    try:
        parsed = urlparse(candidate)
    except ValueError:
        return False
    if parsed.scheme not in {"http", "https"}:
        return False
    host = (parsed.hostname or "").strip()
    return host in _LOOPBACK_HOSTS


def resolve_hermes_bridge_config(
    env: dict[str, str] | None = None,
) -> HermesBridgeConfig:
    source = env if env is not None else os.environ
    base_url = (source.get("HERMES_LOCAL_BASE_URL") or DEFAULT_BASE_URL).strip()
    api_key = (source.get("HERMES_LOCAL_API_KEY") or "").strip()

    if not _truthy(source.get("HERMES_LOCAL_BRIDGE_ENABLED")):
        return HermesBridgeConfig(
            enabled=False,
            base_url=base_url,
            api_key="",
            disabled_reason=(
                "The Hermes bridge is off. Set HERMES_LOCAL_BRIDGE_ENABLED=true "
                "for local development."
            ),
        )
    if not is_loopback_base_url(base_url):
        return HermesBridgeConfig(
            enabled=False,
            base_url=base_url,
            api_key="",
            disabled_reason=(
                "HERMES_LOCAL_BASE_URL must point at a loopback address; the "
                "Hermes bridge only reaches this machine."
            ),
        )
    if not api_key:
        return HermesBridgeConfig(
            enabled=False,
            base_url=base_url,
            api_key="",
            disabled_reason=(
                "HERMES_LOCAL_API_KEY is not set. Copy API_SERVER_KEY from the Hermes profile env."
            ),
        )
    return HermesBridgeConfig(
        enabled=True, base_url=base_url, api_key=api_key, disabled_reason=None
    )


def _require_enabled() -> HermesBridgeConfig:
    config = resolve_hermes_bridge_config()
    if not config.enabled:
        raise HermesBridgeError(
            config.disabled_reason or "The Hermes bridge is unavailable.",
            status="hermes_bridge_disabled",
        )
    return config


async def _request(
    config: HermesBridgeConfig,
    method: str,
    path: str,
    *,
    timeout: float,
    json_body: dict[str, Any] | None = None,
    extra_headers: dict[str, str] | None = None,
) -> httpx.Response:
    headers = {
        "Authorization": f"Bearer {config.api_key}",
        "Accept": "application/json",
    }
    if extra_headers:
        headers.update(extra_headers)
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.request(
                method, f"{config.base_url}{path}", headers=headers, json=json_body
            )
    except httpx.TimeoutException as exc:
        raise HermesBridgeError("Hermes did not respond in time.", status="hermes_offline") from exc
    except httpx.HTTPError as exc:
        raise HermesBridgeError(
            "Hermes is not reachable on this machine.", status="hermes_offline"
        ) from exc

    if response.status_code in {401, 403}:
        raise HermesBridgeError(
            "Hermes rejected the bridge credential.", status="hermes_unauthorized"
        )
    return response


async def get_status() -> dict[str, Any]:
    """Liveness and readiness as the machine reports them."""
    config = _require_enabled()
    response = await _request(config, "GET", "/health/detailed", timeout=STATUS_TIMEOUT_SECONDS)
    if response.status_code >= 400:
        raise HermesBridgeError(f"Hermes returned {response.status_code}.", status="hermes_offline")
    payload = response.json()
    return payload if isinstance(payload, dict) else {}


async def list_jobs() -> list[dict[str, Any]]:
    """Scheduled jobs configured on the machine."""
    config = _require_enabled()
    response = await _request(config, "GET", "/api/jobs", timeout=JOBS_TIMEOUT_SECONDS)
    if response.status_code >= 400:
        raise HermesBridgeError(f"Hermes returned {response.status_code}.", status="hermes_offline")
    payload = response.json()
    jobs = payload.get("jobs") if isinstance(payload, dict) else None
    return [job for job in jobs if isinstance(job, dict)] if isinstance(jobs, list) else []


async def relay_turn(prompt: str, *, session_id: str | None = None) -> dict[str, Any]:
    """Run one natural-language turn on the machine and return its answer.

    Hermes reports agent-side failures in-band (HTTP 200 with an error finish
    reason), so ``failed`` is derived explicitly; a caller must not treat a
    failure payload as an answer.
    """
    config = _require_enabled()

    trimmed = (prompt or "").strip()
    if not trimmed:
        raise HermesBridgeError("A prompt is required.", status="hermes_relay_failed")
    if len(trimmed) > MAX_PROMPT_CHARS:
        raise HermesBridgeError(
            f"Prompts are limited to {MAX_PROMPT_CHARS} characters.",
            status="hermes_relay_failed",
        )

    headers = {"X-Hermes-Session-Id": session_id} if session_id else None
    response = await _request(
        config,
        "POST",
        "/v1/chat/completions",
        timeout=RELAY_TIMEOUT_SECONDS,
        json_body={"messages": [{"role": "user", "content": trimmed}]},
        extra_headers=headers,
    )
    if response.status_code >= 400:
        raise HermesBridgeError(
            f"Hermes returned {response.status_code}.", status="hermes_relay_failed"
        )

    payload = response.json()
    payload = payload if isinstance(payload, dict) else {}
    choices = payload.get("choices")
    choice = choices[0] if isinstance(choices, list) and choices else {}
    message = choice.get("message") if isinstance(choice, dict) else {}
    content = message.get("content") if isinstance(message, dict) else ""
    hermes_meta = payload.get("hermes") if isinstance(payload.get("hermes"), dict) else {}

    failed = bool(hermes_meta.get("failed")) or choice.get("finish_reason") == "error"

    return {
        "content": content if isinstance(content, str) else "",
        "session_id": response.headers.get("X-Hermes-Session-Id"),
        "model": payload.get("model") if isinstance(payload.get("model"), str) else None,
        "failed": failed,
        "error": hermes_meta.get("error") if isinstance(hermes_meta.get("error"), str) else None,
    }
