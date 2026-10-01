"""The Live voice path decides nothing from phrase tables.

Intent selection is the model's, over native function declarations; the host
validates ids, schemas, and authority. This suite proves the circle family
keeps working with every gateway alias and keyword emptied, and that nothing
in ``hushh_mcp.one_voice`` reads an alias table or runs a keyword matcher.
Name/phonetic matching of *entities* (``resolve_circle``/``resolve_person``)
is candidate retrieval over authorized records and is deliberately kept.
"""

from __future__ import annotations

import ast
import asyncio
import json
from pathlib import Path

import pytest

from hushh_mcp.one_voice.tools import circles, registry
from hushh_mcp.one_voice.tools.executor import ToolExecutor
from hushh_mcp.services import action_gateway
from tests.one_voice.fakes import MemoryPendingStore
from tests.one_voice.test_tools_circles import (
    AYESHA,
    FAMILY,
    FakeCircleService,
    make_ctx,
)

ONE_VOICE_ROOT = Path(circles.__file__).resolve().parents[1]
ALIAS_KEYS = ("aliases", "search_keywords")


@pytest.fixture
def emptied_gateway(monkeypatch):
    """Every gateway action with its alias and keyword lists emptied, and a
    trap that fails the test if any alias field is read on the voice path."""
    original = action_gateway.get_action_gateway_action
    reads: list[str] = []

    class Trap(dict):
        def get(self, key, default=None):  # noqa: D401
            if key in ALIAS_KEYS:
                reads.append(key)
            return super().get(key, default)

        def __getitem__(self, key):
            if key in ALIAS_KEYS:
                reads.append(key)
            return super().__getitem__(key)

    def _stripped(action_id):
        entry = original(action_id)
        if entry is None:
            return None
        cleaned = {k: ([] if k in ALIAS_KEYS else v) for k, v in dict(entry).items()}
        return Trap(cleaned)

    monkeypatch.setattr(action_gateway, "get_action_gateway_action", _stripped)
    return reads


def test_circle_tools_bind_and_run_with_every_alias_emptied(emptied_gateway):
    assert registry.validate_gateway_binding() == []
    for tool in circles.TOOLS:
        entry = action_gateway.get_action_gateway_action(tool.gateway_action_id)
        assert entry is not None
        assert dict.__getitem__(entry, "aliases") == []
        assert dict.__getitem__(entry, "search_keywords") == []
    emptied_gateway.clear()  # the check above is this test's own read, not the voice path's

    service = FakeCircleService()
    ctx = make_ctx(service, confirm_family=False)
    executor = ToolExecutor(pending_store=MemoryPendingStore())

    listed = asyncio.run(executor.call(ctx, "list_circles", {}))
    assert listed.result.status == "ok"
    found = asyncio.run(executor.call(ctx, "resolve_circle", {"spoken_name": "family"}))
    assert found.result.status == "single_likely"
    confirmed = asyncio.run(executor.call(ctx, "confirm_circle", {"circle_id": FAMILY}))
    assert confirmed.result.status == "confirmed"
    roster = asyncio.run(
        executor.call(ctx, "list_circle_members", {"circle": {"circle_id": FAMILY}})
    )
    assert roster.result.status == "ok"
    card = asyncio.run(
        executor.call(
            ctx,
            "add_circle_member",
            {"circle": {"circle_id": FAMILY}, "person": {"user_id": AYESHA}},
        )
    )
    assert card.result.status == "confirmation_required" and card.result.tier == "voice"
    # Schema validation and entity guards still stand: they are not aliases.
    bad = asyncio.run(executor.call(ctx, "rename_circle", {"circle": {"circle_id": "Family"}}))
    assert bad.result.status == "rejected" and bad.result.reason_code == "invalid_arguments"
    assert emptied_gateway == [], f"voice path read alias fields: {emptied_gateway}"


