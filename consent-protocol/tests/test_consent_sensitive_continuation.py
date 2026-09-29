"""Sensitive information never reaches the model (CONTRACT-2 C7, founder decision 2026-09-28).

The device replaces a sensitive item's values with a field-name outline before
it sends ``sharedInformation``. The server enforces the same rule again at
admission, before the text is stored for the prompt. These tests run the real
admission and then the real One text agent through a real ADK Runner with a
model that records every request, so they prove what the provider would
receive. The negative control removes only the strip and shows the value
arrives, so the assertion is not vacuous.
"""

from __future__ import annotations

import logging
from typing import Any

import pytest
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types
from pydantic import PrivateAttr

from hushh_mcp.one_adk import agent_tree, consent_continuation
from hushh_mcp.one_adk.consent_continuation import (
    STATE_CONSENT_CONTINUATION,
    admit_consent_continuation,
    consent_continuation_instruction,
    strip_sensitive_shared_information,
)
from hushh_mcp.one_adk.request_secrets import resolve_request_secret

BUNDLE = "0f0e0d0c-0b0a-4908-8706-050403020100"
OWNER = "requester-uid"
AGI = "182,400"
FILING_STATUS = "Married filing jointly"
RESTAURANT = "Nopa"
SHARED = "\n".join(
    [
        "- Tax record > filing year: 2025",
        f"- Tax record > adjusted gross income: {AGI}",
        f"- Tax record > filing status: {FILING_STATUS}",
        f"- Food preferences > favorite restaurant: {RESTAURANT}",
    ]
)


def _bundle(*, tax_sensitivity: str | None = "sensitive") -> dict[str, Any]:
    tax: dict[str, Any] = {"requestId": "r-tax", "label": "Tax record", "status": "granted"}
    if tax_sensitivity is not None:
        tax["sensitivity"] = tax_sensitivity
    return {
        "bundleId": BUNDLE,
        "personRef": "person-ref",
        "cancelled": False,
        "items": [
            tax,
            {
                "requestId": "r-food",
                "label": "Food preferences",
                "sensitivity": "standard",
                "status": "granted",
            },
        ],
        "progress": {
            "outcome": "granted",
            "fields": [
                {"label": "Tax record", "status": "granted", "sensitivity": tax_sensitivity},
                {"label": "Food preferences", "status": "granted", "sensitivity": "standard"},
            ],
        },
    }


async def _admit(bundle: dict[str, Any], shared: str = SHARED) -> dict[str, Any]:
    async def get_bundle(*, requester_user_id: str, bundle_id: str) -> dict[str, Any]:
        return bundle

    return await admit_consent_continuation(
        {
            "consentContinuation": {
                "bundleId": BUNDLE,
                "outcome": "granted",
                "sharedInformation": shared,
            }
        },
        owner_id=OWNER,
        messages=[{"role": "user", "content": "Consent approved"}],
        session_state={},
        asked_here=lambda _bundle: True,
        get_bundle=get_bundle,
        person_name=lambda _ref: "Manish",
    )


class _RecordingModel(BaseLlm):
    _requests: list = PrivateAttr(default_factory=list)

    def __init__(self) -> None:
        super().__init__(model="gemini-3.6-flash")

    async def generate_content_async(self, llm_request, stream=False):
        self._requests.append(llm_request.model_copy(deep=True))
        yield LlmResponse(
            content=types.Content(
                role="model",
                parts=[types.Part(text="Manish's tax record is in the secure card above.")],
            )
        )


def _everything_the_model_read(llm_request: Any) -> str:
    instruction = llm_request.config.system_instruction if llm_request.config else None
    contents = "\n".join(
        str(part.text or "")
        for content in llm_request.contents or []
        for part in content.parts or []
    )
    return f"{instruction or ''}\n{contents}"


