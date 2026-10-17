"""DB read adapter for the versioned agent-prompt store (migration 901).

Read-only in Phase 0: resolves the single ``active`` prompt row for an
``(agent_id, channel)`` pair from ``agent_prompt_versions``. The "flip active"
contract (at most one active row per agent/channel) is enforced by the migration's
partial unique index, so a plain ``status = 'active'`` lookup is unambiguous.

The client is injectable so the repo is hermetically testable with a fake; in
production it resolves the shared ``db.db_client.get_db()`` client lazily. Mirrors
the access pattern of ``PersonalAgentRegistryRepo``.
"""

from __future__ import annotations

import asyncio
import hmac
import logging
from typing import Any, Optional

from db.db_client import get_db

logger = logging.getLogger(__name__)

_TABLE = "agent_prompt_versions"
_HUB_PROMPT_PATH = "/api/one/agent-prompt"


class PersonalAgentPromptRepo:
    """Read-only CRUD over the versioned agent-prompt store."""

    def __init__(self, client: Any = None) -> None:
        self._client = client

    def _db(self) -> Any:
        return self._client if self._client is not None else get_db()

    async def get_active(self, agent_id: str, channel: str) -> Optional[dict]:
        """Return the single active prompt row for ``(agent_id, channel)``, or None."""
        response = (
            self._db()
            .table(_TABLE)
            .select("*")
            .eq("agent_id", agent_id)
            .eq("channel", channel)
            .eq("status", "active")
            .limit(1)
            .execute()
        )
        rows = response.data or []
        return rows[0] if rows else None


class HubPromptRepo:
    """The same read, satisfied through the hub instead of Postgres.

    Identical ``get_active`` shape to ``PersonalAgentPromptRepo``, so it drops into the
    ``_PromptRepo`` seam ``PersonalAgentPromptService`` already declares -- the service
    never learns where the row came from. What changes is that a pod needs NO database
    credential, which is what keeps the zero-role pod identity meaningful.

    **Integrity is checked here, not assumed.** The hub returns the prompt text together
    with the SHA-256 it signed over. This recomputes that hash from the received bytes
    and constant-time-compares it, so a body altered in transit is rejected rather than
    adopted. The hub's SIGNATURE is passed through untouched: a pod holds a different
    signing key, so re-signing locally would silently replace the authority's
    attestation with a self-attestation that no holder of the hub's key could verify.

    A hub outage raises rather than returning None. "No prompt configured" and "could
    not ask" are different answers, and collapsing them would let an outage read as a
    deliberately empty configuration.
    """

    def __init__(self, client: Any = None) -> None:
        self._client = client

    def _hub(self) -> Any:
        if self._client is not None:
            return self._client
        from hushh_mcp.services.pod_hub_client import PodHubClient

        return PodHubClient()

    async def get_active(self, agent_id: str, channel: str) -> Optional[dict]:
        from hushh_mcp.services.personal_agent_prompt_service import compute_prompt_sha256
        from hushh_mcp.services.pod_hub_client import PodHubUnavailable

        hub = self._hub()
        response = await asyncio.to_thread(hub.get, _HUB_PROMPT_PATH, params={"channel": channel})
        status = getattr(response, "status_code", 0)
        if status == 404:
            return None
        if status != 200:
            raise PodHubUnavailable(f"hub returned HTTP {status} for the prompt read")

        body = response.json() or {}
        prompt_text = str(body.get("prompt") or "")
        claimed_sha = str(body.get("promptSha256") or "")
        recomputed = compute_prompt_sha256(prompt_text)
        if not hmac.compare_digest(recomputed, claimed_sha):
            # Fail safe: refuse a prompt whose body does not match what the hub signed.
            logger.error("hub_prompt.integrity_mismatch agent_id=%s channel=%s", agent_id, channel)
            return None

        # Shaped like the stored row, plus the hub's signature for pass-through.
        return {
            "agent_id": str(body.get("agentId") or agent_id),
            "channel": str(body.get("channel") or channel),
            "version": str(body.get("version") or ""),
            "prompt_text": prompt_text,
            "prompt_sha256": claimed_sha,
            "signature": str(body.get("signature") or ""),
            "status": str(body.get("status") or "active"),
        }


def resolve_prompt_repo() -> Any:
    """Where this process reads prompts from -- the single decision point.

    A pod reads through the hub; the hub reads Postgres. Deciding it here, off
    ``pod_mode()``, makes "a pod never touches the database" a property of the code
    rather than a rule someone has to remember at each call site -- the same shape as
    ``resolve_pod_memory_service``.
    """
    from hushh_mcp.runtime_settings import pod_mode

    return HubPromptRepo() if pod_mode() else PersonalAgentPromptRepo()