def test_mail_analysis_runs_with_every_alias_emptied(emptied_gateway, monkeypatch):
    from hushh_mcp.one_voice.tools import mail
    from hushh_mcp.services.email_delegated_read import run_delegated_mail_read
    from hushh_mcp.services.gmail_personal_information_request_service import (
        SensitiveRequestAssessment,
    )
    from tests.one_voice.test_tools_mail import AdmissionDouble, _ctx
    from tests.services.test_email_delegated_read import _NOW, _analysis_reader

    assert registry.validate_gateway_binding() == []
    for tool in mail.TOOLS:
        entry = action_gateway.get_action_gateway_action(tool.gateway_action_id)
        assert entry is not None
        assert dict.__getitem__(entry, "aliases") == []
        assert dict.__getitem__(entry, "search_keywords") == []
    emptied_gateway.clear()

    reader = _analysis_reader()
    gene_calls = []

    async def gene(**kwargs):
        gene_calls.append(kwargs)
        if kwargs["gene_id"] == "agent_email_read_planner":
            return {
                "operation": "analyze_mail",
                "categories": ["personal_info", "action_items", "meetings"],
                "limit": 12,
            }
        category = json.loads(kwargs["prompt"])["requested_categories"][0]
        if category == "action_items":
            return {
                "findings": [
                    {
                        "category": category,
                        "source_ref": "mail:3",
                        "detail": "Review the proposal by Friday.",
                        "state": "active",
                        "due_at": "2026-09-27T17:00:00-04:00",
                        "event_at": None,
                    }
                ]
            }
        return {
            "findings": [
                {
                    "category": category,
                    "source_ref": "mail:3",
                    "update_refs": ["mail:2"],
                    "detail": "Meeting moved to 4 pm.",
                    "state": "rescheduled",
                    "due_at": None,
                    "event_at": "2026-09-26T16:00:00-04:00",
                }
            ]
        }

    async def assess(row):
        return SensitiveRequestAssessment(
            is_information_request=row["source_ref"] == "mail:1",
            confidence=0.9,
            requested_domains=("identity",) if row["source_ref"] == "mail:1" else (),
            requested_fields=("Address",) if row["source_ref"] == "mail:1" else (),
        )

    async def runner(**kwargs):
        return await run_delegated_mail_read(
            **kwargs,
            gene_runner=gene,
            reader_factory=lambda **_: reader,
            personal_assessor=assess,
            clock=lambda: _NOW,
        )

    monkeypatch.setattr(mail, "run_delegated_mail_read", runner)
    monkeypatch.setattr(mail, "connector_feature_enabled", lambda *_args: True)
    ctx = _ctx(voice_mail_admission=AdmissionDouble(True, True, True))
    result = asyncio.run(
        ToolExecutor(pending_store=MemoryPendingStore()).call(
            ctx,
            "read_mail",
            {
                "request": "Find personal information requests, action items and meetings in my mail."
            },
        )
    )
    assert result.result.status == "ok"
    assert reader.calls[0][0] == "analyze_mail"
    assert result.result.coverage["analysis_failed"] == []
    assert [
        result.result.coverage[f"findings_{category}"]
        for category in ("personal_info", "action_items", "meetings")
    ] == [1, 1, 1]
    assert [call["gene_id"] for call in gene_calls].count("agent_email_read_planner") == 1
    assert [call["gene_id"] for call in gene_calls].count("agent_email_read_analyzer") == 2
    assert emptied_gateway == [], f"voice path read alias fields: {emptied_gateway}"


def _source_files() -> list[Path]:
    return sorted(p for p in ONE_VOICE_ROOT.rglob("*.py") if "__pycache__" not in p.parts)


def test_no_voice_module_reads_alias_tables_or_keyword_matchers():
    forbidden_attrs = {"aliases", "search_keywords"}
    forbidden_calls = {"match_alias", "match_phrase", "match_keywords", "resolve_alias"}
    offenders: list[str] = []
    for path in _source_files():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for node in ast.walk(tree):
            if isinstance(node, ast.Attribute) and node.attr in forbidden_attrs:
                offenders.append(f"{path.name}:{node.lineno} .{node.attr}")
            elif isinstance(node, ast.Constant) and node.value in forbidden_attrs:
                # A subscript like entry["aliases"].
                offenders.append(f"{path.name}:{node.lineno} '{node.value}'")
            elif isinstance(node, ast.Call):
                func = node.func
                name = getattr(func, "id", None) or getattr(func, "attr", None)
                if name in forbidden_calls:
                    offenders.append(f"{path.name}:{node.lineno} {name}()")
    # registry.py documents "No aliases, by construction" in a docstring, which
    # is prose, not a read; ast.Constant only matches string literals used as
    # values, and the docstring is a full sentence.
    assert offenders == [], offenders


