"""Short-lived action proposals kept in the owner's own sealed log.

The hub keeps a Calendar or Gmail change it prepared in a database table until the
owner confirms it. An agent in the owner's own cloud has no hub table and must not
borrow one, so it keeps the same hand-off in its own commit log (the log
``pod_memory_service._resolve_log`` returns, sealed under the owner's key):

* ``pod_action_proposal_v1`` records one prepared change: who it belongs to, what
  kind it is (``calendar``, ``gmail_mailbox``, ``drive``), its payload and its expiry;
* ``pod_action_proposal_settled_v1`` records each later status: ``executing`` when the
  owner's confirmation claims it, then ``executed`` or ``failed``.

A claim is a compare-and-set against the log head it read, so two confirmations of
one proposal cannot both run: the second sees ``executing`` and gets nothing. An
expired, settled, foreign or unknown proposal is simply unavailable. Nothing here
calls a provider and nothing here logs a payload.
"""

from __future__ import annotations

import logging
import os
import secrets
import time
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)

RECORD_KIND = "pod_action_proposal_v1"
SETTLED_KIND = "pod_action_proposal_settled_v1"
KINDS = frozenset({"calendar", "gmail_mailbox", "drive"})
PREFIXES = {"calendar": "gcal_", "gmail_mailbox": "gmod_", "drive": "gdrv_"}
STATUS_PENDING = "pending"
STATUS_EXECUTING = "executing"
TERMINAL = frozenset({"executed", "failed"})
DEFAULT_TTL_S = 600
_ATTEMPTS = 3


class ProposalStoreUnavailable(RuntimeError):
    """This agent has no durable log to keep a proposal in."""


def kind_of(proposal_id: str) -> Optional[str]:
    """The proposal kind its id names, or None for an id this store never minted."""
    for kind, prefix in PREFIXES.items():
        if isinstance(proposal_id, str) and proposal_id.startswith(prefix):
            return kind
    return None


class PodActionProposalStore:
    """Issue, claim and settle proposals in the owner's own log."""

    def __init__(
        self,
        *,
        log_resolver: Optional[Callable[[], Any]] = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._log_resolver = log_resolver
        self._clock = clock

    def _log(self) -> Any:
        if self._log_resolver is not None:
            log = self._log_resolver()
        else:
            from hushh_mcp.services.pod_memory_service import _resolve_log  # noqa: PLC0415

            log = _resolve_log()
        if log is None:
            raise ProposalStoreUnavailable("this agent has no durable log for proposals")
        return log

    @staticmethod
    def _hushh_id() -> str:
        return (os.environ.get("HUSSH_ID") or "").strip()

    async def _snapshot(self, log: Any) -> tuple[dict[str, dict[str, Any]], int]:
        """(proposal id -> {payload, status}, last seq) for this agent's owner."""
        records = await log.replay()
        hushh_id = self._hushh_id()
        state: dict[str, dict[str, Any]] = {}
        for record in records or []:
            kind = str((record or {}).get("kind") or "")
            payload = (record or {}).get("payload") or {}
            if kind not in {RECORD_KIND, SETTLED_KIND} or not isinstance(payload, dict):
                continue
            if str(payload.get("hushh_id") or "") != hushh_id:
                continue
            proposal_id = str(payload.get("proposalId") or "")
            if kind == RECORD_KIND:
                if proposal_id and proposal_id not in state:
                    state[proposal_id] = {"proposal": payload, "status": STATUS_PENDING}
            elif proposal_id in state:
                state[proposal_id]["status"] = str(payload.get("status") or "")
        return state, int(records[-1]["seq"]) if records else 0

    async def issue(
        self, *, kind: str, owner_id: str, payload: dict[str, Any], ttl_s: int = DEFAULT_TTL_S
    ) -> dict[str, Any]:
        """Record one prepared change; returns its id and expiry (epoch milliseconds)."""
        if kind not in KINDS or not owner_id or not isinstance(payload, dict):
            raise ValueError("a proposal needs a known kind, an owner and a payload")
        log = self._log()
        proposal_id = f"{PREFIXES[kind]}{secrets.token_urlsafe(24)}"
        expires_at_ms = int(self._clock() * 1000) + max(1, int(ttl_s)) * 1000
        await log.append(
            RECORD_KIND,
            {
                "hushh_id": self._hushh_id(),
                "proposalId": proposal_id,
                "kind": kind,
                "ownerId": owner_id,
                "expiresAtMs": expires_at_ms,
                "payload": payload,
            },
        )
        return {"proposal_id": proposal_id, "expires_at_ms": expires_at_ms}

    async def claim(self, *, proposal_id: str, owner_id: str, kind: str) -> Optional[dict]:
        """Move a live pending proposal to ``executing``; its payload, or None."""
        from hushh_mcp.services.pod_commit_log import PodLogConflict  # noqa: PLC0415

        log = self._log()
        for _ in range(_ATTEMPTS):
            state, last_seq = await self._snapshot(log)
            held = state.get(proposal_id)
            if held is None or held["status"] != STATUS_PENDING:
                return None
            proposal = held["proposal"]
            if (
                proposal.get("ownerId") != owner_id
                or proposal.get("kind") != kind
                or int(proposal.get("expiresAtMs") or 0) <= int(self._clock() * 1000)
            ):
                return None
            try:
                await log.append(
                    SETTLED_KIND,
                    self._settled(proposal_id, STATUS_EXECUTING),
                    expected_seq=last_seq,
                )
            except PodLogConflict:
                continue
            return dict(proposal.get("payload") or {})
        return None

    async def settle(self, *, proposal_id: str, status: str) -> None:
        """Record ``executed`` or ``failed``. Best effort: a claimed proposal never reruns."""
        if status not in TERMINAL:
            raise ValueError("a proposal settles as executed or failed")
        try:
            await self._log().append(SETTLED_KIND, self._settled(proposal_id, status))
        except Exception as exc:  # noqa: BLE001 - the action's outcome already stands
            logger.warning("pod_action_proposals.settle_failed reason=%s", type(exc).__name__)

    def _settled(self, proposal_id: str, status: str) -> dict[str, Any]:
        return {
            "hushh_id": self._hushh_id(),
            "proposalId": proposal_id,
            "status": status,
            "atMs": int(self._clock() * 1000),
        }


_STORE: Optional[PodActionProposalStore] = None


def pod_action_proposals() -> PodActionProposalStore:
    """The process-wide store every in-agent connector shares."""
    global _STORE
    if _STORE is None:
        _STORE = PodActionProposalStore()
    return _STORE


__all__ = [
    "KINDS",
    "RECORD_KIND",
    "SETTLED_KIND",
    "PodActionProposalStore",
    "ProposalStoreUnavailable",
    "kind_of",
    "pod_action_proposals",
]
