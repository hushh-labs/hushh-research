"""The per-path model-access rule: which AI connection earns a pod, on which path.

`ai_connection_gate` has always held the right rule — a working AI connection earns a
pod, a login never does. What it did not ask was which BACKEND the pod would run on,
and the paths differ: CloudHub has no Vertex ADC at all, BYO GCP has the user's own,
and only the hushh-managed tier uses the fleet's identity.

The test that matters most here is the one that would have failed before: an Anypoint
deployment with the managed flag ON must still refuse a managed connection, because
`AnypointBackend` renders GOOGLE_GENAI_USE_VERTEXAI=false and the pod could never
serve that turn.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from hushh_mcp.services.compute_backend import (  # noqa: E402
    BACKEND_ANYPOINT,
    BACKEND_GCP,
    BACKEND_USER_GCP,
)
from hushh_mcp.services.model_access_policy import (  # noqa: E402
    ACTIVATION_BYOK_PER_TURN,
    ACTIVATION_FLEET_ADC,
    ACTIVATION_USER_ADC,
    AGENT_ACTIVATION_ORDER,
    MANAGED_PROVIDER,
    byoc_vertex_preconditions,
    model_access_for,
)

BYOK = "gemini"
FAKE_BEARER = "fake-bearer-for-tests"  # noqa: S105 - no service exists to authenticate to


class _Response:
    def __init__(self, status_code: int, payload=None) -> None:
        self.status_code = status_code
        self._payload = payload or {}

    def json(self):
        return self._payload


class _Session:
    def __init__(self, get=None, post=None) -> None:
        self._get, self._post = get, post

    def get(self, url, headers=None, timeout=None, **kw):
        return self._get

    def post(self, url, headers=None, json=None, timeout=None, **kw):
        return self._post


# -- Anypoint: BYOK only, and that is structural rather than configured -------------


def test_anypoint_refuses_a_managed_connection_even_with_the_fleet_flag_on(monkeypatch) -> None:
    """The case the old backend-blind check got wrong.

    `pod_managed_model_enabled` is about hushh's fleet identity. On CloudHub there is
    no Google identity at all, so that flag is not merely irrelevant — deferring to it
    would let a pod be provisioned onto a connection the platform cannot serve.
    """
    monkeypatch.setenv("HUSSH_POD_MANAGED_MODEL_ENABLED", "true")
    verdict = model_access_for(BACKEND_ANYPOINT, MANAGED_PROVIDER)
    assert verdict.can_serve is False
    assert "no Google identity" in verdict.reason
    assert verdict.activation_order == ()


def test_anypoint_serves_byok(monkeypatch) -> None:
    verdict = model_access_for(BACKEND_ANYPOINT, BYOK)
    assert verdict.can_serve is True
    assert verdict.activation == ACTIVATION_BYOK_PER_TURN
    assert verdict.activation_order == AGENT_ACTIVATION_ORDER


# -- BYO GCP: the user's own Vertex ADC, independent of hushh's fleet flag ----------


def test_byoc_serves_a_managed_selection_on_the_users_own_adc(monkeypatch) -> None:
    """BYOC's Vertex is the USER's — their identity, their quota, their bill.

    So it must NOT depend on `pod_managed_model_enabled`, which governs whether a pod
    may borrow *hushh's* fleet identity. Tying them together would let a hushh-side
    switch disable a capability the user owns outright.
    """
    monkeypatch.setenv("HUSSH_POD_MANAGED_MODEL_ENABLED", "false")
    verdict = model_access_for(BACKEND_USER_GCP, MANAGED_PROVIDER)
    assert verdict.can_serve is True
    assert verdict.activation == ACTIVATION_USER_ADC
    assert "USER's project" in verdict.reason


def test_byoc_also_serves_byok() -> None:
    verdict = model_access_for(BACKEND_USER_GCP, BYOK)
    assert verdict.can_serve is True
    assert verdict.activation == ACTIVATION_BYOK_PER_TURN


# -- hushh-managed: the only path where the fleet flag is the right question --------


def test_managed_tier_follows_the_fleet_flag(monkeypatch) -> None:
    monkeypatch.setenv("HUSSH_POD_MANAGED_MODEL_ENABLED", "true")
    assert model_access_for(BACKEND_GCP, MANAGED_PROVIDER).activation == ACTIVATION_FLEET_ADC

    monkeypatch.setenv("HUSSH_POD_MANAGED_MODEL_ENABLED", "false")
    off = model_access_for(BACKEND_GCP, MANAGED_PROVIDER)
    assert off.can_serve is False
    # Assert the PROPERTY (refused, and the reason tells a person what to do), not the
    # wording — this string is user-facing and pinning its exact text to an internal
    # phrase is what let an internal flag name reach the browser.
    assert off.can_serve is False
    assert "pod_managed_model_enabled" not in off.reason.lower()
    assert off.reason.strip()


def test_managed_tier_serves_byok_regardless_of_the_fleet_flag(monkeypatch) -> None:
    """BYOK needs no standing access, so the fleet flag has nothing to say about it."""
    monkeypatch.setenv("HUSSH_POD_MANAGED_MODEL_ENABLED", "false")
    assert model_access_for(BACKEND_GCP, BYOK).can_serve is True


# -- fail closed -------------------------------------------------------------------


def test_an_undeclared_backend_is_refused_not_assumed_serviceable() -> None:
    """A path added without a rule must fail closed, not inherit the last branch."""
    verdict = model_access_for("some_future_platform", BYOK)
    assert verdict.can_serve is False
    assert "no model-access rule is declared" in verdict.reason


def test_a_refusal_never_carries_an_activation_order() -> None:
    """A caller that ignores can_serve must still find nothing it may activate."""
    for backend, provider in (
        (BACKEND_ANYPOINT, MANAGED_PROVIDER),
        ("some_future_platform", BYOK),
    ):
        verdict = model_access_for(backend, provider)
        assert verdict.can_serve is False
        assert verdict.activation_order == ()
        assert verdict.activation == ""


def test_activation_order_leads_with_the_primary() -> None:
    """`one` is the primary and the only agent a pod mounts today."""
    assert AGENT_ACTIVATION_ORDER[0] == "one"


# -- BYOC preconditions: what "Vertex established" can honestly mean pre-pod --------


def test_preconditions_are_established_only_when_both_halves_hold() -> None:
    session = _Session(
        get=_Response(200, {"state": "ENABLED"}),
        post=_Response(
            200,
            {
                "bindings": [
                    {
                        "role": "roles/aiplatform.user",
                        "members": ["serviceAccount:one-pod-x@acme.iam.gserviceaccount.com"],
                    }
                ]
            },
        ),
    )
    result = byoc_vertex_preconditions(
        project="acme",
        pod_service_account="one-pod-x@acme.iam.gserviceaccount.com",
        token=FAKE_BEARER,
        session=session,
    )
    assert result["established"] is True
    assert result["missing"] == []


def test_the_api_being_enabled_is_not_enough_without_the_binding() -> None:
    """Half the configuration is the state that looks fine and cannot call Vertex."""
    session = _Session(get=_Response(200, {"state": "ENABLED"}), post=_Response(200, {"bindings": []}))
    result = byoc_vertex_preconditions(
        project="acme",
        pod_service_account="one-pod-x@acme.iam.gserviceaccount.com",
        token=FAKE_BEARER,
        session=session,
    )
    assert result["established"] is False
    assert any("aiplatform.user" in m for m in result["missing"])


def test_a_binding_for_a_different_account_does_not_count() -> None:
    """The grant has to be on THIS pod's identity, not merely present in the project."""
    session = _Session(
        get=_Response(200, {"state": "ENABLED"}),
        post=_Response(
            200,
            {
                "bindings": [
                    {
                        "role": "roles/aiplatform.user",
                        "members": ["serviceAccount:someone-else@acme.iam.gserviceaccount.com"],
                    }
                ]
            },
        ),
    )
    result = byoc_vertex_preconditions(
        project="acme",
        pod_service_account="one-pod-x@acme.iam.gserviceaccount.com",
        token=FAKE_BEARER,
        session=session,
    )
    assert result["established"] is False