async def _model_request_for_answer_turn(
    monkeypatch, bundle: dict[str, Any] | None = None, shared: str = SHARED
) -> str:
    async def ledger(_owner_id: str, bundle_id: str) -> dict[str, Any]:
        return {"bundleId": bundle_id, "progress": {"outcome": "granted", "ended_at": None}}

    monkeypatch.setattr(agent_tree, "_requester_bundle", ledger)
    admitted = await _admit(bundle or _bundle(), shared)
    model = _RecordingModel()
    agent = agent_tree.build_one_text_agent(model=model)
    agent.tools = []
    sessions = InMemorySessionService()
    await sessions.create_session(app_name="one", user_id=OWNER, session_id="chat")
    runner = Runner(agent=agent, app_name="one", session_service=sessions)
    async for _event in runner.run_async(
        user_id=OWNER,
        session_id="chat",
        new_message=types.Content(role="user", parts=[types.Part(text="Consent approved")]),
        state_delta=admitted,
    ):
        pass
    assert model._requests, "the answer turn never called the model"
    return "\n".join(_everything_the_model_read(request) for request in model._requests)


@pytest.mark.asyncio
async def test_a_sensitive_value_never_reaches_the_model_request(monkeypatch) -> None:
    read = await _model_request_for_answer_turn(monkeypatch)

    assert AGI not in read
    assert FILING_STATUS not in read
    assert "2025" not in read
    # The model still knows what exists, by name, and where it is shown.
    assert "Tax record: 3 fields (Filing year, Adjusted gross income, Filing status)" in read
    assert "secure card" in read
    # A standard item still reaches the model, so One can answer naturally.
    assert RESTAURANT in read


@pytest.mark.asyncio
async def test_negative_control_without_the_strip_the_value_arrives(monkeypatch) -> None:
    monkeypatch.setattr(
        consent_continuation,
        "strip_sensitive_shared_information",
        lambda text, _sensitivities: (text, 0),
    )
    read = await _model_request_for_answer_turn(monkeypatch)
    assert AGI in read and FILING_STATUS in read


@pytest.mark.asyncio
async def test_admission_strips_before_storing_and_logs_counts_only(caplog) -> None:
    with caplog.at_level(logging.INFO, logger=consent_continuation.__name__):
        admitted = await _admit(_bundle())
    stored = resolve_request_secret(admitted[STATE_CONSENT_CONTINUATION]["shared"])
    assert AGI not in stored and FILING_STATUS not in stored
    assert f"favorite restaurant: {RESTAURANT}" in stored
    stripped = [r.getMessage() for r in caplog.records if "consent_sensitive_stripped" in r.message]
    assert stripped == ["one.consent_sensitive_stripped count=3"]
    assert all(AGI not in record.getMessage() for record in caplog.records)


@pytest.mark.asyncio
async def test_an_item_without_a_sensitivity_is_treated_as_sensitive() -> None:
    admitted = await _admit(_bundle(tax_sensitivity=None))
    stored = resolve_request_secret(admitted[STATE_CONSENT_CONTINUATION]["shared"])
    assert AGI not in stored
    assert RESTAURANT in stored


@pytest.mark.asyncio
async def test_the_instruction_points_to_the_secure_card_for_sensitive_items() -> None:
    admitted = await _admit(_bundle())
    assert admitted[STATE_CONSENT_CONTINUATION]["sensitiveLabels"] == ["Tax record"]
    instruction = consent_continuation_instruction(admitted.get)
    assert "Sensitive, so you have its field names only: Tax record." in instruction
    assert "secure card above" in instruction
    assert "never guess, restate or summarize those values" in instruction
    assert AGI not in instruction


def test_the_strip_keeps_names_drops_values_and_unattributable_lines() -> None:
    device_outline = (
        "- Tax record: 2 fields (Filing year, Refund). Sensitive: shown to the person in "
        "the secure card on their device; the values are not shared with you."
    )
    text = "\n".join(
        [
            f"- Tax record > filing status: {FILING_STATUS}",
            "- Unlabelled > ssn: 999-00-1234",
            f"- Food preferences > favorite restaurant: {RESTAURANT}",
            device_outline,
        ]
    )
    out, count = strip_sensitive_shared_information(
        text, {"Tax record": "sensitive", "Food preferences": "standard"}
    )
    assert count == 3
    assert FILING_STATUS not in out and "999-00-1234" not in out and "ssn" not in out
    assert f"- Food preferences > favorite restaurant: {RESTAURANT}" in out
    assert "- Tax record: 3 fields (Filing status, Filing year, Refund)." in out


def test_a_device_outline_cannot_carry_a_value_through_its_names() -> None:
    forged = (
        "- Tax record: 2 fields (Filing year, AGI 182400). Sensitive: shown to the person "
        "in the secure card on their device; the values are not shared with you."
    )
    out, _count = strip_sensitive_shared_information(forged, {"Tax record": "sensitive"})
    assert "182400" not in out
    assert "(Filing year)" in out


