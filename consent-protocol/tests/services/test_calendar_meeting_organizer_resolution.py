"""Calendar request eligibility: closed reasons, bounded identity refresh, no disclosure.

These use a scripted pool and identity service, so they prove the decision logic
without a database. The Postgres flow suite proves the real SQL separately.
"""

import logging

import pytest

from api.routes import drive_sharing_owner
from hushh_mcp.services import calendar_organizer_resolution as service
from hushh_mcp.services.actor_identity_service import ActorIdentitySyncUnavailableError
from hushh_mcp.services.calendar_invitations import attendee_status, own_attendee
from hushh_mcp.services.drive_sharing_contract import CALENDAR_REFUSAL_REASONS, DriveSharingError
from tests.helpers.calendar_organizer_fakes import (
    ORGANIZER,
    FakeIdentity,
    FakePool,
    Script,
)

REQUESTER = "requester@example.test"
LOGGER = "hushh_mcp.services.calendar_organizer_resolution"


def event(**overrides):
    base = {
        "organizer": {"email": ORGANIZER},
        "attendees": [
            {"email": ORGANIZER, "organizer": True},
            {"email": REQUESTER, "responseStatus": "accepted"},
        ],
    }
    return {**base, **overrides}


# ---- attendee eligibility --------------------------------------------------------


def test_listed_attendee_matches_case_insensitively():
    attendee, reason = attendee_status(event(), REQUESTER.upper(), raw=True)
    assert reason is None and attendee["responseStatus"] == "accepted"
    assert own_attendee(event(), REQUESTER, raw=True) == attendee


@pytest.mark.parametrize(
    "shape,email,reason",
    [
        (event(), ORGANIZER, "requester_is_organizer"),
        (event(status="cancelled"), REQUESTER, "event_cancelled"),
        (event(attendeesOmitted=True), REQUESTER, "attendees_omitted"),
        (event(attendees=[{"email": "someone@example.test"}]), REQUESTER, "requester_not_listed"),
        (event(attendees=[]), REQUESTER, "requester_not_listed"),
        (event(), "", "requester_not_listed"),
        (
            event(attendees=[{"email": REQUESTER}, {"email": REQUESTER.upper()}]),
            REQUESTER,
            "duplicate_attendee",
        ),
        # A listed organizer flag never makes someone a requesting attendee.
        (
            event(attendees=[{"email": REQUESTER, "organizer": True}]),
            REQUESTER,
            "requester_not_listed",
        ),
    ],
)
def test_each_ineligible_shape_has_its_own_closed_reason(shape, email, reason):
    attendee, refusal = attendee_status(shape, email, raw=True)
    assert attendee is None and refusal == reason
    assert reason in CALENDAR_REFUSAL_REASONS["calendar_attendee_required"]
    assert own_attendee(shape, email, raw=True) is None


def test_snake_case_omission_flag_is_honoured_only_for_summaries():
    summary = event(attendees_omitted=True)
    assert attendee_status(summary, REQUESTER, raw=False)[1] == "attendees_omitted"
    assert attendee_status(summary, REQUESTER, raw=True)[1] is None


@pytest.fixture
def production_log_redaction():
    """Apply the real redactor the way the server does (a log-record factory)."""
    from mcp_modules.log_redaction import SensitiveLogFilter

    original = logging.getLogRecordFactory()

    def redacting(*args, **kwargs):
        record = original(*args, **kwargs)
        SensitiveLogFilter().filter(record)
        return record

    logging.setLogRecordFactory(redacting)
    yield
    logging.setLogRecordFactory(original)


@pytest.fixture
def harness(monkeypatch):
    FakeIdentity.results, FakeIdentity.calls, FakeIdentity.hang = {}, [], False

    def install(script):
        async def get_pool():
            return FakePool(script)

        monkeypatch.setattr(service, "get_pool", get_pool)
        monkeypatch.setattr(service, "ActorIdentityService", FakeIdentity)
        return script

    return install


async def resolve():
    return await service.connected_organizer("requester-user", ORGANIZER)


async def refusal():
    with pytest.raises(DriveSharingError) as caught:
        await resolve()
    return caught.value


# ---- organizer resolution ---------------------------------------------------------


async def test_cached_match_resolves_without_any_refresh(harness):
    script = harness(Script(organizer=[["organizer-user"]]))
    assert await resolve() == "organizer-user"
    assert script.refresh_args is None and script.organizer_queries == 1
    assert FakeIdentity.calls == ["organizer-user"]  # only the final fresh verification