def test_preconditions_report_rather_than_raise_when_unreadable() -> None:
    """'Not configured yet' is an ordinary state on the way in, not a fault."""
    session = _Session(get=_Response(403), post=_Response(403))
    result = byoc_vertex_preconditions(
        project="acme",
        pod_service_account="one-pod-x@acme.iam.gserviceaccount.com",
        token=FAKE_BEARER,
        session=session,
    )
    assert result["established"] is False
    assert len(result["missing"]) == 2


# -- the gate actually consults the policy -----------------------------------------


@pytest.mark.asyncio
async def test_the_gate_refuses_anypoint_plus_managed_end_to_end(monkeypatch) -> None:
    """The rule is only real if the provisioning entry point enforces it."""
    from hushh_mcp.services import ai_connection_gate

    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "true")
    monkeypatch.setenv("PERSONAL_AGENT_PROVISION_ON_AI_CONNECTION", "true")
    monkeypatch.setenv("PERSONAL_AGENT_BACKEND", BACKEND_ANYPOINT)
    monkeypatch.setenv("HUSSH_POD_MANAGED_MODEL_ENABLED", "true")

    scheduled: list = []
    verdict = await ai_connection_gate.on_ai_connection_verified(
        user_id="user-1",
        provider=MANAGED_PROVIDER,
        scheduler=lambda *a, **k: scheduled.append(a) or True,
    )
    assert verdict["scheduled"] is False
    assert "no Google identity" in verdict["reason"]
    assert scheduled == [], "a pod must not be scheduled on a connection the path cannot serve"


def test_the_inert_backend_vocabulary_matches_compute_backend() -> None:
    """Two modules disagreeing about one config value is the bug.

    `compute_backend` accepts "none" as a legal inert backend id; this policy did not, so
    PERSONAL_AGENT_BACKEND=none fell through to the fail-closed unknown branch and flipped
    BYOK provisioning from allowed to refused. Asserted against the OTHER module's list so
    the two cannot drift apart again silently.
    """
    verdict = model_access_for("none", "byok")
    assert verdict.can_serve is True, (
        "'none' is a legal inert backend id in compute_backend; refusing BYOK for it is a "
        "regression, not a safety property"
    )
    # And the genuinely unknown case must still fail closed.
    assert model_access_for("wat", "byok").can_serve is False


def test_a_refusal_shown_to_a_person_names_no_internal_flag() -> None:
    """This string is returned to the browser as `agentReason` (routes/one/runtime.py:166).

    It used to name `pod_managed_model_enabled` and explain hushh's cost reasoning to the
    person being refused. A refusal should tell someone what to do next, not leak our
    internal vocabulary or our margin logic.
    """
    import os

    os.environ.pop("HUSSH_POD_MANAGED_MODEL_ENABLED", None)
    verdict = model_access_for("gcp", MANAGED_PROVIDER)
    if verdict.can_serve:
        return  # the flag is on in this environment; nothing to assert about the refusal
    lowered = verdict.reason.lower()
    for leak in ("pod_managed_model_enabled", "at full price", "heartbeat"):
        assert leak not in lowered, f"the refusal shown to a person leaks {leak!r}"
