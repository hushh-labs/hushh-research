"""A pasted context transfer is kept: every stated line becomes memory or is accounted for.

Production 2026-09-29: a ~17 KB context transfer saved very little. The memory
agents dropped work context, people and technical identifiers as "not about the
owner" or "opaque", a single rewritten quote discarded a whole section, and a
sensitive fact skipped the structure agent and was clipped to 240 characters.

The device half of this proof replays the recorded answers through the
resumable save job (``hushh-webapp/__tests__/services/pkm-save-job.test.ts``).
This half proves those recorded answers are what the server produces today,
and checks the server's own guarantees directly. All content is synthetic.
"""

from __future__ import annotations

import json

import pytest

from hushh_mcp.services import pkm_agent_lab_service as module
from tests.services import context_transfer_agents as agents

RECORDING = json.loads(agents.RECORDING_PATH.read_text(encoding="utf-8"))
DOCUMENT = agents.DOCUMENT_PATH.read_text(encoding="utf-8")


def _answers() -> list[dict]:
    return [step["answer"] for step in RECORDING["steps"].values()]


def _cards() -> list[dict]:
    return [card for answer in _answers() for card in answer["preview_cards"]]


def test_the_recording_is_of_this_document():
    assert RECORDING["document_sha256"] == agents.step_key(DOCUMENT)
    assert len(DOCUMENT) > 15_000
    assert DOCUMENT.count("\n# ") + DOCUMENT.startswith("# ") == 20


@pytest.mark.asyncio
async def test_every_recorded_answer_is_what_the_server_produces_today():
    for key, step in RECORDING["steps"].items():
        assert agents.step_key(step["text"]) == key
        assert await agents.prepare(step["text"]) == step["answer"], step["text"][:80]


def test_the_server_keeps_work_context_people_and_identifiers():
    by_text = {card["source_text"]: card for card in _cards()}
    for line in (
        "- GCP project: lumen-demo-482910 in region us-central1",
        "- The API reads its signing key from the LUMEN_SIGNING_KEY environment variable",
        "- The Google OAuth callback is https://app.lumen-demo.dev/api/auth/callback/google",
        "- Asha Varma is our CTO in all but title and owns the data platform",
        "- Backend: FastAPI on Python 3.13",
    ):
        card = by_text[line]
        assert card["write_mode"] == "confirm_first", line
        assert card["save_class"] == "durable", line
    assert all(answer["used_fallback"] is False for answer in _answers())
    assert all(answer["preview_summary"]["unmatched_quote_count"] == 0 for answer in _answers())


def test_a_rewritten_quote_is_kept_as_the_owners_exact_text():
    # The scripted model cleaned "**" and flattened an em dash; the stored quote
    # is still the owner's own characters, so the device can place it.
    texts = {card["source_text"] for card in _cards()}
    assert "- **Preferred name:** Rowan Ellery, and I go by Ro with close friends" in texts
    assert (
        "- **Role:** Founder and CEO of Lumen Ledger — I also act as the de facto head "
        "of engineering"
    ) in texts
    assert all(card["source_text"] in DOCUMENT for card in _cards())
    assert all(quote in DOCUMENT for card in _cards() for quote in card["context_quotes"])


def test_sensitive_facts_are_structured_whole_and_disclaimers_are_accounted_for():
    salary = next(card for card in _cards() if card["source_text"].startswith("- Base salary"))
    assert salary["requires_confirmation"] is True
    assert salary["write_mode"] == "confirm_first"
    # Structured by the agent, not clipped by the fallback record.
    assert "set by the board in March 2026" in json.dumps(salary["candidate_payload"])
    not_memory = [
        entry for answer in _answers() for entry in answer["preview_summary"]["not_memory"]
    ]
    assert {
        "quote": "- Information not known: my exact home street address",
        "reason": "disclaimer",
    } in not_memory
    assert {
        "quote": "- Stripe for payments and Twilio for SMS verification codes",
        "reason": "duplicate",
    } in not_memory
    agents_card = next(card for card in _cards() if card["source_text"].startswith("- Our agents"))
    assert agents_card["target_domain"] == "professional"
    assert "protocol_domain_name_remapped" in agents_card["validation_hints"]


@pytest.mark.asyncio
async def test_negative_control_exact_only_quotes_lose_the_rewritten_lines(monkeypatch):
    # The matching this release replaced: a quote counted only when it was an
    # exact substring. The rewritten quotes match nothing and their lines are lost.
    def exact_only(message: str, quote: str):
        index = message.find(quote) if isinstance(quote, str) and quote.strip() else -1
        return (index, index + len(quote)) if index >= 0 else None

    monkeypatch.setattr(module, "locate_source_quote", exact_only)
    section = next(
        step["text"]
        for step in RECORDING["steps"].values()
        if step["text"].startswith("# Identity and preferences")
    )
    answer = await agents.prepare(section)
    assert answer["preview_summary"]["unmatched_quote_count"] == 1
    assert not any(
        card["source_text"].startswith("- **Preferred") for card in answer["preview_cards"]
    )