def test_projection_carries_no_aliases_for_any_circle_tool():
    projection = registry.projection()
    for tool in projection["tools"]:
        for key in ALIAS_KEYS:
            assert key not in tool, (tool["name"], key)


def test_people_tools_bind_and_run_with_every_alias_emptied(emptied_gateway):
    """The Connections family: search, confirm, read, send, accept/decline,
    cancel and remove all resolve, validate and execute with no gateway alias
    or keyword available anywhere on the path."""
    from hushh_mcp.one_voice.tools import people
    from tests.one_voice.test_tools_people import (
        OWNER,
        REQ_IN,
        REQ_OUT,
        ConnectionsDouble,
        LocationDouble,
    )

    assert registry.validate_gateway_binding() == []
    for tool in people.TOOLS:
        entry = action_gateway.get_action_gateway_action(tool.gateway_action_id)
        assert entry is not None
        assert dict.__getitem__(entry, "aliases") == []
        assert dict.__getitem__(entry, "search_keywords") == []
    emptied_gateway.clear()

    from hushh_mcp.one_voice.tools.base import EntityContext, ScreenContext, ToolContext

    async def prove(token, expected_user_id):
        return "ok"

    ctx = ToolContext(
        user_id=OWNER,
        conversation_id="conv-1",
        entities=EntityContext(),
        screen=ScreenContext(),
        vault_owner_token="vault-token",  # noqa: S106 - test double
        firebase_id_token="proof",  # noqa: S106 - test double
        services={"connections": ConnectionsDouble(), "location": LocationDouble()},
    )
    executor = ToolExecutor(pending_store=MemoryPendingStore(), actor_proof=prove)

    listed = asyncio.run(executor.call(ctx, "list_people", {}))
    assert listed.result.status == "ok"
    found = asyncio.run(
        executor.call(ctx, "resolve_person", {"spoken_name": "Preeti", "pool": "directory"})
    )
    assert found.result.status == "single_likely"
    confirmed = asyncio.run(executor.call(ctx, "confirm_person", {"user_id": "u-preeti"}))
    assert confirmed.result.status == "confirmed"
    card = asyncio.run(executor.call(ctx, "invite_person", {"person": {"user_id": "u-preeti"}}))
    assert card.result.status == "confirmation_required" and card.result.tier == "voice"
    # A spoken yes counts only once the card was shown (that gate is not an alias either).
    asyncio.run(executor.pending.mark_shown(user_id=OWNER, pending_action_id=card.pending.id))
    sent = asyncio.run(
        executor.call(ctx, "confirm_pending_action", {"pending_action_id": card.pending.id})
    )
    assert sent.result.status == "sent"
    accept = asyncio.run(executor.call(ctx, "accept_connection_request", {"request_id": REQ_IN}))
    assert accept.result.status == "confirmation_required"
    cancel = asyncio.run(executor.call(ctx, "cancel_connection_request", {"request_id": REQ_OUT}))
    assert cancel.result.status == "confirmation_required" and cancel.result.tier == "tap"
    # Guards are not aliases: a made-up id and a non-name are refused as such.
    bad = asyncio.run(executor.call(ctx, "remove_connection", {"person": {"user_id": "u-ayesha"}}))
    assert bad.result.reason_code == "person_not_confirmed"
    number = asyncio.run(
        executor.call(
            ctx, "resolve_person", {"spoken_name": "+91 98765 43210", "pool": "directory"}
        )
    )
    assert number.result.reason_code == "identifier_not_a_name"
    assert emptied_gateway == [], f"voice path read alias fields: {emptied_gateway}"


