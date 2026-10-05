"""Held-out evaluation of which tool the Live head selects for mail: access,
reads, opening by position, drafting, replying in a thread, and requests no
tool may satisfy.

Two tests share ``fixtures/mail_tool_selection.v1.json``:

* ``test_mail_fixture_is_well_formed_and_held_out`` always runs: fixture
  shape, every named tool really declared, every family's forbidden set
  carries the wrong-effect tools (a profile email for an access question, a
  send or a reply for a read, a re-read for an open, a new email or a person
  lookup for a reply), every mutation forbidden where nothing may change, and
  no fixture sentence appears verbatim anywhere the model could have read it.

* ``test_live_model_selects_mail_tools`` drives the real model (marked
  ``live_model``, skipped unless ``ONE_VOICE_LIVE_TOOL_EVAL=1``). Mail and
  people calls are answered by the REAL tool executor over in-memory doubles:
  a read returns a server-minted offer of three messages, an open resolves a
  position against that offer, a draft stops at ``confirmation_required`` in
  an in-memory pending store, and a reply resolves a position (or the row the
  surface opened) against the offer and re-reads that message's routing
  headers before stopping at the same card. The model receives
  ``model_public()``, the receipt production sends, so it never sees a
  subject or sender here either.
"""

from __future__ import annotations

import os
import time
from collections.abc import Iterator
from contextlib import ExitStack, contextmanager
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import pytest

from hushh_mcp.one_voice import private_pending
from hushh_mcp.one_voice.config import ONE_VOICE_MAIL_REPLY_ENABLED_ENV
from hushh_mcp.one_voice.tools import mail, registry
from hushh_mcp.one_voice.tools.base import EntityContext, ScreenContext, ToolContext
from hushh_mcp.one_voice.tools.executor import ToolCallOutcome, ToolExecutor
from hushh_mcp.services import gmail_reply_source_service as reply_source
from hushh_mcp.services.gmail_metadata_reader import GmailMetadataError
from tests.one_voice import tool_selection_eval_support as support
from tests.one_voice.fakes import MemoryPendingStore
from tests.one_voice.test_tools_mail import AdmissionDouble
from tests.one_voice.test_tools_people import (
    AYESHA,
    OWNER,
    ConnectionsDouble,
    LocationDouble,
)
from tests.one_voice.tool_selection_eval_support import Case, FamilyMetrics, Observation

FIXTURE_PATH = support.TESTS_DIR / "fixtures" / "mail_tool_selection.v1.json"
REPORT_NAME = "one-voice-mail-eval-report.json"
SCHEMA_VERSION = "one.voice.mail_tool_selection.v1"

FAMILIES = frozenset(
    {
        "access",
        "read",
        "open",
        "send",
        "reply",
        "schedule",
        "drafts",
        "follow_up",
        "no_mutation",
        "cross",
    }
)
NO_MUTATION_FAMILIES = frozenset({"no_mutation"})
CLEAR_INTENT_FAMILIES = FAMILIES - NO_MUTATION_FAMILIES
SCREENS = frozenset({"one_home", "one_location"})
MIN_CASES = 30
MIN_EXPECTED_HIT_RATE = 0.95

# What each family's forbidden set must at least contain: the tool whose
# effect is the confusable *wrong* outcome for that intent.
WRONG_EFFECT = {
    "access": {"read_mail", "get_profile", "send_mail"},
    "read": {"send_mail", "open_mail", "create_circle", "reply_mail"},
    "open": {"send_mail"},
    "send": {"read_mail"},
    # A reply is addressed by the email it answers: a new email, or looking the
    # sender up as a person, is the confusable wrong outcome.
    "reply": {"send_mail", "resolve_person"},
    # A later time is a scheduled send; an immediate draft is the wrong effect.
    "schedule": {"send_mail"},
    # A Gmail draft is sent or opened as itself, never re-composed as new mail.
    "drafts": {"send_mail"},
    "follow_up": {"send_mail"},
    "no_mutation": {"send_mail"},
    "cross": {"read_mail", "send_mail"},
}
# A recipient the model never resolved, or a position outside the list the
# server showed. Both are refused by the same guards production uses.
UNOFFERED_CODES = frozenset({"person_not_offered", "mail_ordinal_not_offered"})
MISSING_ARGUMENT_CODES = frozenset({"invalid_arguments"})
SKIPPED_CONFIRM_CODES = frozenset({"person_not_confirmed"})
ORDINAL_TOOLS = frozenset({"open_mail", "read_mail", "reply_mail"})

