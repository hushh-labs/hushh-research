# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Closed, redacted diagnostics for auth-health metadata and Storage reads."""

import http.client
import importlib.util
import json
import socket
import ssl
import sys
import urllib.error
from pathlib import Path

import pytest
from test_auth_health_lease_rest import install_lease_http, load_auth_health_job


def valid_metadata(token="ya29." + "K" * 32):
    return [
        (200, {}, b"auth-health-check@hushh-pda-uat.iam.gserviceaccount.com"),
        (
            200,
            {},
            json.dumps(
                {"access_token": token, "token_type": "Bearer", "expires_in": 3600}
            ).encode(),
        ),
    ]


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (socket.gaierror("private-marker"), "dns"),
        (ssl.SSLError("private-marker"), "tls"),
        (TimeoutError("private-marker"), "timeout"),
        (ConnectionError("private-marker"), "connection"),
        (http.client.BadStatusLine("private-marker"), "protocol"),
        (RuntimeError("private-marker"), "other"),
        (
            urllib.error.URLError(socket.gaierror("private-marker")),
            "dns",
        ),
    ],
)
def test_auth_health_exception_diagnostic_uses_closed_type_only(error, expected):
    module = load_auth_health_job()

    diagnostic = module.read_diagnostic("metadata_identity", "transport", error)

    assert diagnostic == ("metadata_identity", "transport", expected)
    assert "private-marker" not in repr(diagnostic)
    assert module.read_diagnostic("unlisted_step", "transport", error) is None
    assert module.read_diagnostic("metadata_identity", "unlisted_kind", error) is None


def test_auth_health_transport_diagnostic_redacts_url_error_and_does_not_retry(monkeypatch, capsys):
    module = load_auth_health_job()
    marker = "private-dns-diagnostic-marker"
    records, queues = install_lease_http(
        monkeypatch,
        module,
        [urllib.error.URLError(socket.gaierror(marker))],
        [],
    )
    store = module.CloudStorageLease("hushh-pda-uat")

    with pytest.raises(module.HealthCommandFailure) as error:
        store.write(b'{"holder":"fixture"}', "0")

    assert error.value.diagnostic == ("metadata_identity", "transport", "dns")
    assert marker not in str(error.value)
    assert len(records["requests"]) == 1
    assert queues == {"metadata": [], "storage": []}

    class FailedLease:
        def __enter__(self):
            raise error.value

        def __exit__(self, *_args):
            return False

    monkeypatch.setattr(module, "lease", lambda _project: FailedLease())
    monkeypatch.setenv("AUTH_HEALTH_PROJECT", "hushh-pda-uat")
    assert module.main() == 2
    output = capsys.readouterr()
    assert output.out == (
        "Auth health check unavailable; stage=lease_claim; reason=read; "
        "read_step=metadata_identity; failure_kind=transport; exception_type=dns\n"
    )
    assert marker not in output.out + output.err


def test_auth_health_metadata_token_parse_diagnostic_never_logs_body(monkeypatch):
    module = load_auth_health_job()
    marker = "private-token-body-marker"
    metadata = [
        (200, {}, b"auth-health-check@hushh-pda-uat.iam.gserviceaccount.com"),
        (200, {}, f'{{"access_token":"{marker}"'.encode()),
    ]
    records, _ = install_lease_http(monkeypatch, module, metadata, [])
    store = module.CloudStorageLease("hushh-pda-uat")

    with pytest.raises(module.HealthCommandFailure) as error:
        store.write(b'{"holder":"fixture"}', "0")

    assert error.value.diagnostic == ("metadata_token", "json_parse", None)
    assert marker not in str(error.value)
    assert not any(row["kind"] == "storage" for row in records["requests"])


@pytest.mark.parametrize(
    ("response_body", "expected_kind", "expected_type"),
    [
        (OSError("private-body-read-marker"), "body_read", "other"),
        (b"private-generation-body-marker", "json_parse", None),
    ],
)
def test_auth_health_generation_read_diagnostics_redact_body_and_exception(
    monkeypatch, response_body, expected_kind, expected_type
):
    module = load_auth_health_job()
    records, _ = install_lease_http(
        monkeypatch,
        module,
        valid_metadata(),
        [(200, {}, response_body)],
    )
    store = module.CloudStorageLease("hushh-pda-uat")

    with pytest.raises(module.HealthCommandFailure) as error:
        store.generation()

    assert error.value.diagnostic == (
        "storage_generation",
        expected_kind,
        expected_type,
    )
    assert "private-" not in str(error.value)
    assert len([row for row in records["requests"] if row["kind"] == "storage"]) == 1


