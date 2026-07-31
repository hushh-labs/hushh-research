from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from hushh_mcp.services import one_location_event_admission_service as admission
from hushh_mcp.services.one_location_event_admission_service import (
    EventAdmissionError,
    _decode_pass,
    _encode_pass,
)
from scripts.one_location_event_pilot import (
    REPO_ROOT,
    REPO_TMP_ROOT,
    _required_pass_output,
)

NOW = datetime(2026, 7, 31, 10, 0, tzinfo=timezone.utc)
EVENT_ID = "ec01fe7f-780e-4bec-a62a-6a613fa02376"


def _payload(**overrides):
    payload = {
        "iss": "hushh-one-location",
        "aud": "one-location-event-admission",
        "eventId": EVENT_ID,
        "jti": "one-time-opaque-claim",
        "iat": int((NOW - timedelta(minutes=1)).timestamp()),
        "nbf": int((NOW - timedelta(minutes=1)).timestamp()),
        "exp": int((NOW + timedelta(hours=1)).timestamp()),
    }
    payload.update(overrides)
    return payload


def test_signed_event_pass_round_trips_without_exposing_a_secret(monkeypatch):
    monkeypatch.setattr(admission, "APP_SIGNING_KEY", "k" * 64)

    token = _encode_pass(_payload())
    decoded = _decode_pass(token, now=NOW)

    assert decoded["eventId"] == EVENT_ID
    assert decoded["jti"] == "one-time-opaque-claim"
    assert "k" * 32 not in token


def test_tampered_event_pass_fails_closed(monkeypatch):
    monkeypatch.setattr(admission, "APP_SIGNING_KEY", "k" * 64)
    token = _encode_pass(_payload())
    prefix, payload, signature = token.split(".")
    replacement = "A" if signature[0] != "A" else "B"
    tampered = f"{prefix}.{payload}.{replacement}{signature[1:]}"

    with pytest.raises(EventAdmissionError) as exc:
        _decode_pass(tampered, now=NOW)

    assert exc.value.code == "NEARBY_ADMISSION_INVALID"
    assert exc.value.status_code == 404


@pytest.mark.parametrize(
    "overrides",
    [
        {"exp": int((NOW - timedelta(seconds=1)).timestamp())},
        {"nbf": int((NOW + timedelta(minutes=5)).timestamp())},
        {"aud": "another-audience"},
        {"iss": "another-issuer"},
        {"eventId": "not-a-uuid"},
    ],
)
def test_invalid_event_pass_claims_fail_closed(monkeypatch, overrides):
    monkeypatch.setattr(admission, "APP_SIGNING_KEY", "k" * 64)
    token = _encode_pass(_payload(**overrides))

    with pytest.raises(EventAdmissionError) as exc:
        _decode_pass(token, now=NOW)

    assert exc.value.code == "NEARBY_ADMISSION_INVALID"


def test_pass_output_rejects_commit_eligible_repository_path():
    with pytest.raises(ValueError, match="outside the repository"):
        _required_pass_output(REPO_ROOT / "event-passes.json")


def test_pass_output_accepts_ignored_repo_tmp_path():
    expected = REPO_TMP_ROOT / "event-passes.json"

    assert _required_pass_output(expected) == expected


def test_pass_output_accepts_path_outside_repository():
    expected = (REPO_ROOT.parent / "event-passes.json").resolve()

    assert _required_pass_output(expected) == expected
