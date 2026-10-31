"""Prove evaluation admission before probing, without owner authority or model calls."""

import hashlib
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


def _turn_ids():
    from scripts.eval_one_turn_replay import load_turn_cases

    return [case["id"] for case in load_turn_cases()]


@pytest.mark.parametrize("case_id", _turn_ids())
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


def test_follow_up_fixture_names_only_real_tools_and_declared_fields():
    # A typo would replay a history storage never produces, or make a case unpassable.
    declared = {item.name: item for item in harness.build_roster_declarations()}

    def fields(name):
        schema = declared[name].parameters_json_schema or (
            declared[name].parameters.model_dump(exclude_none=True)
            if declared[name].parameters
            else {}
        )
        return set(schema.get("properties", {}))

    for case in _turns().values():
        assert set(case["expected"]) <= set(declared) | {harness.NO_TOOL}, case["id"]
        for step in (step for turn in case["history"] for step in turn.get("steps", [])):
            if "call" in step:
                name, args = step["call"]["name"], step["call"].get("args") or {}
                assert name in declared and set(args) <= fields(name), case["id"]
        for tool, rule in case.get("args", {}).items():
            assert {name for names in rule.values() for name in names} <= fields(tool), case["id"]


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
    # Rules belong to their tool, so a wrong tool keeps its own name.
    assert args_label("open_gmail_email_draft", {}, mail["args"]) == "open_gmail_email_draft"
    for args in ({"request": "both", "to": []}, {"recipient_names": "Sharu Patel, Sharu Rao"}):
        assert args_label("open_gmail_email_draft", args, draft["args"]).endswith(
            ":args_incomplete"
        )
    both = {"request": "both", "recipient_names": "Sharu Patel, Sharu Rao"}
    assert args_label("open_gmail_email_draft", both, draft["args"]) == "open_gmail_email_draft"


class _StubRoot:
    """Stands in for the admitted managed root; records each request and how it was asked."""

    model, primary_provider = "one-root-deployment", "azure_openai"

    def __init__(self, args=None):
        self.requests, self.streamed, self.fail, self.args = [], [], None, args or {}

    def model_copy(self, update):
        return self

    async def generate_content_async(self, request, stream=False):
        from google.adk.models import LlmResponse
        from google.genai import types

        self.requests.append(request)
        self.streamed.append(stream)
        if self.fail is not None:
            raise self.fail
        prompt = request.contents[-1].parts[0].text
        args = self.args.get(prompt, {"request": prompt})
        call = types.FunctionCall(name="ask_email_agent", args=args)
        yield LlmResponse(
            content=types.Content(role="model", parts=[types.Part(function_call=call)]),
            finish_reason=types.FinishReason.STOP,
        )


@pytest.fixture
def azure_root(monkeypatch):
    """The real admitted_root over a stub model, with the managed head's own declarations."""
    import asyncio

    from hushh_mcp.one_adk.receipt_client_tools import RECEIPT_TOOL_NAMES
    from scripts import eval_one_azure_first_tool as azure
    from scripts import probe_one_text_root

    root = _StubRoot(args={"anything else important in my inbox today?": {}})
    head = [d for d in harness.build_roster_declarations() if d.name not in RECEIPT_TOOL_NAMES]
    head = [
        d.model_copy(update={"description": "head"}) if d.name == "google_search" else d
        for d in head
    ]

    async def contract():
        return root, "", head

    monkeypatch.setattr(probe_one_text_root, "_root_contract", contract)
    # Production builds its head with model=None, which turns "minimal" into LOW.
    monkeypatch.setenv("HUSHH_ONE_CHAT_THINKING_LEVEL", "minimal")
    monkeypatch.setattr(harness, "CALL_GAP_SECONDS", 0.0)
    return azure, root, head, asyncio.run(azure.admitted_root())


def _follow_ups(azure, admitted):
    from scripts.eval_one_first_tool_context import parse_case

    cases = [parse_case(raw, index) for index, raw in enumerate(_turns().values())]
    call = azure.make_azure_call(admitted)
    return azure.score_suite(cases, lambda case: azure.follow_up(call, _turns()[case.id]), reps=1)


