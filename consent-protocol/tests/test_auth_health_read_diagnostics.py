# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Closed, redacted diagnostics for auth-health metadata and Storage reads."""

import http.client
import json
import socket
import ssl
import urllib.error

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
