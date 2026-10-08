"""Runtime prompt-sync read path for per-user personal agents.

Lets a running agent pod resolve its current system prompt at runtime instead of
baking it into the deployed image, so a prompt can be rolled forward or back by
flipping an ``active`` row (migration 901) with NO redeploy and instant rollback.

On top of the raw stored row the service adds two integrity guarantees:

  * a freshly RECOMPUTED SHA-256 over the prompt text -- the stored
    ``prompt_sha256`` is never trusted blindly -- returned as the ETag so a pod
    re-pulls only when the prompt actually changed, and
  * an HMAC-SHA256 SIGNATURE over ``agent_id|channel|version|sha256`` keyed by
    ``APP_SIGNING_KEY``, so a pod can verify the prompt was issued by Hushh and
    was not tampered with in transit before it adopts it (fail-safe: on any
    fetch/verify failure the pod keeps its last-known-good prompt).

Same signing-key trust domain as consent tokens, with a DISTINCT context tag so
a prompt signature can never be confused with a consent-token signature. Pure
apart from the single injected repo read; reached only when the
``PERSONAL_AGENT_ENABLED`` kill-switch is on (enforced at the route).
"""

from __future__ import annotations

import hashlib
import hmac
from dataclasses import dataclass
from typing import Optional, Protocol

from hushh_mcp.runtime_settings import get_core_security_settings

# Distinct HMAC context tag: a prompt signature is never a consent-token MAC.
_SIGNATURE_CONTEXT = "hushh.personal-agent.prompt-signature.v1"
_SIGNATURE_PREFIX = "aps1_"
DEFAULT_CHANNEL = "default"


class _PromptRepo(Protocol):
    async def get_active(self, agent_id: str, channel: str) -> Optional[dict]: ...


@dataclass(frozen=True)
class ResolvedPrompt:
    """A signed, integrity-checked snapshot of an agent's active prompt."""

    agent_id: str
    channel: str
    version: str
    prompt_text: str
    prompt_sha256: str
    signature: str
    status: str


def compute_prompt_sha256(prompt_text: str) -> str:
    """SHA-256 hex over the UTF-8 prompt text; the authoritative ETag/content hash."""
    return hashlib.sha256(prompt_text.encode("utf-8")).hexdigest()


def sign_prompt(agent_id: str, channel: str, version: str, prompt_sha256: str) -> str:
    """HMAC-SHA256 over the prompt identity, keyed by APP_SIGNING_KEY.

    Deterministic and constant for a given (agent, channel, version, content),
    so a pod can recompute and constant-time-compare it. The content hash is part
    of the signed message, so a swapped body invalidates the signature.
    """
    key = get_core_security_settings().app_signing_key.encode("utf-8")
    message = f"{_SIGNATURE_CONTEXT}|{agent_id}|{channel}|{version}|{prompt_sha256}"
    digest = hmac.new(key, message.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"{_SIGNATURE_PREFIX}{digest}"


def verify_prompt_signature(
    agent_id: str, channel: str, version: str, prompt_sha256: str, signature: str
) -> bool:
    """Constant-time check that ``signature`` matches the prompt identity."""
    expected = sign_prompt(agent_id, channel, version, prompt_sha256)
    return hmac.compare_digest(expected, str(signature or ""))


class PersonalAgentPromptService:
    """Resolve + sign a per-user agent's active prompt for runtime sync."""

    def __init__(self, *, repo: _PromptRepo) -> None:
        self._repo = repo

    async def get_active_prompt(
        self, *, agent_id: str, channel: str = DEFAULT_CHANNEL
    ) -> Optional[ResolvedPrompt]:
        aid = str(agent_id or "").strip()
        chan = str(channel or "").strip() or DEFAULT_CHANNEL
        if not aid:
            raise ValueError("agent_id is required")

        row = await self._repo.get_active(aid, chan)
        if not row:
            return None

        prompt_text = str(row.get("prompt_text") or "")
        version = str(row.get("version") or "").strip()
        sha256 = compute_prompt_sha256(prompt_text)
        # A row that arrives ALREADY signed came from the signing authority (the hub,
        # via HubPromptRepo). Relay that signature instead of re-signing: a pod holds a
        # different APP_SIGNING_KEY, so a locally computed MAC would verify for nobody
        # holding the hub's key, and would quietly downgrade an authority attestation
        # into a self-attestation. The SHA is still recomputed above from the received
        # bytes, so a tampered body is caught either way.
        existing_signature = str(row.get("signature") or "").strip()
        signature = existing_signature or sign_prompt(aid, chan, version, sha256)
        return ResolvedPrompt(
            agent_id=aid,
            channel=chan,
            version=version,
            prompt_text=prompt_text,
            prompt_sha256=sha256,
            signature=signature,
            status=str(row.get("status") or "active"),
        )