def test_sos_tools_bind_and_run_with_every_alias_emptied(emptied_gateway):
    """The Save My Soul family: status, the prepared trigger card and its
    tap-confirmed execution, the delivery report, the stop card, and the
    emergency-roster guards all resolve, validate and run with no gateway
    alias or keyword available anywhere on the path -- including the newest
    gateway id, read from the catalog rather than spelled here."""
    from hushh_mcp.one_voice.tools import sos
    from hushh_mcp.one_voice.tools.base import EntityContext, ScreenContext, ToolContext
    from tests.one_voice.test_tools_sos import (
        AYESHA,
        OWNER,
        RAVI,
        FakeLocationService,
        _recipient,
    )

    assert registry.validate_gateway_binding() == []
    delivery_id = next(
        tool.gateway_action_id for tool in sos.TOOLS if tool.name == "report_save_my_soul_delivery"
    )
    assert delivery_id.startswith("location.")
    for tool in sos.TOOLS:
        entry = action_gateway.get_action_gateway_action(tool.gateway_action_id)
        assert entry is not None, tool.gateway_action_id
        assert dict.__getitem__(entry, "aliases") == []
        assert dict.__getitem__(entry, "search_keywords") == []
    emptied_gateway.clear()  # the check above is this test's own read, not the voice path's

    service = FakeLocationService()
    service.sms_contact_ids = [AYESHA, RAVI]
    service.recipients = [_recipient(AYESHA, "Ayesha Sharma"), _recipient(RAVI, "Ravi Kumar")]

    async def prove(token, expected_user_id):
        return "ok"

    ctx = ToolContext(
        user_id=OWNER,
        conversation_id="conv-1",
        entities=EntityContext(),
        screen=ScreenContext(screen_id="one_location_sos"),
        vault_owner_token="vault-token",  # noqa: S106 - test double
        firebase_id_token="proof",  # noqa: S106 - test double
        services={"location": service},
    )
    executor = ToolExecutor(pending_store=MemoryPendingStore(), actor_proof=prove)

    status = asyncio.run(executor.call(ctx, "get_save_my_soul_status", {}))
    assert status.result.status == "ready"
    assert [c.display_name for c in status.result.emergency_contacts] == [
        "Ayesha Sharma",
        "Ravi Kumar",
    ]
    # The trigger card is prepared from the live roster ...
    card = asyncio.run(executor.call(ctx, "trigger_save_my_soul", {"note": "car broke down"}))
    assert card.result.status == "confirmation_required" and card.result.tier == "tap"
    assert "Ayesha Sharma and Ravi Kumar" in card.result.summary
    assert service.created == []
    # ... a spoken yes cannot arm it (the store's rule, not an alias) ...
    spoken = asyncio.run(
        executor.call(ctx, "confirm_pending_action", {"pending_action_id": card.pending.id})
    )
    assert spoken.result.status == "tap_required"
    # ... and the tap-confirmed execution arms one grant per ready contact.
    asyncio.run(executor.pending.mark_shown(user_id=OWNER, pending_action_id=card.pending.id))
    row = asyncio.run(
        executor.pending.confirm(
            user_id=OWNER,
            pending_action_id=card.pending.id,
            source="tap",
            receipt_token=card.receipt_token,
        )
    )
    armed = asyncio.run(executor.execute_pending(ctx, row))
    assert armed.result.status == "sos_grants_created"
    assert armed.result.needs == "client_step"
    assert [call["recipient_user_id"] for call in service.created] == [AYESHA, RAVI]
    assert ctx.sos_incident["grant_ids"] == armed.result.grant_ids
    # The delivery report and the stop card run over the same path.
    report = asyncio.run(executor.call(ctx, "report_save_my_soul_delivery", {}))
    assert report.result.status == "sos_not_sent" and report.result.alert_active is True
    stop = asyncio.run(executor.call(ctx, "stop_save_my_soul", {}))
    assert stop.result.status == "confirmation_required" and stop.result.tier == "tap"
    assert service.revoked == []
    # Guards are not aliases: an unconfirmed person is refused as such.
    bad = asyncio.run(executor.call(ctx, "remove_emergency_contact", {"person": {"user_id": RAVI}}))
    assert bad.result.status == "rejected" and bad.result.reason_code == "person_not_confirmed"
    assert emptied_gateway == [], f"voice path read alias fields: {emptied_gateway}"