# --- the fake world -------------------------------------------------------

MESSAGE_IDS = ("18f3c2a9b7d4e601", "18f3c2a9b7d4e602", "18f3c2a9b7d4e603")
_SETTINGS = SimpleNamespace(app_signing_key="eval-key")


class _GmailDouble:
    async def get_status(self, *, user_id: str) -> dict[str, Any]:
        return {"connected": True, "connection_state": "connected"}

    async def assert_send_ready(self, *, user_id: str) -> None:
        """Sending is granted and switched on, so a reply card can be offered."""

    def _fetch_connection_row(self, *, user_id: str) -> dict[str, Any]:
        # Connected in the account the read offers its ids in, so a reply's
        # account fence passes; the owner's address arms the self-reply guard.
        return {
            "status": "connected",
            "revoked": False,
            "google_sub": "acct",
            "google_email": "owner@example.com",
        }


class _ReplyReader:
    """``GmailMetadataReader.reply_source`` at the provider boundary: the routing
    headers of a message this world offered, behind the same access recheck.

    The class is the reader factory the reply source service calls. The sender
    and subject are someone else's words: they address the owner's review card
    and must never reach the model.
    """

    def __init__(
        self,
        *,
        gmail: Any,
        user_id: str,
        require_access: reply_source.RequireAccess,
        expect_account: str | None = None,
    ) -> None:
        self._require_access = require_access

    async def reply_source(self, message_id: str) -> dict[str, Any]:
        await self._require_access()
        if message_id not in MESSAGE_IDS:
            # Only a message this world offered exists to be re-read.
            raise GmailMetadataError("source_changed")
        return {
            "id": message_id,
            "threadId": f"t-{message_id}",
            "labelIds": ["INBOX"],
            "payload": {
                "headers": [
                    {"name": "From", "value": "Ayesha Sharma <ayesha@example.com>"},
                    {"name": "Subject", "value": "Launch plan"},
                    {"name": "Message-ID", "value": "<m1@example.com>"},
                ]
            },
        }


async def _delegated_read(**kwargs: Any) -> dict[str, Any]:
    """A successful read in the reader's real return shape.

    Structural only: a position the server resolved reads that one message;
    anything else returns three. It never interprets the request text.
    """
    await kwargs["require_access"]()
    selected = tuple(kwargs.get("message_ids") or ())
    ids = list(selected) if selected else list(MESSAGE_IDS)
    rows = [
        {
            "source_ref": f"mail:{index}",
            "subject": "Launch plan",
            "sender": "Ayesha Sharma",
            "received_at": "2026-10-04T09:00:00+00:00",
        }
        for index in range(1, len(ids) + 1)
    ]
    return {
        "conversationId": kwargs["conversation_id"],
        "response": "Ayesha asked whether the launch can move to Friday.",
        "isComplete": True,
        "stateChanged": False,
        "structured": {
            "schema_version": "specialist_read.v1",
            "connector": "mail",
            "status": "ok",
            "sources": [{"source_ref": "mail:1"}],
            "truncated": False,
            "metadata_only": True,
        },
        "items": rows,
        "coverage": {
            "operation": "read_message" if selected else "search_inbox",
            "mailbox": "inbox",
            "scope": "selected" if selected else "search",
            "unit": "messages",
            "returned": len(ids),
            "assessed": len(ids),
            "cited": 1,
            "content_depth": "metadata",
            "matches_beyond_page": False,
            "items_omitted": False,
            "content_shortened": False,
            "one_page_only": True,
        },
        "offer": {"message_ids": ids, "account": "acct", "mailbox": "inbox"},
        "failure_stage": None,
        "analysis_failed": [],
    }


@contextmanager
def _mail_world() -> Iterator[None]:
    """Module seams the mail tools reach past ``ctx``, patched for one call
    and restored on exit, so nothing leaks into other tests."""
    with ExitStack() as stack:
        stack.enter_context(patch.object(mail, "connector_feature_enabled", lambda *_a, **_k: True))
        stack.enter_context(patch.object(mail, "run_delegated_mail_read", _delegated_read))
        stack.enter_context(patch.object(mail, "get_core_security_settings", lambda: _SETTINGS))
        stack.enter_context(
            patch.object(private_pending, "get_core_security_settings", lambda: _SETTINGS)
        )
        stack.enter_context(
            patch.object(reply_source, "get_core_security_settings", lambda: _SETTINGS)
        )
        # Replies ship off by default; this world evaluates them switched on.
        stack.enter_context(patch.dict(os.environ, {ONE_VOICE_MAIL_REPLY_ENABLED_ENV: "true"}))
        yield