def test_all_standard_text_passes_through_untouched() -> None:
    text = f"- Food preferences > favorite restaurant: {RESTAURANT}"
    assert strip_sensitive_shared_information(text, {"Food preferences": "standard"}) == (
        text,
        0,
    )


# --- Field level (localhost acceptance run 4, 2026-09-29, S3) ----------------
# The same EIN was sensitive under "Tax record" and standard as "Fein" under
# "Legal entity information", so a Legal entity follow-up would have sent it
# to the model. The item stays standard (One can still say the trade name);
# the identifier field inside it never reaches the model.

EIN = "12-3456789"
TRADE_NAME = "Acme Coffee Roasters"
LEGAL_SHARED = "\n".join(
    [
        f"- Legal entity information > entity fein: {EIN}",
        f"- Legal entity information > trade name dba: {TRADE_NAME}",
        "- Legal entity information > entity type: C_CORP",
    ]
)


def _legal_bundle() -> dict[str, Any]:
    item = {
        "requestId": "r-legal",
        "label": "Legal entity information",
        "sensitivity": "standard",
        "status": "granted",
    }
    return {
        "bundleId": BUNDLE,
        "personRef": "person-ref",
        "cancelled": False,
        "items": [item],
        "progress": {"outcome": "granted", "fields": [dict(item)]},
    }


@pytest.mark.asyncio
async def test_an_ein_inside_a_standard_legal_entity_item_never_reaches_the_model(
    monkeypatch,
) -> None:
    read = await _model_request_for_answer_turn(monkeypatch, _legal_bundle(), LEGAL_SHARED)

    assert EIN not in read
    # The rest of the standard item still reaches the model.
    assert TRADE_NAME in read
    # The model knows the field exists, by its human name, and where it is shown.
    assert "Legal entity information: sensitive field (Federal EIN)" in read
    assert "Legal entity information (Federal EIN)" in read


@pytest.mark.asyncio
async def test_negative_control_without_the_field_rule_the_ein_arrives(monkeypatch) -> None:
    monkeypatch.setattr(consent_continuation, "field_sensitivity", lambda *_a, **_k: "standard")
    read = await _model_request_for_answer_turn(monkeypatch, _legal_bundle(), LEGAL_SHARED)
    assert EIN in read


def test_an_identifier_shaped_value_is_stripped_under_any_key() -> None:
    text = "\n".join(
        [
            "- Food preferences > note: SSN 123-45-6789 for the reservation",
            f"- Food preferences > favorite restaurant: {RESTAURANT}",
        ]
    )
    out, count = strip_sensitive_shared_information(text, {"Food preferences": "standard"})
    assert count == 1
    assert "123-45-6789" not in out
    assert f"favorite restaurant: {RESTAURANT}" in out


# --- R4: mixed standard plus sensitive (localhost acceptance run 4) ----------
# One answered "No 2025 federal tax refund information was shared" while the
# tax item sat in the secure card. The instruction the model reads must name
# the sensitive items as shared-but-hidden and forbid "was not shared".


@pytest.mark.asyncio
async def test_a_mixed_answer_names_the_hidden_items_as_shared_in_the_secure_card(
    monkeypatch,
) -> None:
    read = await _model_request_for_answer_turn(monkeypatch)

    assert (
        "Shared with the person but hidden from you, with values only in the secure card "
        "above: Tax record (Filing year, Adjusted gross income, Filing status)."
    ) in read
    assert "Never say that information was not shared" in read
    assert AGI not in read and FILING_STATUS not in read
    assert RESTAURANT in read


@pytest.mark.asyncio
async def test_an_all_standard_answer_names_nothing_as_hidden(monkeypatch) -> None:
    food = {
        "requestId": "r-food",
        "label": "Food preferences",
        "sensitivity": "standard",
        "status": "granted",
    }
    bundle = {
        "bundleId": BUNDLE,
        "personRef": "person-ref",
        "cancelled": False,
        "items": [food],
        "progress": {"outcome": "granted", "fields": [dict(food)]},
    }
    read = await _model_request_for_answer_turn(
        monkeypatch, bundle, f"- Food preferences > favorite restaurant: {RESTAURANT}"
    )
    assert "hidden from you" not in read
    assert RESTAURANT in read
