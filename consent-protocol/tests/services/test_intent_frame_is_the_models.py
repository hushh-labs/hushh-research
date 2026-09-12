"""A keyword classifier may inform the intent frame. It may not decide it.

`_sanitize_intent_frame` starts from `_fallback_intent_frame` -- a keyword and
regex classifier -- and adopts each field the model returned that is valid for
its enum. That first block was always right. Seven rules after it were not:
they let the fallback overwrite `save_class`, `intent_class` and
`mutation_intent` outright, and not one of them consulted the model's own
confidence, only the fallback's.

The widest fired whenever the fallback scored >= 0.73 AND disagreed with the
model -- disagreement was its trigger condition, resolved in the rule's favour
every time. Measured 2026-09-11 on "I sleep badly when I eat late.": the intent
agent returns `health` at 0.93, the classifier says `preference` at 0.76, and
the frame recorded `preference`. That is how a sleep observation ends up
shelved beside a coffee order.

This is the first shape named in AGENTS.md principle 9: a rule that DECIDES
INSTEAD OF the model. These tests hold the repaired boundary, including its one
deliberate exception.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.pkm_agent_lab_service import PKMAgentLabService
from tests.services.test_pkm_agent_lab_service import _registry_choices

GUARD = {"routing_decision": "non_financial_or_ephemeral"}
DOMAINS = ["food", "health", "location"]


def _fallback(message: str) -> dict:
    return PKMAgentLabService._fallback_intent_frame(
        message=message,
        current_domains=DOMAINS,
        registry_choices=_registry_choices(),
        financial_guard=GUARD,
    )


def _model(intent_class: str, *, mutation_intent: str = "create", confidence: float = 0.93) -> dict:
    return {
        "save_class": "durable",
        "intent_class": intent_class,
        "mutation_intent": mutation_intent,
        "requires_confirmation": False,
        "confirmation_reason": "",
        "candidate_domain_choices": [{"domain_key": "health", "recommended": True}],
        "confidence": confidence,
        "source_agent": "memory_intent_agent",
        "contract_version": 1,
    }


def _frame(message: str, raw: dict | None) -> dict:
    return PKMAgentLabService._sanitize_intent_frame(
        message=message,
        raw=raw,
        fallback=_fallback(message),
        registry_choices=_registry_choices(),
        current_domains=DOMAINS,
    )


class TestTheModelClassifies:
    def test_the_rule_no_longer_refiles_a_health_signal_as_a_preference(self):
        message = "I sleep badly when I eat late."
        # The precondition: the rule genuinely disagrees, and used to win.
        assert _fallback(message)["intent_class"] == "preference"
        assert _frame(message, _model("health"))["intent_class"] == "health"

    @pytest.mark.parametrize(
        "message, model_class",
        [
            ("I prefer espresso without sugar.", "preference"),
            ("Remind me to renew my Costco membership.", "task_or_reminder"),
            ("I sleep badly when I eat late.", "health"),
            ("My student loan is at 6.8% and I want it gone in three years.", "plan_or_goal"),
        ],
    )
    def test_the_models_class_is_what_is_recorded(self, message, model_class):
        assert _frame(message, _model(model_class))["intent_class"] == model_class

    def test_a_mutation_intent_the_model_chose_is_not_rewritten(self):
        message = "I prefer espresso without sugar."
        frame = _frame(message, _model("preference", mutation_intent="extend"))
        assert frame["mutation_intent"] == "extend"


class TestTheRuleStillAnswersWhenNobodyElseDid:
    def test_no_model_answer_leaves_the_rule_in_charge(self):
        # Principle 9's stated exception. A fallback on a failed call is not a
        # boundary violation, it is the only judgement that exists.
        message = "I sleep badly when I eat late."
        assert _frame(message, None)["intent_class"] == "preference"

    def test_an_empty_model_answer_counts_as_no_answer(self):
        message = "I sleep badly when I eat late."
        assert _frame(message, {})["intent_class"] == "preference"


class TestTheOneDeliberateException:
    def test_an_explicit_correction_still_survives_a_model_no_op(self):
        """The guard that stays ungated, and why.

        `test_obvious_location_correction_recovers_from_model_no_op` is the
        end-to-end version. A correction the model shrugged at is the person's
        own record left wrong, silently -- nothing tells them the update did
        not land. That is data integrity, which principle 9 and
        backend-semantic-boundary.md both place outside this doctrine, the way
        a security guard sits outside it.

        It is a guard, not a preference: it only ever fires toward `correct`
        or `delete`, never to reclassify an ordinary note.
        """
        message = "Actually I live in New York City now."
        fallback = _fallback(message)
        assert fallback["mutation_intent"] in {"correct", "delete"}, fallback["mutation_intent"]

        frame = PKMAgentLabService._sanitize_intent_frame(
            message=message,
            raw=_model("ambiguous", mutation_intent="no_op"),
            fallback=fallback,
            registry_choices=_registry_choices(),
            current_domains=DOMAINS,
        )
        assert frame["mutation_intent"] == fallback["mutation_intent"]


class TestTheDisagreementIsVisible:
    def test_a_suppressed_rule_is_logged_by_name(self, caplog):
        # A rule that loses silently is as unmeasurable as one that wins
        # silently, and the disagreement rate is the number that says whether
        # the prompt needs work or the rule deserves to come back.
        with caplog.at_level("INFO"):
            _frame("I sleep badly when I eat late.", _model("health"))
        logged = " ".join(record.getMessage() for record in caplog.records)
        assert "pkm_intent_rule_suppressed" in logged
        assert "fallback_disagreement_override" in logged

    def test_nothing_is_logged_when_the_rule_and_the_model_agree(self, caplog):
        with caplog.at_level("INFO"):
            _frame("I prefer espresso without sugar.", _model("preference"))
        logged = " ".join(record.getMessage() for record in caplog.records)
        assert "fallback_disagreement_override" not in logged