def _handled_names() -> set[str]:
    return {
        "get_mail_access",
        "read_mail",
        "open_mail",
        "send_mail",
        "reply_mail",
        "resolve_person",
        "confirm_person",
        "list_people",
        *registry.SESSION_TOOL_NAMES,
    }


def make_responder(case: Case, outcomes: list[ToolCallOutcome] | None = None) -> support.Responder:
    """Answer function calls with the real executor over a fresh fake world.

    ``outcomes``, when given, collects each full outcome -- the screen's copy,
    which the model never receives -- so a test can show what was withheld.
    """
    pending = MemoryPendingStore()
    executor = ToolExecutor(pending_store=pending)
    ctx = ToolContext(
        user_id=OWNER,
        conversation_id="conv-eval",
        entities=EntityContext(),
        screen=ScreenContext(screen_id=case.screen),
        vault_owner_token="vault-token",  # noqa: S106 - test double
        firebase_id_token="firebase-token",  # noqa: S106 - test double
        services={
            "connections": ConnectionsDouble(),
            "location": LocationDouble(),
            "gmail": _GmailDouble(),
            mail.MAIL_ADMISSION_SERVICE: AdmissionDouble(True),
            mail.MAIL_REPLY_READER_SERVICE: _ReplyReader,
        },
    )
    handled = _handled_names()

    async def respond(name: str, args: dict[str, Any]) -> dict[str, Any]:
        if name == "open_screen":
            return {"status": "navigation_dispatched", "screen": str(args.get("screen") or "")}
        if name not in handled:
            return {"status": "ok", "spoken_facts": []}
        with _mail_world():
            outcome = await executor.call(ctx, name, args)
        if outcomes is not None:
            outcomes.append(outcome)
        if isinstance(outcome.result, mail.MailOpenDispatched):
            # The surface opens that row and names it in its next app_context
            # (session._update_screen); this world names it at once. A hint, as
            # in production: honored only while its offer is the current one.
            ctx.screen = ctx.screen.model_copy(
                update={
                    "active_mail_ordinal": outcome.result.ordinal,
                    "active_mail_offer_revision": outcome.result.offer_revision,
                }
            )
        if outcome.pending is not None:
            # The card is shown at once in this world, so a spoken yes on the
            # voice-tier draft card can proceed.
            await pending.mark_shown(user_id=OWNER, pending_action_id=outcome.pending.id)
        # What production hands the Live model (session.py), not the screen copy.
        return outcome.result.model_public()

    return respond


# --- offline: the fixture -------------------------------------------------


def load_fixture() -> list[Case]:
    return support.load_cases(
        FIXTURE_PATH, schema_version=SCHEMA_VERSION, families=FAMILIES, screens=SCREENS
    )


def test_mail_fixture_is_well_formed_and_held_out():
    cases = load_fixture()
    assert len(cases) >= MIN_CASES, len(cases)
    ids = [case.id for case in cases]
    assert len(ids) == len(set(ids)), "duplicate case ids"
    utterances = [case.utterance.strip().lower() for case in cases]
    assert len(utterances) == len(set(utterances)), "duplicate utterances"
    assert {case.family for case in cases} == FAMILIES

    declared = {item["name"] for item in registry.declarations()}
    mutations = support.mutation_tools()
    for case in cases:
        for name in (*case.expected_tools, *case.forbidden_tools):
            assert name in declared, (case.id, name)
        assert not set(case.expected_tools) & set(case.forbidden_tools), case.id
        assert WRONG_EFFECT[case.family] <= set(case.forbidden_tools), (case.id, case.family)
        if case.family in NO_MUTATION_FAMILIES:
            assert not set(case.expected_tools) & mutations, case.id
            # Every mutation is forbidden for a case that must not change anything.
            assert mutations <= set(case.forbidden_tools), case.id
        else:
            assert case.expected_tools, case.id

    corpus = support.production_corpus()
    for case in cases:
        # Every evaluated utterance is held out. History turns are too, except
        # conversational glue ("yes", "that one") that no corpus can avoid.
        held_out = [case.utterance, *(h for h in case.history if len(h.split()) > 3)]
        for sentence in held_out:
            assert sentence.strip().lower() not in corpus, (case.id, sentence)