def test_auth_health_lease_body_parse_diagnostic_never_logs_payload(monkeypatch):
    module = load_auth_health_job()
    marker = "private-lease-body-marker"
    body = marker.encode()
    records, _ = install_lease_http(
        monkeypatch,
        module,
        valid_metadata(),
        [
            (200, {}, b'{"generation":"7"}'),
            (
                206,
                {"Content-Range": f"bytes 0-{len(body) - 1}/{len(body)}"},
                body,
            ),
        ],
    )
    store = module.CloudStorageLease("hushh-pda-uat")

    with pytest.raises(module.HealthCommandFailure) as error:
        module._read_exact_lease(store)

    assert error.value.diagnostic == ("storage_lease_body", "json_parse", None)
    assert marker not in str(error.value)
    assert len([row for row in records["requests"] if row["kind"] == "storage"]) == 2


def test_auth_health_storage_status_diagnostic_keeps_only_validated_status(monkeypatch):
    module = load_auth_health_job()
    marker = "private-storage-response-marker"
    records, _ = install_lease_http(
        monkeypatch,
        module,
        valid_metadata(),
        [(403, {"X-Private": marker}, marker.encode())],
    )
    store = module.CloudStorageLease("hushh-pda-uat")

    with pytest.raises(module.HealthCommandFailure) as error:
        store.generation()

    assert error.value.diagnostic == ("storage_generation", "http_status", None)
    assert error.value.http_status == 403
    assert marker not in str(error.value)
    assert records["responses"][-1].read_limits == []


