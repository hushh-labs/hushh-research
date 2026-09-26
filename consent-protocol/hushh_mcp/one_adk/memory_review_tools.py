"""The four typed tools the memory review agent may call, and nothing else.

The review agent is invoked by the runtime (a conversation closing, or the
catch-up before the next answer), never by the model on a live turn, and it
carries NO product tools: it cannot navigate, act, read a door or reach PKM.
Its whole vocabulary is here.

EXTRACTION IS THE MODEL'S; POLICY ONLY VALIDATES. Per ``AGENTS.md`` doctrine 9,
what counts as a durable fact about the person is a semantic judgement the
model makes by choosing a tool. The code below validates shape and authority
(length caps, an op cap, ids that must exist in the digest it was shown,
owner binding) and REFUSES what fails; it never classifies text with a keyword
or regex, and it never substitutes a different operation for the one asked.

NOTHING HERE WRITES. Each tool appends a validated proposal to a sink. The
review pass applies the sink to the memory service afterwards, so a timeout
mid-review leaves the log exactly as it was, and ``propose_pkm_fact`` never
touches PKM at all: it becomes a ``prompt`` directive the owner confirms.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from hushh_mcp.services.pod_memory_service import (
    MEMORY_FACT_MAX_CHARS,
    MEMORY_REVIEW_MAX_OPS,
)

NOTHING_TO_SAVE = "NOTHING_TO_SAVE"
PKM_MEMORY_PROPOSAL_TYPE = "pkm_memory_proposal"
_DOMAIN_MAX_CHARS = 64


@dataclass
class MemoryReviewSink:
    """Validated proposals from ONE review, applied by the runtime afterwards."""

    known_ids: frozenset[str]
    remembers: list[str] = field(default_factory=list)
    supersedes: list[tuple[str, str]] = field(default_factory=list)
    forgets: list[str] = field(default_factory=list)
    pkm_proposals: list[dict[str, str]] = field(default_factory=list)
    refused: int = 0

    @property
    def op_count(self) -> int:
        return (
            len(self.remembers) + len(self.supersedes) + len(self.forgets) + len(self.pkm_proposals)
        )

    def counts(self) -> dict[str, int]:
        return {
            "remember": len(self.remembers),
            "supersede": len(self.supersedes),
            "forget": len(self.forgets),
            "pkm_proposals": len(self.pkm_proposals),
            "refused": self.refused,
        }

    def directives(self) -> list[dict[str, Any]]:
        """The PKM proposals as ``prompt`` directives on the existing contract."""
        return [
            {
                "kind": "prompt",
                "payload": {
                    "type": PKM_MEMORY_PROPOSAL_TYPE,
                    "domain": item["domain"],
                    "fact": item["fact"],
                },
                "delegateAgentId": None,
            }
            for item in self.pkm_proposals
        ]

    # -- validation, the only policy this module holds ----------------------------

    def _refuse(self, reason: str) -> dict[str, Any]:
        self.refused += 1
        return {"status": "refused", "reason": reason}

    def _cap_reached(self) -> bool:
        return bool(self.op_count >= MEMORY_REVIEW_MAX_OPS)

    @staticmethod
    def _clean_fact(fact: Any) -> str:
        return " ".join(str(fact or "").split()).strip()

    def remember(self, fact: str) -> dict[str, Any]:
        text = self._clean_fact(fact)
        if not text:
            return self._refuse("empty_fact")
        if len(text) > MEMORY_FACT_MAX_CHARS:
            return self._refuse("fact_too_long")
        if self._cap_reached():
            return self._refuse("op_cap_reached")
        self.remembers.append(text)
        return {"status": "queued", "op": "remember"}

    def supersede(self, memory_id: str, fact: str) -> dict[str, Any]:
        old = str(memory_id or "").strip()
        text = self._clean_fact(fact)
        if old not in self.known_ids:
            return self._refuse("unknown_memory_id")
        if not text:
            return self._refuse("empty_fact")
        if len(text) > MEMORY_FACT_MAX_CHARS:
            return self._refuse("fact_too_long")
        if self._cap_reached():
            return self._refuse("op_cap_reached")
        if any(old == existing for existing, _ in self.supersedes) or old in self.forgets:
            return self._refuse("memory_id_already_handled")
        self.supersedes.append((old, text))
        return {"status": "queued", "op": "supersede"}

    def forget(self, memory_id: str) -> dict[str, Any]:
        old = str(memory_id or "").strip()
        if old not in self.known_ids:
            return self._refuse("unknown_memory_id")
        if self._cap_reached():
            return self._refuse("op_cap_reached")
        if old in self.forgets or any(old == existing for existing, _ in self.supersedes):
            return self._refuse("memory_id_already_handled")
        self.forgets.append(old)
        return {"status": "queued", "op": "forget"}

    def propose_pkm_fact(self, domain: str, fact: str) -> dict[str, Any]:
        text = self._clean_fact(fact)
        name = "".join(ch for ch in str(domain or "").strip().lower() if ch.isalnum() or ch in "_-")
        if not name or len(name) > _DOMAIN_MAX_CHARS:
            return self._refuse("invalid_domain")
        if not text:
            return self._refuse("empty_fact")
        if len(text) > MEMORY_FACT_MAX_CHARS:
            return self._refuse("fact_too_long")
        if self._cap_reached():
            return self._refuse("op_cap_reached")
        self.pkm_proposals.append({"domain": name, "fact": text})
        return {"status": "proposed", "op": "propose_pkm_fact"}


def build_review_tools(sink: MemoryReviewSink) -> list[Any]:
    """ADK function tools bound to ``sink``. Docstrings are what the model reads."""
    from google.adk.tools import FunctionTool  # noqa: PLC0415

    def remember(fact: str) -> dict:
        """Save one durable fact about the person, in one plain sentence.

        Use for preferences, relationships, standing facts about their life and
        corrections they stated. Never for secrets, one-off tasks, reminders,
        or anything operational.

        Args:
            fact: One sentence, in the third person, at most 300 characters.
        """
        return sink.remember(fact)

    def supersede(memory_id: str, fact: str) -> dict:
        """Replace an existing fact that is now wrong with its corrected form.

        Args:
            memory_id: The id of the existing fact, exactly as listed.
            fact: The corrected sentence, at most 300 characters.
        """
        return sink.supersede(memory_id, fact)

    def forget(memory_id: str) -> dict:
        """Remove an existing fact the person asked you to forget or that is no
        longer true.

        Args:
            memory_id: The id of the existing fact, exactly as listed.
        """
        return sink.forget(memory_id)

    def propose_pkm_fact(domain: str, fact: str) -> dict:
        """Propose structured personal information for the person's own records.

        Nothing is written: the person confirms or declines the proposal. Use for
        information that belongs in their records (a domain such as health,
        travel, finance, family) rather than in your working memory.

        Args:
            domain: The record domain, one lowercase word such as health or travel.
            fact: The statement to propose, at most 300 characters.
        """
        return sink.propose_pkm_fact(domain, fact)

    return [
        FunctionTool(remember),
        FunctionTool(supersede),
        FunctionTool(forget),
        FunctionTool(propose_pkm_fact),
    ]
