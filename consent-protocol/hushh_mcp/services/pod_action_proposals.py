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
from typing import Any, Callable, Literal, Optional, TypedDict

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


class EmailSendStatus(TypedDict):
    proposalId: str
    kind: Literal["gmail_mailbox"]
    state: Literal["prepared", "sent", "expired", "outcome_unknown"]


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
                if isinstance(payload.get("calendar_reply"), dict):
                    state[proposal_id]["calendar_reply"] = payload["calendar_reply"]
                if payload.get("status") == "executed" and isinstance(
                    payload.get("calendar_event_id"), str
                ):
                    state[proposal_id]["calendar_booking"] = {
                        "event_id": payload["calendar_event_id"],
                        "at_ms": payload.get("atMs"),
                        "sequence": record["seq"],
                    }
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

    async def email_send_status(
        self, *, proposal_id: str, owner_id: str
    ) -> Optional[EmailSendStatus]:
        """Read sealed settlement evidence without claiming or dispatching anything."""
        state, _ = await self._snapshot(self._log())
        held = state.get(proposal_id)
        if held is None:
            return None
        proposal = held["proposal"]
        if (
            not owner_id
            or proposal.get("ownerId") != owner_id
            or proposal.get("kind") != "gmail_mailbox"
            or (proposal.get("payload") or {}).get("action") != "send_email"
        ):
            return None
        observed = held["status"]
        outcome: Literal["prepared", "sent", "expired", "outcome_unknown"]
        if observed == STATUS_PENDING:
            outcome = (
                "expired"
                if int(proposal.get("expiresAtMs") or 0) <= int(self._clock() * 1000)
                else "prepared"
            )
        elif observed == "executed":
            outcome = "sent"
        else:
            # Executing may have lost its response; failed includes uncertain dispatch.
            outcome = "outcome_unknown"
        return {"proposalId": proposal_id, "kind": "gmail_mailbox", "state": outcome}

    async def calendar_reply_status(self, *, proposal_id: str, owner_id: str) -> dict | None:
        state, _ = await self._snapshot(self._log())
        held = state.get(proposal_id)
        if not held:
            return None
        proposal = held["proposal"]
        if (
            not owner_id
            or proposal.get("ownerId") != owner_id
            or proposal.get("kind") != "calendar"
            or not (proposal.get("payload") or {}).get("plan", {}).get("linked_gmail_reply")
        ):
            return None
        receipt = held.get("calendar_reply")
        if receipt is None:
            if held["status"] == STATUS_PENDING:
                state_name = (
                    "expired"
                    if proposal["expiresAtMs"] <= int(self._clock() * 1000)
                    else "prepared"
                )
                return {
                    "proposalId": proposal_id,
                    "kind": "calendar",
                    "calendar": state_name,
                    "gmail": "not_sent",
                }
            return {
                "proposalId": proposal_id,
                "kind": "calendar",
                "calendar": "created" if held["status"] == "executed" else "outcome_unknown",
                "gmail": "outcome_unknown" if held["status"] == STATUS_EXECUTING else "not_sent",
            }
        gmail = receipt["gmail"] if receipt["gmail"] != "dispatching" else "outcome_unknown"
        return {
            "proposalId": proposal_id,
            "kind": "calendar",
            "calendar": "created",
            "eventId": receipt["event_id"],
            "gmail": gmail,
        }

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

    async def settle(
        self, *, proposal_id: str, status: str, calendar_event_id: str | None = None
    ) -> None:
        """Record ``executed`` or ``failed``. Best effort: a claimed proposal never reruns."""
        if status not in TERMINAL:
            raise ValueError("a proposal settles as executed or failed")
        try:
            settlement = self._settled(proposal_id, status)
            if status == "executed" and calendar_event_id:
                settlement["calendar_event_id"] = calendar_event_id
            await self._log().append(SETTLED_KIND, settlement)
        except Exception as exc:  # noqa: BLE001 - the action's outcome already stands
            logger.warning("pod_action_proposals.settle_failed reason=%s", type(exc).__name__)

    async def recent_calendar_booking(self, *, owner_id: str, conversation_id: str) -> dict | None:
        if not owner_id or not conversation_id:
            return None
        state, _ = await self._snapshot(self._log())
        recent = None
        for held in state.values():
            receipt = held.get("calendar_booking")
            proposal = held["proposal"]
            payload = proposal.get("payload") or {}
            plan = payload.get("plan") or {}
            if (
                not receipt
                or held["status"] != "executed"
                or proposal.get("ownerId") != owner_id
                or proposal.get("kind") != "calendar"
                or payload.get("action") != "create"
                or plan.get("chat_conversation_id") != conversation_id
                or (recent is not None and receipt["sequence"] <= recent["sequence"])
            ):
                continue
            recent = {
                **receipt,
                "account_id": plan.get("account_id"),
                "calendar_id": plan.get("calendar_id"),
                "grant_binding": plan.get("connection_binding"),
            }
        if recent and isinstance(recent["at_ms"], int):
            if 0 <= int(self._clock() * 1000) - recent["at_ms"] <= 300_000:
                return recent
        return None

    async def record_calendar_reply(
        self,
        *,
        proposal_id: str,
        owner_id: str,
        event_id: str,
        gmail: str,
        message_id: str | None = None,
    ) -> bool:
        """Checkpoint Calendar's receipt before any linked Gmail dispatch."""
        from hushh_mcp.services.pod_commit_log import PodLogConflict

        log = self._log()
        for _ in range(_ATTEMPTS):
            state, last_seq = await self._snapshot(log)
            held = state.get(proposal_id)
            if not held or held["status"] != STATUS_EXECUTING:
                return False
            proposal = held["proposal"]
            previous = held.get("calendar_reply")
            if (
                proposal.get("ownerId") != owner_id
                or proposal.get("kind") != "calendar"
                or not (proposal.get("payload") or {}).get("plan", {}).get("linked_gmail_reply")
                or (gmail == "dispatching" and previous is not None)
                or (
                    gmail != "dispatching"
                    and (
                        gmail not in {"sent", "not_sent", "outcome_unknown"}
                        or not previous
                        or previous.get("gmail") != "dispatching"
                        or previous.get("event_id") != event_id
                    )
                )
            ):
                return False
            receipt = {"event_id": event_id, "gmail": gmail}
            if message_id:
                receipt["message_id"] = message_id
            try:
                await log.append(
                    SETTLED_KIND,
                    {**self._settled(proposal_id, STATUS_EXECUTING), "calendar_reply": receipt},
                    expected_seq=last_seq,
                )
            except PodLogConflict:
                continue
            return True
        return False

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