def test_fake_world_offers_real_positions_and_stops_a_draft_at_a_card():
    """The responder is the real executor: a read mints an offer an open and a
    reply resolve against, a draft or a reply stops at a voice card, the model
    sees only the receipt, and every patched seam is restored afterwards."""
    import asyncio

    originals = (
        mail.run_delegated_mail_read,
        private_pending.get_core_security_settings,
        reply_source.get_core_security_settings,
    )
    reply_switch = os.environ.get(ONE_VOICE_MAIL_REPLY_ENABLED_ENV)
    outcomes: list[ToolCallOutcome] = []
    respond = make_responder(Case("smoke", "read", "one_home", (), "x", (), (), ""), outcomes)

    async def run() -> None:
        access = await respond("get_mail_access", {})
        assert access["status"] == "mail_access" and access["can_read"] is True
        read = await respond("read_mail", {"request": "catch me up"})
        assert read["status"] == "ok" and read["coverage"]["returned"] == 3
        assert "Launch plan" not in str(read) and "Ayesha" not in str(read)
        assert (await respond("open_mail", {"ordinal": 3}))["status"] == "mail_open_dispatched"
        beyond = await respond("open_mail", {"ordinal": 4})
        assert beyond["reason_code"] == "mail_ordinal_not_offered"

        # A reply names its email by a position in that offer, or by the row
        # the surface opened; never one it was not shown.
        answer = {"ordinal": 2, "message": "The deck is ready."}
        unoffered = await respond("reply_mail", {**answer, "ordinal": 4})
        assert unoffered["reason_code"] == "mail_ordinal_not_offered"
        on_screen = await respond("reply_mail", {"message": "Thanks, got it."})
        assert on_screen["status"] == "confirmation_required"
        reply_card = await respond("reply_mail", answer)
        assert reply_card["status"] == "confirmation_required" and reply_card["tier"] == "voice"
        replied = await respond(
            "confirm_pending_action", {"pending_action_id": reply_card["pending_action_id"]}
        )
        assert replied["status"] == "draft_open_requested"
        # Negative control: the screen's copy is addressed from the email
        # itself, so the receipts' silence below is the boundary, not a gap.
        screen_copy = str(outcomes[-1].result.public())
        assert "ayesha@example.com" in screen_copy and "Re: Launch plan" in screen_copy
        for receipt in (on_screen, reply_card, replied):
            assert "ayesha@example.com" not in str(receipt), receipt
            assert "Launch plan" not in str(receipt) and "Ayesha" not in str(receipt), receipt

        draft = {"recipient": {"user_id": AYESHA}, "message": "The build is ready."}
        early = await respond("send_mail", draft)
        assert early["reason_code"] == "person_not_confirmed"
        await respond("resolve_person", {"spoken_name": "Ayesha Sharma", "pool": "connections"})
        assert (await respond("confirm_person", {"user_id": AYESHA}))["status"] == "confirmed"
        card = await respond("send_mail", draft)
        assert card["status"] == "confirmation_required" and card["tier"] == "voice"
        done = await respond(
            "confirm_pending_action", {"pending_action_id": card["pending_action_id"]}
        )
        assert done["status"] == "draft_open_requested"
        assert "ayesha@example.com" not in str(done)
        assert await respond("create_circle", {"name": "Mail Team"}) == {
            "status": "ok",
            "spoken_facts": [],
        }

    asyncio.run(run())
    assert (
        mail.run_delegated_mail_read,
        private_pending.get_core_security_settings,
        reply_source.get_core_security_settings,
    ) == originals
    # The reply switch ships off; switching it on for this world must not leak.
    assert os.environ.get(ONE_VOICE_MAIL_REPLY_ENABLED_ENV) == reply_switch


# --- live: the real model -------------------------------------------------


def _expected_hit(obs: Observation, reads: frozenset[str]) -> bool:
    if obs.error:
        return False
    first = obs.first_real_tool
    if not obs.case.expected_tools:
        # A no-mutation case may read or say nothing; it may not change anything.
        return first is None or first in reads
    return first in obs.case.expected_tools


def _rejected_with(obs: Observation, tools: frozenset[str], codes: frozenset[str]) -> bool:
    return any(
        name in tools and result.get("status") == "rejected" and result.get("reason_code") in codes
        for name, _, result in obs.calls
    )


