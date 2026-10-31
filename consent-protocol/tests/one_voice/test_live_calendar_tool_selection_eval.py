"""Held-out semantic Calendar intents and negative controls for the Live head.

The fixture gate runs offline. Set ONE_VOICE_LIVE_TOOL_EVAL=1 to run nine
provider-backed cases through the production negotiated tool declarations.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import pytest

from hushh_mcp.one_voice.tools import registry
from tests.one_voice import tool_selection_eval_support as support

FIXTURE = Path(__file__).with_name("fixtures") / "calendar_tool_selection.v1.json"
FAMILIES = frozenset({"events", "event", "calendars", "freebusy", "openings", "no_write", "other"})
SCREENS = frozenset({"one_home"})


def _cases() -> list[support.Case]:
    return support.load_cases(
        FIXTURE,
        schema_version="one.voice.calendar_tool_selection.v1",
        families=FAMILIES,
        screens=SCREENS,
    )


def test_calendar_fixture_covers_paraphrases_and_negative_controls():
    cases = _cases()
    assert len(cases) >= 9
    assert {case.family for case in cases} == FAMILIES
    assert len({case.utterance.casefold() for case in cases}) == len(cases)
    runtime_names = {
        item["name"] for item in registry.runtime_declarations(mail_review_supported=True)
    }
    catalog_names = {item["name"] for item in registry.declarations()}
    for case in cases:
        assert set(case.expected_tools) <= runtime_names
        assert set(case.forbidden_tools) <= catalog_names
        assert "read_calendar" in case.forbidden_tools or "read_calendar" in case.expected_tools
        if case.family == "no_write":
            assert not case.expected_tools
    corpus = support.production_corpus().casefold()
    assert all(case.utterance.casefold() not in corpus for case in cases)


@pytest.mark.live_model
def test_live_calendar_semantic_selection_without_provider_writes(monkeypatch):
    if os.getenv(support.LIVE_EVAL_ENV) != "1":
        pytest.skip("Set ONE_VOICE_LIVE_TOOL_EVAL=1 to run the Live semantic eval")
    for key in (
        "ONE_VOICE_MAIL_READS_ENABLED",
        "ONE_VOICE_MAIL_REPLY_ENABLED",
        "ONE_VOICE_MAIL_DRAFTS_ENABLED",
        "ONE_VOICE_MAIL_SCHEDULE_SEND_ENABLED",
        "MAIL_SCHEDULED_DRAIN_ENABLED",
    ):
        monkeypatch.setenv(key, "true")
    mode, model_id, location, _label = support.resolve_mode()
    if mode != "live":
        pytest.skip("Calendar routing gate runs on the Live head")

    declarations = registry.runtime_declarations(mail_review_supported=True)

    def responders(_case: support.Case):
        async def respond(name: str, args: dict[str, Any]) -> dict[str, Any]:
            if name == "read_calendar":
                return {
                    "status": "ok",
                    "operation": args.get("operation"),
                    "returned_count": 3,
                    "truncated": False,
                    "spoken_facts": ["I found three results. The details are on screen."],
                }
            if name == "read_mail":
                return {
                    "status": "ok",
                    "returned_count": 1,
                    "spoken_facts": ["I found one email. Its details are on screen."],
                }
            return {"status": "rejected", "reason_code": "eval_no_effect", "spoken_facts": []}

        return respond

    probe = support.make_live_probe(model_id, location, responders, declarations=declarations)
    failures: list[str] = []
    for case in _cases():
        obs = support.observe(probe, case)
        if obs.error:
            failures.append(f"{case.id}: {obs.error}")
            continue
        if any(name in case.forbidden_tools for name in obs.all_tools):
            failures.append(f"{case.id}: forbidden {obs.all_tools}")
        if case.expected_tools and not set(case.expected_tools) & set(obs.all_tools):
            failures.append(f"{case.id}: expected {case.expected_tools}, got {obs.all_tools}")
        if support.arg_mismatches(obs):
            failures.append(f"{case.id}: arguments {support.arg_mismatches(obs)}")
    assert not failures, failures