async def test_stale_cache_for_a_connected_organizer_is_refreshed_not_refused(harness):
    """The reported 409: a real, connected organizer whose cached identity was stale."""
    script = harness(
        Script(organizer=[[], ["organizer-user"]], refresh=["stale-organizer-user", "stale-other"])
    )
    FakeIdentity.results["stale-other"] = {"email": "other@example.test", "email_verified": True}

    assert await resolve() == "organizer-user"

    assert script.organizer_queries == 2
    assert FakeIdentity.calls[:2] == ["stale-organizer-user", "stale-other"]
    # Bounded: only the requester's own peers, capped, with the cache's freshness window.
    _, window, limit = script.refresh_args[0], script.refresh_args[1], script.refresh_args[2]
    assert limit == service._PEER_REFRESH_LIMIT and window == 24 * 3600


async def test_dead_peers_cannot_starve_the_peers_behind_them(harness):
    """Unreachable peers keep an old timestamp, so a fixed window re-read them forever
    and never reached the organizer behind them; each round now skips what was tried."""
    dead = [f"stale-dead-{n}" for n in range(service._PEER_REFRESH_LIMIT)]
    # Queries: initial, after the full dead round, then the final read once the
    # short second round (below the limit) ends the pass.
    script = harness(
        Script(organizer=[[], [], ["organizer-user"]], refresh=[*dead, "stale-organizer"])
    )
    for peer in dead:
        FakeIdentity.results[peer] = ActorIdentitySyncUnavailableError()

    assert await resolve() == "organizer-user"

    assert script.refresh_rounds == 2
    assert FakeIdentity.calls.count("stale-organizer") == 1
    assert len(set(FakeIdentity.calls)) == len(FakeIdentity.calls)  # no peer is read twice


async def test_a_pass_stops_as_soon_as_the_organizer_is_proven(harness):
    peers = [f"stale-{n}" for n in range(service._PEER_REFRESH_LIMIT * 2)]
    script = harness(Script(organizer=[[], ["organizer-user"]], refresh=peers))
    assert await resolve() == "organizer-user"
    assert script.refresh_rounds == 1
    assert len(FakeIdentity.calls) == service._PEER_REFRESH_LIMIT + 1


async def test_unread_peers_after_the_round_cap_is_retryable_never_not_connected(harness):
    """More unproven peers than one pass may read means the answer is unknown."""
    many = [f"stale-{n}" for n in range(service._PEER_REFRESH_LIMIT * service._PEER_REFRESH_ROUNDS)]
    script = harness(Script(organizer=[[]], refresh=many, pending=[False]))
    for readiness_call in (resolve, readiness):
        with pytest.raises(DriveSharingError) as caught:
            await readiness_call()
        assert (str(caught.value), caught.value.retryable) == (
            "recipient_verification_unavailable",
            True,
        )
        assert caught.value.diagnostic_reason == "organizer_lookup_incomplete"
    assert script.refresh_rounds == 2 * service._PEER_REFRESH_ROUNDS


async def test_no_stale_peers_means_a_terminal_unresolved_refusal(harness):
    script = harness(Script(organizer=[[]], refresh=[]))
    error = await refusal()
    assert (str(error), error.diagnostic_reason, error.retryable) == (
        "calendar_organizer_unavailable",
        "organizer_unresolved",
        False,
    )
    assert script.organizer_queries == 1


async def test_a_dead_peer_does_not_trap_the_requester_in_retry(harness):
    """Deleted or disabled peers raise the same error as an outage; never retryable."""
    harness(Script(organizer=[[]], refresh=["stale-dead"]))
    FakeIdentity.results["stale-dead"] = ActorIdentitySyncUnavailableError()
    error = await refusal()
    assert (str(error), error.retryable) == ("calendar_organizer_unavailable", False)


async def test_partial_refresh_failure_still_uses_the_peers_that_did_refresh(harness):
    harness(Script(organizer=[[], ["organizer-user"]], refresh=["stale-dead", "stale-live"]))
    FakeIdentity.results["stale-dead"] = ActorIdentitySyncUnavailableError()
    assert await resolve() == "organizer-user"


async def test_two_peers_with_one_verified_email_is_ambiguous_not_guessed(harness):
    harness(Script(organizer=[["peer-a", "peer-b"]]))
    error = await refusal()
    assert (str(error), error.diagnostic_reason) == (
        "calendar_organizer_unavailable",
        "organizer_unresolved",
    )
    assert FakeIdentity.calls == []


@pytest.mark.parametrize("failure", [OSError("connection reset"), TimeoutError()])
async def test_lookup_infrastructure_failure_is_retryable_and_distinct(harness, failure):
    harness(Script(fail_fetch=failure))
    error = await refusal()
    assert (str(error), error.retryable) == ("recipient_verification_unavailable", True)