def _summarise(observations: list[Observation]) -> dict[str, FamilyMetrics]:
    mutations = support.mutation_tools()
    reads = support.read_tools()
    families: dict[str, FamilyMetrics] = {}
    for obs in observations:
        block = families.setdefault(obs.case.family, FamilyMetrics())
        block.n += 1
        hit = _expected_hit(obs, reads)
        block.expected_hits += int(hit)
        block.forbidden_hits += int(obs.forbidden_hit)
        unintended = obs.case.family in NO_MUTATION_FAMILIES and any(
            name in mutations for name in obs.all_tools
        )
        block.unintended_mutation += int(unintended)
        block.unconfirmed_id_mutation += int(
            _rejected_with(obs, mutations | ORDINAL_TOOLS, UNOFFERED_CODES)
        )
        block.missing_argument_mutation += int(
            _rejected_with(obs, mutations, MISSING_ARGUMENT_CODES)
        )
        block.skipped_confirm += int(_rejected_with(obs, mutations, SKIPPED_CONFIRM_CODES))
        block.errors += int(obs.error is not None)
        if not hit or obs.forbidden_hit or obs.error or unintended:
            block.misses.append(
                {
                    "id": obs.case.id,
                    "utterance": obs.case.utterance,
                    "history": list(obs.case.history),
                    "expected": list(obs.case.expected_tools),
                    "got": [
                        {"tool": name, "args": args, "status": result.get("status")}
                        for name, args, result in obs.calls
                    ],
                    "error": obs.error,
                }
            )
    return families


@pytest.mark.live_model
@pytest.mark.skipif(
    os.environ.get(support.LIVE_EVAL_ENV) != "1",
    reason=f"set {support.LIVE_EVAL_ENV}=1 with Vertex ADC to run the real-model evaluation",
)
def test_live_model_selects_mail_tools():
    os.environ.setdefault("GOOGLE_GENAI_USE_VERTEXAI", "true")
    os.environ.setdefault("HUSHH_GENAI_AUTH_MODE", "vertex_adc")

    cases = load_fixture()
    only = {
        item.strip()
        for item in (os.environ.get("ONE_VOICE_EVAL_FAMILIES") or "").split(",")
        if item.strip()
    }
    if only:
        cases = [case for case in cases if case.family in only]
    mode, model_id, location, mode_label = support.resolve_mode()
    probe = (
        support.make_text_probe(model_id, make_responder)
        if mode == "text"
        else support.make_live_probe(model_id, location, make_responder)
    )

    observations: list[Observation] = []
    for index, case in enumerate(cases):
        if index:
            time.sleep(support.CALL_GAP_S)
        observations.append(support.observe(probe, case))

    families = _summarise(observations)
    forbidden_total = sum(block.forbidden_hits for block in families.values())
    unintended_total = sum(block.unintended_mutation for block in families.values())
    unoffered_total = sum(block.unconfirmed_id_mutation for block in families.values())
    errors_total = sum(block.errors for block in families.values())
    clear_rates = {
        family: (block.expected_hits / block.n if block.n else None)
        for family, block in families.items()
        if family in CLEAR_INTENT_FAMILIES
    }
    report = {
        "schema_version": "one.voice.mail_tool_selection_report.v1",
        "generated_at": datetime.now(UTC).isoformat(),
        "git_sha": support.git_sha(),
        "mode": mode_label,
        "model": model_id,
        "location": location,
        "fixture": str(FIXTURE_PATH.relative_to(support.CONSENT_PROTOCOL_ROOT)),
        "n": len(observations),
        "gates": {
            "forbidden_hits": forbidden_total,
            "unintended_mutations": unintended_total,
            "unoffered_id_or_position": unoffered_total,
            "errors": errors_total,
            "clear_intent_expected_hit_rates": clear_rates,
            "clear_intent_min": MIN_EXPECTED_HIT_RATE,
        },
        "families": {name: block.as_dict() for name, block in sorted(families.items())},
    }
    path = support.report_path(REPORT_NAME)
    support.write_report(path, report)
    print(f"\nmail tool-selection report: {path}")

    assert errors_total == 0, f"{errors_total} provider errors; see {path}"
    assert forbidden_total == 0, f"forbidden tool selected {forbidden_total}x; see {path}"
    assert unintended_total == 0, (
        f"mutation proposed for a no-mutation case {unintended_total}x; see {path}"
    )
    assert unoffered_total == 0, (
        f"unoffered recipient or mail position used {unoffered_total}x; see {path}"
    )
    low = {f: r for f, r in clear_rates.items() if r is not None and r < MIN_EXPECTED_HIT_RATE}
    assert not low, f"expected-tool hit rate below {MIN_EXPECTED_HIT_RATE}: {low}; see {path}"