def test_azure_follow_ups_send_the_replayed_turns_with_production_chat_settings(azure_root):
    from google.genai import types

    from hushh_mcp.one_adk.receipt_client_tools import RECEIPT_TOOL_NAMES
    from scripts.eval_one_turn_replay import replayed_contents

    azure, root, head, admitted = azure_root
    results = {result.id: result for result in _follow_ups(azure, admitted)}
    # The argument rules reach the graded call: the dropped request is a named miss.
    assert results["email.followup_second_mail_question"].got_by_rep == [
        "ask_email_agent:args_incomplete"
    ]
    assert {key for key, result in results.items() if result.hit} == {
        "receipts.unanswered_device_call_then_question"
    }
    assert root.streamed == [True] * len(results)
    for case, request in zip(_turns().values(), root.requests, strict=True):
        assert request.model == "one-root-deployment"
        assert request.contents == replayed_contents(case["history"], case["prompt"])
        instruction = request.config.system_instruction
        assert instruction.startswith(harness.production_instruction("typed_chat"))
        assert 'You are an agent. Your internal name is "one".' in instruction
        thinking = request.config.thinking_config
        assert thinking.thinking_level == types.ThinkingLevel.LOW and thinking.include_thoughts
        sent = {d.name: d for d in request.config.tools[0].function_declarations}
        assert RECEIPT_TOOL_NAMES <= set(sent) and sent["google_search"].description == "head"
    with pytest.raises(ValueError, match="drifted"):
        azure.chat_roster(head[1:])
    root.primary_provider = "vertex"
    with pytest.raises(ValueError, match="managed Azure"):
        import asyncio

        asyncio.run(azure.admitted_root())


def test_azure_failures_are_typed_and_live_calls_stay_paced(azure_root, monkeypatch):
    azure, root, _, admitted = azure_root
    root.fail = TimeoutError("synthetic provider outage")
    outage = _follow_ups(azure, admitted)
    assert [result.status for result in outage] == ["infrastructure_error"] + ["unattempted"] * 3
    assert outage[0].infrastructure_failure["error_type"] == "TimeoutError"
    # A model's own undeclared or malformed tool call is a graded miss, never an outage.
    root.fail = ValueError("Invalid Azure output function call")
    assert [result.got_by_rep for result in _follow_ups(azure, admitted)] == [
        ["invalid_tool_call"]
    ] * 4
    root.fail, pauses = None, []
    monkeypatch.setattr(harness, "CALL_GAP_SECONDS", 2.0)
    monkeypatch.setattr(harness.time, "sleep", pauses.append)
    _follow_ups(azure, admitted)
    assert pauses == [2.0] * 4  # The deployment also serves UAT.


def test_the_codec_still_refuses_bad_tool_calls_with_the_messages_the_eval_grades():
    from hushh_mcp.runtime_providers.azure_response_codec import _output_parts
    from scripts.eval_one_azure_first_tool import CODEC_TOOL_CALL_ERRORS

    def refusal(arguments, name="ask_email_agent"):
        item = {"type": "function_call", "name": name, "call_id": "c1", "arguments": arguments}
        with pytest.raises(ValueError) as error:
            _output_parts(
                {"output": [item]},
                allowed_names={"ask_email_agent"},
                preserve_message_phase=False,
                allow_web_search=False,
            )
        return error.value

    assert str(refusal("{}", name="open_cash_drawer")) in CODEC_TOOL_CALL_ERRORS
    assert str(refusal("[]")) in CODEC_TOOL_CALL_ERRORS
    assert isinstance(refusal("{"), json.JSONDecodeError)


def test_cli_routes_case_ids_and_stops_every_suite_after_an_outage(
    azure_root, monkeypatch, tmp_path
):
    azure, root, _, admitted = azure_root

    async def stub_root():
        return admitted

    monkeypatch.setattr(azure, "admitted_root", stub_root)
    flags = ["--reps", "1", "--report-dir", str(tmp_path)]
    only = "receipts.unanswered_device_call_then_question"
    # An id selects only its own fixture, even under --suite all.
    assert azure.main(["--suite", "all", "--case-id", only, *flags]) == 0
    assert len(root.requests) == 1
    report = json.loads((tmp_path / harness.LATEST_REPORT_NAME).read_text())
    assert set(report["case_instructions"]) == {only}
    assert (
        report["case_instructions"][only]["sha256"]
        == hashlib.sha256(harness.production_instruction("typed_chat").encode()).hexdigest()
    )
    assert report["stopped_after_infrastructure_failure"] is None
    root.fail = TimeoutError("synthetic provider outage")
    ids = ["--case-id", "consent.pending_approval", "--case-id", "email.draft_choice_both"]
    assert azure.main(["--suite", "all", *ids, *flags]) == 1
    assert len(root.requests) == 2  # The follow-up suite never asked after the outage.
    with pytest.raises(SystemExit):
        azure.main(["--case-id", "no.such_case", *flags])