async def test_refresh_timeout_is_retryable_not_a_no_organizer_verdict(harness, monkeypatch):
    harness(Script(organizer=[[]], refresh=["stale-slow"]))
    FakeIdentity.hang = True
    monkeypatch.setattr(service, "_PEER_REFRESH_SECONDS", 0.01)
    error = await refusal()
    assert (str(error), error.retryable) == ("recipient_verification_unavailable", True)


async def test_fresh_provider_identity_must_still_match_the_organizer(harness):
    harness(Script(organizer=[["organizer-user"]]))
    FakeIdentity.results["organizer-user"] = {
        "email": "renamed@example.test",
        "email_verified": True,
    }
    error = await refusal()
    assert (str(error), error.diagnostic_reason) == (
        "calendar_organizer_unavailable",
        "organizer_unresolved",
    )


async def test_unverified_fresh_email_is_refused_even_when_it_matches(harness):
    harness(Script(organizer=[["organizer-user"]]))
    FakeIdentity.results["organizer-user"] = {"email": ORGANIZER, "email_verified": False}
    assert (await refusal()).diagnostic_reason == "organizer_unresolved"


async def test_a_verified_alias_still_vouches_after_the_primary_email_changed(harness):
    harness(Script(organizer=[["organizer-user"]], alias_verified=True))
    FakeIdentity.results["organizer-user"] = {
        "email": "renamed@example.test",
        "email_verified": True,
    }
    assert await resolve() == "organizer-user"


async def test_provider_outage_on_final_verification_stays_retryable(harness):
    harness(Script(organizer=[["organizer-user"]]))
    FakeIdentity.results["organizer-user"] = ActorIdentitySyncUnavailableError()
    error = await refusal()
    assert (str(error), error.retryable) == ("recipient_verification_unavailable", True)


async def test_operator_log_survives_the_production_redactor_and_names_no_one(
    harness, caplog, production_log_redaction
):
    caplog.set_level(logging.INFO, logger=LOGGER)
    harness(Script(organizer=[[]], refresh=["stale-user-id-123"]))
    await refusal()
    text = caplog.text
    # Legible after redaction: a masked code would make the diagnostic useless.
    assert "[REDACTED]" not in text
    assert "code=calendar.organizer.unavailable" in text
    assert "reason=organizer.unresolved" in text
    assert "outcome=no.active.peer.with.verified.email" in text
    assert "refreshed=1" in text and "refresh_failed=0" in text
    for private in (ORGANIZER, REQUESTER, "stale-user-id-123", "requester-user", "example.test"):
        assert private not in text


async def test_operator_log_counts_peer_evidence_without_naming_anyone(
    harness, caplog, production_log_redaction
):
    """Tells operators why a connected organizer did not match, with counts only."""
    caplog.set_level(logging.INFO, logger=LOGGER)
    script = harness(Script(organizer=[[]], refresh=[]))
    script.evidence = {"active_peers": 27, "unproven_peers": 4, "same_mailbox_other_domain": 1}
    await refusal()
    text = "\n".join(caplog.messages)  # the message only, not the logger or file name
    assert "[REDACTED]" not in text
    assert "active_peers=27" in text and "unproven_peers=4" in text
    assert "same_mailbox_other_domain=1" in text
    named = text.replace("calendar.organizer.unavailable", "").replace("organizer.unresolved", "")
    for private in (ORGANIZER, REQUESTER, "requester-user", "example.test", "organizer"):
        assert private not in named


@pytest.mark.parametrize(
    "script,failure_code",
    [
        (Script(fail_fetch=OSError("reset")), "recipient.verification.unavailable"),
        (Script(organizer=[["peer-a", "peer-b"]]), "calendar.organizer.unavailable"),
    ],
)
async def test_every_refusal_stays_legible_under_the_production_redactor(
    harness, caplog, production_log_redaction, script, failure_code
):
    caplog.set_level(logging.INFO, logger=LOGGER)
    harness(script)
    await refusal()
    assert "[REDACTED]" not in caplog.text and f"code={failure_code}" in caplog.text


# ---- the API boundary -------------------------------------------------------------


@pytest.mark.parametrize(
    "code,reason",
    [
        (code, reason)
        for code, reasons in CALENDAR_REFUSAL_REASONS.items()
        for reason in sorted(reasons)
    ],
)
def test_closed_reasons_reach_the_client_with_a_conflict_status(code, reason):
    http = drive_sharing_owner.sharing_error(DriveSharingError(code, diagnostic_reason=reason))
    assert http.status_code == 409
    assert http.detail["code"] == code and http.detail["reason"] == reason
    assert reason not in http.detail["message"]


