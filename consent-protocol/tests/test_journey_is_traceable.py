"""Every stage of the 0->1 journey must be attributable to ONE person.

THE DEFECT THIS GUARDS
----------------------
Every log line along the provisioning path used to emit ``hushh_id_present=True`` --
a boolean. It reads like a privacy control and is not one: the HusshID is documented
by ``personal_agent_identity_service`` as "the OPAQUE public handle", it is already
the A2A route ``/u/{hushh_id}``, and it is already this pod's Cloud Run service name
``one-pod-<hushh_id>``. So the value was in the URL and in the GCP resource name while
being redacted from the log line that needed it.

What the boolean cost was the ability to join anything. On a shared dev lane two
signups produce byte-identical lines:

    personal_agent.connecting hushh_id_present=True backend=gcp
    personal_agent.connecting hushh_id_present=True backend=gcp

Neither can be tied to a registry row, to ``one-pod-...`` in Cloud Run, or to the
pod's own logs. Every component was instrumented; the JOURNEY was not traceable, which
is the same shape as a feature whose parts all pass while the whole never runs.

These tests assert the join key, not the log text. They are deliberately about the
presence of a correlatable identifier at each hop rather than any particular wording,
so ordinary edits to a message do not fail them and removing the identity does.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[1]

# One entry per hop the journey crosses. If a hop cannot be tied back to a person,
# a failure there is undiagnosable no matter how loudly it is logged.
_TRACEABLE_HOPS: list[tuple[str, str]] = [
    ("the signup hook that starts everything", "hushh_mcp/services/actor_identity_service.py"),
    ("the provisioning orchestrator", "hushh_mcp/services/personal_agent_provisioning_service.py"),
    ("the retry / reap sweep", "hushh_mcp/services/personal_agent_reconcile_worker.py"),
    ("the pod's own startup", "pod_server.py"),
    ("the status poll that drives the handshake", "api/routes/one/personal_agent.py"),
]


@pytest.mark.parametrize(("name", "rel"), _TRACEABLE_HOPS, ids=[h[1] for h in _TRACEABLE_HOPS])
def test_the_hop_logs_a_correlatable_identity(name: str, rel: str) -> None:
    body = (_BACKEND / rel).read_text(encoding="utf-8")
    assert "hushh_id=%s" in body, (
        f"{rel} logs no correlatable identity, so a failure at {name} cannot be tied "
        "to a person, a registry row, or a Cloud Run service.\n\n"
        "The HusshID is the opaque PUBLIC handle -- it is already the A2A route and "
        "the pod's service name -- so logging it reveals nothing that the "
        "infrastructure plane does not already show, and withholding it costs the "
        "only key that joins the hub's story to the pod's."
    )


def test_no_hop_reverts_to_a_presence_boolean() -> None:
    """The specific regression: a value replaced by a bit that answers nothing.

    Scoped to the journey files. ``hushh_id_present`` remains legitimate elsewhere --
    ``pod_memory_service`` uses it to report a CONFIGURATION state ("identity or key
    missing"), where the question really is presence and there is no journey to join.
    """
    offenders = [
        rel for _, rel in _TRACEABLE_HOPS if "hushh_id_present" in (_BACKEND / rel).read_text()
    ]
    assert not offenders, (
        f"{offenders} went back to logging a presence bit. Two people's journeys then "
        "produce identical lines and neither can be traced."
    )


def test_the_handshake_stall_is_detected_somewhere() -> None:
    """`connecting` is the one state no sweep watches, so it must be watched here.

    ``fetch_stalled_agents`` deliberately excludes ``connecting`` -- re-running
    provision against a row whose host is live would replace a running service. That
    is correct, and it leaves the state with no owner: if the pod never publishes its
    key the row sits there forever and nothing reports a fault. The status poll is
    where the person is already waiting, so it is where the stall has to be noticed.
    """
    body = (_BACKEND / "api/routes/one/personal_agent.py").read_text(encoding="utf-8")
    assert "handshake_overdue" in body, (
        "nothing detects a row parked in `connecting`. The retry sweep excludes it by "
        "design, so without this the most likely 0->1 failure -- host created, key "
        "never published -- is completely silent."
    )
    # And it must stay an observation. Anything that wrote to the row here would risk
    # replacing a live host, which is the exact reason the sweep leaves it alone.
    detector = body[body.index("def _warn_if_handshake_is_overdue") :]
    detector = detector[: detector.index("\n\nasync def ")]
    for mutation in ("upsert(", "_record(", "delete(", "provision("):
        assert mutation not in detector, (
            f"the overdue detector calls {mutation} -- it must only OBSERVE. A row in "
            "`connecting` has a live host mid-handshake."
        )


def test_the_key_collection_failure_names_the_pod_it_failed_on() -> None:
    """The most important failure in the journey, and it used to log only a class name.

    The line MOVED when the status GET became a pure reader: collection now
    happens at the pod's first heartbeat (the primary site) and in the reconcile
    worker's fallback for rows a heartbeat never reached. The contract follows
    the collection, not the file -- every site that calls the collector must
    report the pod and the reason on failure, because `err=ClientResponseError`
    names neither, and that was the entire content of this line the last time an
    operator needed it. The old home is asserted CLEAN so the line cannot
    quietly resurrect alongside the consent-minting read it used to ride on.
    """
    collection_sites = (
        _BACKEND / "api/routes/one/pod_heartbeat.py",
        _BACKEND / "server.py",
    )
    # re.DOTALL because both sites split the format string across source lines;
    # the runtime string is one line either way.
    pattern = re.compile(r'"personal_agent\.key_collection_failed.*?detail=%s"', re.DOTALL)
    for site in collection_sites:
        body = site.read_text(encoding="utf-8")
        match = pattern.search(body)
        assert match, f"the key-collection failure log line is gone from {site.name}"
        line = " ".join(match.group(0).split())
        for field in ("hushh_id=%s", "service=%s", "detail=%s"):
            assert field in line, (
                f"{site.name}: key_collection_failed does not report {field}. "
                "`err=ClientResponseError` names neither the pod nor the reason, "
                "which is what this line said for the single most important "
                "failure of the onboarding journey."
            )

    pure_reader = (_BACKEND / "api/routes/one/personal_agent.py").read_text(encoding="utf-8")
    assert "collect_pod_key_if_pending(" not in pure_reader, (
        "the status GET is collecting keys again -- it minted a standing pkm.read "
        "per poll per tab the last time it did this"
    )
