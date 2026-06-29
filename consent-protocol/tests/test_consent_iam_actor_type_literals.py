# tests/test_consent_iam_actor_type_literals.py
"""
Tests for strict Literal["investor", "ria"] validation on persona/actor-type
fields, replacing free-form bounded strings.

Canonical attach points
-----------------------
api.routes.iam.switch_persona
  -> payload: PersonaSwitchRequest (persona: Literal["investor", "ria"])
  -> FastAPI returns HTTP 422 for any value outside the Literal set

api.routes.consent.create_generic_consent_request
  -> payload: GenericConsentRequestCreate
     (requester_actor_type / subject_actor_type: Literal["investor", "ria"])
  -> FastAPI returns HTTP 422 for any value outside the Literal set

Before this change both fields were plain bounded strings (max_length=32/64),
so any caller-supplied string under the length cap was accepted by Pydantic
and only rejected later (if at all) by service-layer string comparisons,
silently mismatching on typos like "Ria" or "investors".
"""

import pytest
from pydantic import ValidationError

from api.routes.consent import GenericConsentRequestCreate
from api.routes.iam import PersonaSwitchRequest


class TestPersonaSwitchRequestLiteral:
    def test_investor_accepted(self):
        assert PersonaSwitchRequest(persona="investor").persona == "investor"

    def test_ria_accepted(self):
        assert PersonaSwitchRequest(persona="ria").persona == "ria"

    def test_invalid_value_rejected(self):
        with pytest.raises(ValidationError):
            PersonaSwitchRequest(persona="admin")

    def test_case_mismatch_rejected(self):
        with pytest.raises(ValidationError):
            PersonaSwitchRequest(persona="Investor")

    def test_empty_string_rejected(self):
        with pytest.raises(ValidationError):
            PersonaSwitchRequest(persona="")


class TestGenericConsentRequestActorTypeLiteral:
    def _base(self, **overrides) -> dict:
        base = {"subject_user_id": "user-1", "scope_template_id": "template-1"}
        return {**base, **overrides}

    def test_default_actor_types(self):
        r = GenericConsentRequestCreate(**self._base())
        assert r.requester_actor_type == "ria"
        assert r.subject_actor_type == "investor"

    def test_explicit_valid_actor_types_accepted(self):
        r = GenericConsentRequestCreate(
            **self._base(requester_actor_type="investor", subject_actor_type="ria")
        )
        assert r.requester_actor_type == "investor"
        assert r.subject_actor_type == "ria"

    def test_invalid_requester_actor_type_rejected(self):
        with pytest.raises(ValidationError):
            GenericConsentRequestCreate(**self._base(requester_actor_type="developer"))

    def test_invalid_subject_actor_type_rejected(self):
        with pytest.raises(ValidationError):
            GenericConsentRequestCreate(**self._base(subject_actor_type="admin"))
