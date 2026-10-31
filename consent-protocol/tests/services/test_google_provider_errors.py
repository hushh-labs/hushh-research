"""Operator diagnostics for Google provider-configuration refusals.

The classification a user sees is a closed reason. These tests pin the separate,
bounded operator log that names the blocked API and consumer project, and prove
it never records provider message text or unvalidated identifiers.
"""

import json
import logging

import httpx
import pytest

from hushh_mcp.services import google_provider_errors as provider_errors
from hushh_mcp.services.google_provider_errors import classify_google_forbidden_response

LOGGER = "hushh_mcp.services.google_provider_errors"
SECRET_TEXT = "alice@example.com opened gs://private/Quarterly-board-minutes"


@pytest.fixture(autouse=True)
def fresh_log_window():
    provider_errors._logged_at.clear()
    yield
    provider_errors._logged_at.clear()


def forbidden(error: dict) -> httpx.Response:
    body = json.dumps({"error": {"code": 403, **error}}).encode()
    return httpx.Response(403, stream=httpx.ByteStream(body))


def error_info(reason: str, **metadata) -> dict:
    return {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        "reason": reason,
        "domain": "googleapis.com",
        "metadata": metadata,
    }


def blocked(caplog):
    return [r.getMessage() for r in caplog.records if r.name == LOGGER]


async def test_meet_service_disabled_logs_validated_service_and_consumer(caplog):
    caplog.set_level(logging.WARNING, logger=LOGGER)
    response = forbidden(
        {
            "message": SECRET_TEXT,
            "details": [
                error_info(
                    "SERVICE_DISABLED",
                    service="meet.googleapis.com",
                    consumer="projects/123456789012",
                )
            ],
        }
    )

    reason = await classify_google_forbidden_response(
        response, operation="meet.conferenceRecords.recordings"
    )

    assert reason == "provider_configuration"
    assert blocked(caplog) == [
        "google_provider_configuration_blocked "
        "operation=meet.conferenceRecords.recordings "
        "service=meet.googleapis.com consumer=projects/123456789012"
    ]
    assert SECRET_TEXT not in caplog.text


async def test_legacy_drive_shape_yields_consumer_number_and_service_hint_only(caplog):
    caplog.set_level(logging.WARNING, logger=LOGGER)
    response = forbidden(
        {
            "message": f"Google Drive API has not been used in project 987654321098 before. {SECRET_TEXT}",
            "errors": [{"reason": "accessNotConfigured", "domain": "usageLimits"}],
        }
    )

    reason = await classify_google_forbidden_response(
        response,
        strict_drive_retry=True,
        operation="drive.read",
        service_hint="drive.googleapis.com",
    )

    assert reason == "provider_configuration"
    assert blocked(caplog) == [
        "google_provider_configuration_blocked operation=drive.read "
        "service=drive.googleapis.com consumer=projects/987654321098"
    ]
    assert SECRET_TEXT not in caplog.text


@pytest.mark.parametrize(
    "metadata",
    [
        {"service": "evil.example.com", "consumer": "projects/abc"},
        {"service": "meet.googleapis.com\nforged=1", "consumer": "projects/1\nforged=1"},
        {"service": "x" * 500 + ".googleapis.com", "consumer": "projects/" + "9" * 40},
        {"service": ["meet.googleapis.com"], "consumer": {"id": 1}},
    ],
)
async def test_unvalidated_identifiers_are_dropped_not_logged(caplog, metadata):
    caplog.set_level(logging.WARNING, logger=LOGGER)
    response = forbidden({"details": [error_info("SERVICE_DISABLED", **metadata)]})

    reason = await classify_google_forbidden_response(response, operation="meet.spaces")

    assert reason == "provider_configuration"
    assert blocked(caplog) == [
        "google_provider_configuration_blocked operation=meet.spaces service=unknown consumer=unknown"
    ]
    assert "forged" not in caplog.text and "evil.example.com" not in caplog.text


async def test_hostile_operation_name_is_replaced(caplog):
    caplog.set_level(logging.WARNING, logger=LOGGER)
    response = forbidden({"details": [error_info("API_DISABLED")]})

    await classify_google_forbidden_response(response, operation="meet\nforged=1")

    assert blocked(caplog) == [
        "google_provider_configuration_blocked operation=unknown service=unknown consumer=unknown"
    ]


async def test_repeat_refusals_are_logged_once_per_window_and_again_for_new_facts(
    caplog, monkeypatch
):
    caplog.set_level(logging.WARNING, logger=LOGGER)
    clock = {"now": 1000.0}
    monkeypatch.setattr(provider_errors.time, "monotonic", lambda: clock["now"])

    def refused(service):
        return forbidden(
            {"details": [error_info("SERVICE_DISABLED", service=service, consumer="projects/1")]}
        )

    for _ in range(3):
        await classify_google_forbidden_response(
            refused("meet.googleapis.com"), operation="meet.spaces"
        )
    assert len(blocked(caplog)) == 1

    await classify_google_forbidden_response(
        refused("drive.googleapis.com"), operation="drive.read"
    )
    assert len(blocked(caplog)) == 2

    clock["now"] += provider_errors._LOG_INTERVAL_SECONDS + 1
    await classify_google_forbidden_response(
        refused("meet.googleapis.com"), operation="meet.spaces"
    )
    assert len(blocked(caplog)) == 3


async def test_log_key_table_stays_bounded(monkeypatch):
    for index in range(provider_errors._MAX_LOG_KEYS * 3):
        response = forbidden(
            {
                "details": [
                    error_info(
                        "SERVICE_DISABLED",
                        service="meet.googleapis.com",
                        consumer=f"projects/{index}",
                    )
                ]
            }
        )
        await classify_google_forbidden_response(response, operation="meet.spaces")
    assert len(provider_errors._logged_at) <= provider_errors._MAX_LOG_KEYS


@pytest.mark.parametrize(
    "error,expected",
    [
        ({"details": [error_info("ORG_RESTRICTION")]}, "provider_policy"),
        ({"errors": [{"reason": "insufficientFilePermissions"}]}, "resource_denied"),
        ({"errors": [{"reason": "rateLimitExceeded"}]}, "rate_limited"),
    ],
)
async def test_other_refusals_stay_distinct_and_are_not_logged_as_configuration(
    caplog, error, expected
):
    caplog.set_level(logging.WARNING, logger=LOGGER)

    reason = await classify_google_forbidden_response(forbidden(error), operation="meet.spaces")

    assert reason == expected
    assert blocked(caplog) == []


async def test_diagnostic_fields_survive_the_production_log_redactor(caplog):
    """The server masks long underscored arguments; the blocked API must stay readable."""
    from mcp_modules.log_redaction import SensitiveLogFilter

    original = logging.getLogRecordFactory()

    def redacting(*args, **kwargs):
        record = original(*args, **kwargs)
        SensitiveLogFilter().filter(record)
        return record

    logging.setLogRecordFactory(redacting)
    try:
        caplog.set_level(logging.WARNING, logger=LOGGER)
        response = forbidden(
            {
                "details": [
                    error_info(
                        "SERVICE_DISABLED",
                        service="meet.googleapis.com",
                        consumer="projects/123456789012",
                    )
                ]
            }
        )
        await classify_google_forbidden_response(
            response, operation="meet.conferenceRecords.recordings"
        )
    finally:
        logging.setLogRecordFactory(original)

    assert "[REDACTED]" not in caplog.text
    assert "service=meet.googleapis.com" in caplog.text
    assert "consumer=projects/123456789012" in caplog.text
    assert "operation=meet.conferenceRecords.recordings" in caplog.text
