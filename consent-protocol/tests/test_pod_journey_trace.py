"""The 0->1 trace must name the stage that actually broke, and never invent one.

This guards the diagnostic itself. A tracer that mislabels the failing stage is worse
than no tracer: it sends an operator to the wrong plane with a confident answer, which
costs more than an honest "I could not tell".

Two properties matter more than the individual verdicts:

  * **"No row" and "could not read the table" are opposite diagnoses.** The first says
    the journey never started; the second says the tracer is blind. Collapsing them --
    the natural shape if a failed query returns an empty result -- reports "this person
    was never reserved" every time the DB credential is missing, which is a confident
    lie about someone whose pod may be running fine.
  * **"First failure" means first in the JOURNEY, not first observed.** The registry
    stages are answered by one row read and then spliced around the GCP stages, so the
    order results arrive in is not the order they happen in. This is exactly the class
    of ordering bug the merge work kept finding, so it is asserted rather than assumed.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_TRACE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "ops" / "trace_pod_journey.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("trace_pod_journey", _TRACE_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


trace_mod = _load_module()


def _verdicts(trace) -> dict[str, str]:
    return {stage: verdict for stage, verdict, _, _ in trace.rows}


def test_a_missing_row_and_an_unreadable_table_are_different_verdicts(monkeypatch):
    """The distinction the whole diagnosis rests on."""
    monkeypatch.setattr(trace_mod, "_read_registry_row", lambda _id: (None, None))
    missing = trace_mod.Trace()
    trace_mod._trace_registry(missing, "ha1_whoever")

    monkeypatch.setattr(trace_mod, "_read_registry_row", lambda _id: (None, "OSError"))
    blind = trace_mod.Trace()
    trace_mod._trace_registry(blind, "ha1_whoever")

    # A query that ran and matched nothing is a real finding: nothing was reserved.
    assert _verdicts(missing)["1 registry row exists"] == trace_mod.FAIL
    # A query that never ran must never be reported as a finding about the person.
    assert _verdicts(blind)["1 registry row exists"] == trace_mod.SKIP
    assert blind.stopped_at is None, "an unreadable registry must not accuse the journey"


def test_connecting_without_a_key_is_named_as_the_stalled_handshake(monkeypatch):
    """The most likely 0->1 failure, and the one nothing else in the system watches."""
    row = {
        "status": "connecting",
        "backend": "gcp",
        "external_agent_id": "one-pod-ha1-abc",
        "pod_pubkey": None,
        "created_at": "2026-08-12T00:00:00+00:00",
    }
    monkeypatch.setattr(trace_mod, "_read_registry_row", lambda _id: (row, None))
    trace = trace_mod.Trace()
    trace_mod._trace_registry(trace, "ha1_abc")

    verdicts = _verdicts(trace)
    assert verdicts["1 registry row exists"] == trace_mod.PASS
    assert verdicts["2 a host was requested"] == trace_mod.PASS
    assert verdicts["6 pod published its key"] == trace_mod.FAIL
    # The remedy has to point at the two real causes, not merely restate the symptom.
    next_step = next(n for s, _, _, n in trace.rows if s == "6 pod published its key")
    assert "run.invoker" in next_step and "pod.startup" in next_step


def test_a_reserved_row_with_no_host_blames_provisioning_not_the_pod(monkeypatch):
    row = {"status": "pending", "external_agent_id": None, "pod_pubkey": None}
    monkeypatch.setattr(trace_mod, "_read_registry_row", lambda _id: (row, None))
    trace = trace_mod.Trace()
    trace_mod._trace_registry(trace, "ha1_abc")

    assert _verdicts(trace)["2 a host was requested"] == trace_mod.FAIL
    next_step = next(n for s, _, _, n in trace.rows if s == "2 a host was requested")
    assert "autoprovision_failed" in next_step


def test_a_provisioned_row_passes_every_registry_stage(monkeypatch):
    row = {
        "status": "provisioned",
        "backend": "gcp",
        "external_agent_id": "one-pod-ha1-abc",
        "pod_pubkey": "BASE64KEY",
    }
    monkeypatch.setattr(trace_mod, "_read_registry_row", lambda _id: (row, None))
    trace = trace_mod.Trace()
    trace_mod._trace_registry(trace, "ha1_abc")

    assert set(_verdicts(trace).values()) == {trace_mod.PASS}
    assert trace.stopped_at is None


def test_first_failure_is_first_in_journey_order_not_in_record_order():
    """The splice bug this ordering exists to prevent.

    Registry stages are recorded in one pass and then placed AROUND the GCP stages. If
    "first failure" were latched while recording, a stage-6 failure recorded before a
    stage-3 failure would be reported as the cause -- pointing an operator at the pod's
    handshake when the service does not exist at all.
    """
    trace = trace_mod.Trace()
    # Recorded stage-6 first, exactly as the real splice does.
    trace.record("6 pod published its key", trace_mod.FAIL, "recorded first")
    trace.rows.insert(
        0, ("3 cloud run service exists", trace_mod.FAIL, "happens first", "look here")
    )

    assert trace.stopped_at == "3 cloud run service exists"


@pytest.mark.parametrize(
    "hushh_id,expected",
    [("ha1_ABC123", "one-pod-ha1-abc123"), ("ha1_x", "one-pod-ha1-x")],
)
def test_the_service_name_matches_what_the_backend_actually_creates(hushh_id, expected):
    """The trace addresses GCP by name; a divergent derivation would 404 on a live pod."""
    assert trace_mod._service_name_for(hushh_id) == expected