def _load_health_checker():
    path = Path(__file__).resolve().parents[2] / "scripts/ops/verify_secret_list_invariants.py"
    spec = importlib.util.spec_from_file_location("verify_secret_list_invariants", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _configure_health_lists(checker, tmp_path, case):
    config = tmp_path / "protected.json"
    phone_spec = {
        "name": "HUSHH_UAT_PHONE_TEST_NUMBERS",
        "project": "hushh-pda-uat",
        "min_entries": 2,
        "max_shrink": 0,
    }
    other_spec = {
        "name": "HUSHH_OTHER_PROTECTED_LIST",
        "project": "hushh-pda-uat",
        "min_entries": 2,
        "max_shrink": 0,
    }
    tracked_specs = (
        [other_spec]
        if case == "phone-list-unconfigured"
        else []
        if case == "no-tracked-secrets"
        else [phone_spec]
    )
    config.write_text(
        json.dumps({"secrets": tracked_specs}),
        encoding="utf-8",
    )
    checker.CONFIG = config


def _prepare_health_case(monkeypatch, tmp_path, case):
    job = load_auth_health_job()
    checker = _load_health_checker()
    private_marker = "synthetic-private-phone-and-secret-marker"
    _configure_health_lists(checker, tmp_path, case)
    versions = {
        "version-list-unavailable": [],
        "previous-version-unavailable": ["2", "1"],
        "healthy": ["2"],
        "current-version-unavailable": ["2"],
        "protected-list-failed": ["2"],
        "phone-runtime-unavailable": ["2"],
        "health-publication-unavailable": ["2"],
        "runtime-not-requested": ["2"],
        "phone-list-unconfigured": ["2"],
        "no-tracked-secrets": [],
    }[case]
    checker.versions = lambda *_args: versions

    def read(_name, _project, version):
        if case == "current-version-unavailable":
            return None
        if case == "previous-version-unavailable" and version == "1":
            return None
        if case == "protected-list-failed":
            return "+15550000001"
        return f"+15550000001,+15550000002,{private_marker}"

    checker.read = read
    runtime_requested = case not in {
        "runtime-not-requested",
        "phone-list-unconfigured",
        "no-tracked-secrets",
    }
    checker.check_phone_runtime = lambda _project: (
        "unavailable" if case == "phone-runtime-unavailable" else "healthy"
    )
    events = []

    def gcloud(args):
        events.append(json.loads(args[3]))
        return (1 if case == "health-publication-unavailable" else 0), ""

    checker.gcloud = gcloud

    class OwnedLease:
        def __enter__(self):
            return True

        def __exit__(self, *_args):
            return False

    job.lease = lambda _project: OwnedLease()
    monkeypatch.setenv("AUTH_HEALTH_PROJECT", "hushh-pda-uat")
    monkeypatch.setenv(
        "AUTH_PHONE_RUNTIME_HEALTH_ENABLED", "true" if runtime_requested else "false"
    )
    return job, checker, events, private_marker, runtime_requested


@pytest.mark.parametrize(
    ("case", "expected_exit", "expected_status", "expected_reason"),
    [
        ("healthy", 0, "healthy", None),
        ("version-list-unavailable", 2, "unavailable", "version_list_unavailable"),
        ("current-version-unavailable", 2, "unavailable", "current_version_unavailable"),
        ("previous-version-unavailable", 2, "unavailable", "previous_version_unavailable"),
        ("protected-list-failed", 1, "failed", "protected_list_failed"),
        ("phone-runtime-unavailable", 2, "unavailable", "phone_runtime_unavailable"),
        ("health-publication-unavailable", 2, "unavailable", "health_publication_unavailable"),
        ("runtime-not-requested", 0, "healthy", None),
        ("phone-list-unconfigured", 2, "unavailable", "phone_list_unconfigured"),
        ("no-tracked-secrets", 2, "unavailable", "phone_list_unconfigured"),
    ],
)
def test_auth_health_checker_result_is_closed_and_consumed_by_job(
    monkeypatch, capsys, tmp_path, case, expected_exit, expected_status, expected_reason
):
    job, checker, events, private_marker, runtime_requested = _prepare_health_case(
        monkeypatch, tmp_path, case
    )

    def run_checker(args, *, stage, timeout):
        assert stage is job.HealthCommandStage.PROTECTED_LIST_CHECK
        assert timeout == 450
        assert args[-1] == "--health-result-json"
        assert ("--check-phone-runtime" in args) is runtime_requested
        monkeypatch.setattr(sys, "argv", ["verify", *args[2:]])
        assert checker.main() == 0
        output = capsys.readouterr()
        assert output.err == ""
        return output.out.encode()

    job.command = run_checker
    assert job.main() == expected_exit
    output = capsys.readouterr()
    assert f"status={expected_status}" in output.out
    assert private_marker not in output.out + output.err + repr(events)
    if expected_reason is None:
        assert "reason_codes=" not in output.out
    else:
        assert f"reason_codes={expected_reason}" in output.out
    assert len(events) == 1
    event = events[0]
    assert set(event) == {"message", "status", "checked_lists"} | (
        {"runtime_status"} if runtime_requested else set()
    )
    assert event["message"] == "auth.test_allowlist.health"
    assert event["checked_lists"] == (
        0 if case in {"phone-list-unconfigured", "no-tracked-secrets"} else 1
    )


@pytest.mark.parametrize(
    "payload",
    [
        b'{"status":"failed","reason_codes":["unknown_private_value"],"checked_lists":1,"runtime_status":"healthy"}',
        b'{"status":"healthy","reason_codes":["phone_runtime_unavailable"],"checked_lists":1,"runtime_status":"healthy"}',
        b'{"status":"unavailable","reason_codes":["protected_list_failed"],"checked_lists":1,"runtime_status":"healthy"}',
        b'{"status":"healthy","reason_codes":[],"checked_lists":true,"runtime_status":"healthy"}',
        b"{malformed-private-marker",
    ],
)
def test_auth_health_job_rejects_invalid_checker_output_without_echoing_it(
    monkeypatch, capsys, payload
):
    job = load_auth_health_job()

    class OwnedLease:
        def __enter__(self):
            return True

        def __exit__(self, *_args):
            return False

    job.lease = lambda _project: OwnedLease()
    job.command = lambda *_args, **_kwargs: payload
    monkeypatch.setenv("AUTH_HEALTH_PROJECT", "hushh-pda-uat")
    monkeypatch.setenv("AUTH_PHONE_RUNTIME_HEALTH_ENABLED", "true")

    assert job.main() == 2
    output = capsys.readouterr()
    assert output.out == (
        "Auth health check unavailable; stage=protected_list_check; reason=unclassified\n"
    )
    assert b"private-marker" not in output.out.encode() + output.err.encode()
