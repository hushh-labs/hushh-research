"""Prove evaluation admission before probing, without owner authority or model calls."""

import json

import pytest

from scripts import eval_one_first_tool as harness


def test_mail_selection_requires_declared_synthetic_chat_context():
    case = next(
        case for case in harness.load_cases() if case.id == "delegation.read_recent_mail_v2"
    )
    calls = []

    def probe(instruction, prompt, screen):
        calls.append(instruction)
        return "ask_email_agent"

    empty = harness.production_instruction()
    with pytest.raises(ValueError, match="forbidden by its runtime context"):
        harness.score_cases([case], probe, empty, reps=1)
    assert calls == []

    admitted = harness.production_instruction(case.runtime_context)
    assert "MAIL READ ADMISSION: enabled for this typed chat." in admitted
    assert "recipient_names and cc_names are unavailable" not in admitted  # shipping client
    result = harness.score_cases(
        [case], probe, empty, reps=1, instruction_overrides={case.id: admitted}
    )
    assert result[0].hit and calls == [admitted]
    # Selecting an evaluation context must not mutate the neutral context.
    assert harness.production_instruction() == empty


def test_device_receipt_tools_reach_only_typed_chat_rosters():
    # Showing them on every surface scored a paused-inbox answer as a receipt call.
    from hushh_mcp.one_adk.receipt_client_tools import RECEIPT_TOOL_NAMES

    declarations = harness.build_roster_declarations()
    assert RECEIPT_TOOL_NAMES <= {item.name for item in declarations}
    typed = harness.production_instruction("typed_chat")
    typed_names = {item.name for item in harness.surface_declarations(declarations, typed)}
    assert RECEIPT_TOOL_NAMES <= typed_names
    empty = harness.surface_declarations(declarations, harness.production_instruction())
    assert not RECEIPT_TOOL_NAMES & {item.name for item in empty}
    assert len(empty) == len(declarations) - len(RECEIPT_TOOL_NAMES)


def _turns():
    from scripts.eval_one_turn_replay import load_turn_cases

    return {case["id"]: case for case in load_turn_cases()}


def test_multi_turn_cases_load_and_first_turn_loaders_refuse_them():
    from scripts.eval_one_first_tool import load_cases
    from scripts.eval_one_turn_replay import CASES_PATH

    assert set(_turns()) == {
        "email.followup_second_mail_question",
        "receipts.followup_after_spending_answer",
        "email.draft_choice_both",
        "receipts.unanswered_device_call_then_question",
    }
    with pytest.raises(ValueError):
        load_cases(CASES_PATH)  # A v1 loader must never grade these as single turns.


def _wire(case_id, *, hygiene=True):
    from hushh_mcp.runtime_providers.azure_adk import _history
    from scripts.eval_one_turn_replay import replayed_contents

    case = _turns()[case_id]
    return _history(replayed_contents(case["history"], case["prompt"], hygiene=hygiene))


@pytest.mark.parametrize(
    "case_id",
    [
        "email.followup_second_mail_question",
        "receipts.followup_after_spending_answer",
        "email.draft_choice_both",
        "receipts.unanswered_device_call_then_question",
    ],
)
def test_replayed_follow_ups_are_valid_azure_requests_without_placeholders(case_id):
    # UAT 2026-10-29 (#8642): replayed placeholders were copied or broke later turns.
    from hushh_mcp.one_adk.receipt_client_tools import PRIVATE_RECEIPT_ANSWER

    wire = _wire(case_id)
    case = _turns()[case_id]
    text = json.dumps(wire)
    assert "content_redacted" not in text and PRIVATE_RECEIPT_ANSWER not in text
    assert [item["content"] for item in wire if item.get("role") == "user"] == [
        *(turn["user"] for turn in case["history"]),
        case["prompt"],
    ]