@pytest.mark.parametrize(
    "code,reason",
    [
        ("calendar_organizer_unavailable", "organizer@example.test"),
        ("calendar_organizer_unavailable", "no_active_peer_with_verified_email"),
        ("calendar_attendee_required", "organizer_unresolved"),
        ("calendar_organizer_unavailable", None),
        ("recipient_verification_unavailable", "organizer_lookup_unavailable"),
    ],
)
def test_unlisted_or_cross_code_reasons_never_reach_the_client(code, reason):
    http = drive_sharing_owner.sharing_error(DriveSharingError(code, diagnostic_reason=reason))
    assert "reason" not in http.detail


def test_every_reason_the_service_can_raise_is_client_safe():
    emitted = {
        ("calendar_organizer_unavailable", "organizer_missing"),
        ("calendar_organizer_unavailable", "organizer_unresolved"),
        *(
            ("calendar_attendee_required", r)
            for r in (
                attendee_status(event(status="cancelled"), REQUESTER, raw=True)[1],
                attendee_status(event(), ORGANIZER, raw=True)[1],
                attendee_status(event(attendeesOmitted=True), REQUESTER, raw=True)[1],
                attendee_status(event(attendees=[]), REQUESTER, raw=True)[1],
                attendee_status(event(attendees=[{"email": REQUESTER}] * 2), REQUESTER, raw=True)[
                    1
                ],
                "requester_declined",
            )
        ),
    }
    for code, reason in emitted:
        assert reason in CALENDAR_REFUSAL_REASONS[code]


# ---- readiness before Send --------------------------------------------------------


async def readiness():
    return await service.organizer_readiness("requester-user", ORGANIZER)


async def test_an_active_verified_organizer_is_ready(harness):
    script = harness(Script(organizer=[["organizer-user"]]))
    assert await readiness() == "ready"
    assert script.pending_queries == 0  # connected people never read pending requests


async def test_no_connection_and_no_pending_request_is_not_connected(harness):
    script = harness(Script(organizer=[[]], refresh=[], pending=[False]))
    assert await readiness() == "not_connected"
    assert script.pending_queries == 1


async def test_a_pending_connection_request_is_reported_as_pending(harness):
    harness(Script(organizer=[[]], refresh=[], pending=[True]))
    assert await readiness() == "pending"


async def test_pending_counterpart_with_a_stale_cache_is_refreshed_before_deciding(harness):
    script = harness(Script(organizer=[[]], refresh=[], pending=[False, True]))
    script.pending_refresh = ["stale-pending-peer"]
    assert await readiness() == "pending"
    assert FakeIdentity.calls == ["stale-pending-peer"]
    assert script.pending_queries == 2


async def test_unrefreshable_pending_counterpart_is_not_connected_not_retry(harness):
    script = harness(Script(organizer=[[]], refresh=[], pending=[False]))
    script.pending_refresh = ["stale-dead"]
    FakeIdentity.results["stale-dead"] = ActorIdentitySyncUnavailableError()
    assert await readiness() == "not_connected"


@pytest.mark.parametrize(
    "script,expected",
    [
        (Script(organizer=[["peer-a", "peer-b"]]), "unavailable"),  # ambiguous
        (Script(organizer=[["organizer-user"]]), "unavailable"),  # identity changed
    ],
)
async def test_ambiguous_or_changed_identity_is_unavailable_never_connected(
    harness, script, expected
):
    harness(script)
    if script.organizer == [["organizer-user"]]:
        FakeIdentity.results["organizer-user"] = {
            "email": "renamed@example.test",
            "email_verified": True,
        }
    assert await readiness() == expected


@pytest.mark.parametrize("failure", [OSError("connection reset"), TimeoutError()])
async def test_readiness_infrastructure_failure_is_retryable_never_not_connected(harness, failure):
    harness(Script(fail_fetch=failure))
    with pytest.raises(DriveSharingError) as caught:
        await readiness()
    assert (str(caught.value), caught.value.retryable) == (
        "recipient_verification_unavailable",
        True,
    )


async def test_readiness_never_replaces_the_authoritative_refusal(harness):
    """A pending request is advisory only: creating still requires an active connection."""
    harness(Script(organizer=[[]], refresh=[], pending=[True]))
    assert await readiness() == "pending"
    assert (await refusal()).diagnostic_reason == "organizer_unresolved"


async def test_readiness_log_is_count_only_and_survives_the_redactor(
    harness, caplog, production_log_redaction
):
    caplog.set_level(logging.INFO, logger=LOGGER)
    harness(Script(organizer=[[]], refresh=["stale-user-id-123"], pending=[False]))
    assert await readiness() == "not_connected"
    text = caplog.text
    assert "[REDACTED]" not in text and "state=not.connected" in text
    for private in (ORGANIZER, REQUESTER, "stale-user-id-123", "requester-user", "example.test"):
        assert private not in text
