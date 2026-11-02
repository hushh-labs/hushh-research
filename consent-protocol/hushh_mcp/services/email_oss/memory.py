"""Request-bound memory.md projection and client-encrypted save requests.

This port owns no vault store. Only a current, owner-authorized browser supplies
the projection; only the existing PKM commit ledger can acknowledge a save.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Awaitable, Callable, Mapping
from typing import Any
from uuid import UUID, uuid4, uuid5

MAX_MEMORY_CHARS = 18_000
MAX_FACT_CHARS = 2_048
MEMORY_SOURCE = "one_memory.markdown"
TAG_SECTIONS = {
    "finance": "Facts",
    "contacts": "Facts",
    "projects": "Facts",
    "facts": "Facts",
    "preferences": "Preferences",
    "commitments": "Commitments",
}
_PLAN_NAMESPACE = UUID("76f0e762-c176-5947-a680-7011af78b71f")
CommitLookup = Callable[[str, str], Awaitable[Mapping[str, Any] | None]]


def _chars(value: str) -> int:
    return len(value.encode("utf-16-le")) // 2


def memory_save_digest(directive: Mapping[str, Any]) -> str:
    fields = [
        directive[key]
        for key in ("kind", "owner_id", "request_id", "domain_tag", "fact_markdown", "section")
    ]
    return hashlib.sha256(
        json.dumps(fields, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()


def memory_save_plan_id(directive: Mapping[str, Any]) -> str:
    scope = f"email-memory:{directive['request_id']}:{directive['digest']}"
    return f"pkm_plan_{uuid5(_PLAN_NAMESPACE, scope).hex}"


def _section(markdown: str, section: str) -> str:
    """Select an authored flat heading, ignoring headings inside fenced code."""
    selected: list[str] = []
    active = False
    fence: tuple[str, int] | None = None
    for line in markdown.splitlines(keepends=True):
        delimiter = re.match(r"^ {0,3}(`{3,}|~{3,})(.*)$", line.rstrip("\n"))
        if delimiter:
            marker = delimiter[1]
            if fence is None:
                fence = (marker[0], len(marker))
            elif marker[0] == fence[0] and len(marker) >= fence[1] and not delimiter[2].strip():
                fence = None
        elif fence is None and re.match(r"^#{1,2}\s", line):
            active = line.strip() == f"## {section}"
        if active:
            selected.append(line)
    return "".join(selected)


class EmailMemorySession:
    """One invocation's explicitly supplied projection, never ambient memory."""

    def __init__(
        self,
        *,
        owner_id: str,
        projection_owner_id: str,
        markdown: str,
        authorization_current: Callable[[], bool],
        commit_lookup: CommitLookup | None = None,
    ) -> None:
        if (
            not isinstance(owner_id, str)
            or not owner_id
            or len(owner_id) > 128
            or owner_id != projection_owner_id
        ):
            raise ValueError("Memory projection owner does not match.")
        if not isinstance(markdown, str) or _chars(markdown) > MAX_MEMORY_CHARS:
            raise ValueError("Memory projection exceeds its bound.")
        self.owner_id = owner_id
        self.markdown = markdown
        self.authorization_current = authorization_current
        self.commit_lookup = commit_lookup
        self._pending: dict[str, dict[str, Any]] = {}
        self._closed = False

    def _current(self) -> bool:
        if not self._closed and self.authorization_current() is True:
            return True
        self.markdown = ""
        self._pending.clear()
        return False

    def read_memory_md(self, section_or_query: str = "") -> dict[str, Any]:
        if not self._current():
            return {"status": "unavailable", "code": "memory_authority_changed"}
        if not isinstance(section_or_query, str) or _chars(section_or_query) > 256:
            return {"status": "input_required", "code": "memory_query_invalid"}
        # Queries are interpreted by the agent over the bounded projection.
        # Only an exact authored section changes the deterministic selection.
        section = {name.lower(): name for name in ("Facts", "Preferences", "Commitments")}.get(
            section_or_query.strip().lower()
        )
        text = _section(self.markdown, section) if section else self.markdown
        return {
            "status": "ok",
            "source": MEMORY_SOURCE,
            "markdown": text,
            "selected_section": section,
            "budget_chars": MAX_MEMORY_CHARS,
            "truncated": False,
        }

    def save_to_memory_md(self, domain_tag: str, fact_markdown: str) -> dict[str, Any]:
        if not self._current():
            return {"status": "unavailable", "saved": False, "code": "memory_authority_changed"}
        if self._pending:
            return {
                "status": "pending_client_commit",
                "saved": False,
                "code": "memory_review_already_pending",
            }
        tag = domain_tag.strip().lower() if isinstance(domain_tag, str) else ""
        fact = fact_markdown.strip() if isinstance(fact_markdown, str) else ""
        if tag not in TAG_SECTIONS or not fact or _chars(fact) > MAX_FACT_CHARS:
            return {"status": "input_required", "saved": False, "code": "memory_fact_invalid"}
        directive = {
            "kind": "email_memory_save",
            "owner_id": self.owner_id,
            "request_id": str(uuid4()),
            "domain_tag": tag,
            "fact_markdown": fact,
            "section": TAG_SECTIONS[tag],
        }
        directive["digest"] = memory_save_digest(directive)
        self._pending[directive["request_id"]] = directive
        return {"status": "pending_client_commit", "saved": False, "directive": dict(directive)}

    async def acknowledge_commit(
        self, request_id: str, receipt: Mapping[str, Any]
    ) -> dict[str, Any]:
        """Require the owner-scoped ledger, never a model/browser success claim."""
        if not self._current():
            return {"status": "unavailable", "saved": False, "code": "memory_authority_changed"}
        directive = self._pending.get(request_id)
        if not directive or self.commit_lookup is None:
            return {"status": "pending_client_commit", "saved": False}
        plan_id = memory_save_plan_id(directive)
        if (
            receipt.get("request_id") != request_id
            or receipt.get("digest") != directive["digest"]
            or receipt.get("receipt_ref") != plan_id
            or type(receipt.get("revision")) is not int
            or type(receipt.get("saved_count")) is not int
            or not 0 <= receipt["saved_count"] <= 1
        ):
            return {"status": "unavailable", "saved": False, "code": "memory_receipt_invalid"}
        committed = await self.commit_lookup(self.owner_id, plan_id)
        if not self._current():
            return {"status": "unavailable", "saved": False, "code": "memory_authority_changed"}
        revision = committed.get("data_version") if committed else None
        if (
            not committed
            or committed.get("exists") is not True
            or type(revision) is not int
            or revision < 0
            or receipt.get("revision") != revision
        ):
            return {"status": "pending_client_commit", "saved": False}
        self._pending.pop(request_id, None)
        return {
            "status": "committed",
            "saved": True,
            "saved_count": receipt["saved_count"],
            "revision": revision,
            "receipt_ref": plan_id,
            "request_id": request_id,
            "digest": directive["digest"],
        }

    def clear(self) -> None:
        self._closed = True
        self.markdown = ""
        self._pending.clear()