def test_without_history_hygiene_the_stored_turns_break_the_follow_up():
    from hushh_mcp.one_adk.receipt_client_tools import PRIVATE_RECEIPT_ANSWER

    assert "content_redacted" in json.dumps(
        _wire("email.followup_second_mail_question", hygiene=False)
    )
    assert PRIVATE_RECEIPT_ANSWER in json.dumps(
        _wire("receipts.followup_after_spending_answer", hygiene=False)
    )
    with pytest.raises(ValueError, match="complete tool results"):
        _wire("receipts.unanswered_device_call_then_question", hygiene=False)


def test_args_rules_turn_a_follow_up_that_drops_the_request_into_a_named_miss():
    # UAT 2026-10-29 (#8642): the replayed ask_email_agent({}) lost the owner's request.
    from scripts.eval_one_first_tool import is_hit
    from scripts.eval_one_turn_replay import args_label

    mail, draft = (
        _turns()["email.followup_second_mail_question"],
        _turns()["email.draft_choice_both"],
    )
    dropped = args_label("ask_email_agent", {}, mail["args"])
    assert dropped == "ask_email_agent:args_incomplete"
    assert not is_hit(dropped, mail["expected"])
    assert is_hit(
        args_label("ask_email_agent", {"request": "more?"}, mail["args"]), mail["expected"]
    )
    nobody = args_label("open_gmail_email_draft", {"request": "both", "to": []}, draft["args"])
    assert nobody == "open_gmail_email_draft:args_incomplete"
    both = {"request": "both", "recipient_names": "Sharu Patel, Sharu Rao"}
    assert args_label("open_gmail_email_draft", both, draft["args"]) == "open_gmail_email_draft"


class _StubRoot:
    """Stands in for the admitted managed root; records each request it is asked."""

    model, primary_provider = "one-root-deployment", "azure_openai"

    def __init__(self, fail=False):
        self.requests, self.fail = [], fail

    def model_copy(self, update):
        return self

    async def generate_content_async(self, request, stream=False):
        from google.adk.models import LlmResponse
        from google.genai import types

        self.requests.append(request)
        if self.fail:
            raise TimeoutError("synthetic provider outage")
        call = types.FunctionCall(name="ask_email_agent", args={"request": "who mailed me?"})
        yield LlmResponse(
            content=types.Content(role="model", parts=[types.Part(function_call=call)]),
            finish_reason=types.FinishReason.STOP,
        )


def test_azure_follow_ups_ask_the_admitted_root_with_production_chat_settings(monkeypatch):
    import asyncio

    from hushh_mcp.one_adk.agent_tree import _one_chat_thinking_config
    from hushh_mcp.one_adk.receipt_client_tools import RECEIPT_TOOL_NAMES
    from scripts import eval_one_azure_first_tool as azure
    from scripts import probe_one_text_root

    root = _StubRoot()

    async def admitted():
        return root, "", []

    monkeypatch.setattr(probe_one_text_root, "_root_contract", admitted)
    cases = list(_turns().values())
    model, settings = asyncio.run(azure.admitted_root())
    results = azure.score_follow_ups(cases, azure.make_azure_call(model, settings), reps=1)
    assert {result.id for result in results if result.hit} == {
        "email.followup_second_mail_question",
        "receipts.unanswered_device_call_then_question",
    }
    for case, request in zip(cases, root.requests, strict=True):
        assert request.model == "one-root-deployment"
        assert request.config.system_instruction == harness.production_instruction("typed_chat")
        assert request.config.thinking_config == _one_chat_thinking_config(
            root, include_summaries=True
        )
        assert RECEIPT_TOOL_NAMES <= {d.name for d in request.config.tools[0].function_declarations}
        assert request.contents[-1].parts[0].text == case["prompt"]
    # A provider failure stops the measurement; later cases are never graded.
    outage = azure.score_follow_ups(
        cases, azure.make_azure_call(_StubRoot(fail=True), settings), reps=1
    )
    assert [result.status for result in outage] == ["infrastructure_error"] + ["unattempted"] * 3
    assert outage[0].infrastructure_failure["error_type"] == "TimeoutError"
    root.primary_provider = "vertex"
    with pytest.raises(ValueError, match="managed Azure"):
        asyncio.run(azure.admitted_root())
