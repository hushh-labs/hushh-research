# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Bounded metadata and Cloud Storage lease transport contracts."""

import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

pytestmark = pytest.mark.feature_auth_reliability


def load_auth_health_job():
    path = Path(__file__).resolve().parents[2] / "deploy/observability/auth_health_job.py"
    spec = importlib.util.spec_from_file_location("auth_health_job", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def install_lease_http(monkeypatch, module, metadata_responses, storage_responses):
    queues = {"metadata": list(metadata_responses), "storage": list(storage_responses)}
    records = {"requests": [], "connections": [], "responses": []}

    class FakeResponse:
        def __init__(self, status, headers, body):
            self.status = status
            self.headers = headers
            self.body = body
            self.read_limits = []

        def getheader(self, name):
            return self.headers.get(name)

        def read(self, limit):
            self.read_limits.append(limit)
            if isinstance(self.body, BaseException):
                raise self.body
            return self.body[:limit]

    def connection_type(kind):
        class FakeConnection:
            def __init__(self, host, **kwargs):
                self.kind = kind
                self.host = host
                self.kwargs = kwargs
                records["connections"].append(self)

            def request(self, method, path, body=None, headers=None):
                records["requests"].append(
                    {
                        "kind": self.kind,
                        "host": self.host,
                        "method": method,
                        "path": path,
                        "body": body,
                        "headers": headers or {},
                    }
                )
                response = queues[self.kind].pop(0)
                if isinstance(response, BaseException):
                    raise response
                status, response_headers, response_body = response
                self.response = FakeResponse(status, response_headers, response_body)
                records["responses"].append(self.response)

            def getresponse(self):
                return self.response

            def close(self):
                return None

        return FakeConnection

    monkeypatch.setattr(module.http.client, "HTTPConnection", connection_type("metadata"))
    monkeypatch.setattr(module.http.client, "HTTPSConnection", connection_type("storage"))
    return records, queues


def test_cloud_storage_lease_uses_exact_metadata_identity_and_pinned_generation(
    monkeypatch,
):
    module = load_auth_health_job()
    token = "ya29." + "A" * 32
    email = "auth-health-check@hushh-pda-uat.iam.gserviceaccount.com"
    lease_body = json.dumps({"holder": "a" * 32, "expires": 2000}, separators=(",", ":")).encode()
    metadata = [
        (200, {}, email.encode()),
        (
            200,
            {},
            json.dumps(
                {"access_token": token, "token_type": "Bearer", "expires_in": 3600}
            ).encode(),
        ),
    ]
    storage = [
        (200, {}, b""),
        (200, {}, b'{"generation":"7"}'),
        (
            206,
            {"Content-Range": f"bytes 0-{len(lease_body) - 1}/{len(lease_body)}"},
            lease_body,
        ),
        (204, {}, b""),
    ]
    records, queues = install_lease_http(monkeypatch, module, metadata, storage)
    store = module.CloudStorageLease("hushh-pda-uat")

    store.write(lease_body, "0")
    generation = store.generation()
    assert generation == "7"
    assert store.read(generation) == lease_body
    store.delete(generation)

    assert queues == {"metadata": [], "storage": []}
    metadata_requests = [row for row in records["requests"] if row["kind"] == "metadata"]
    storage_requests = [row for row in records["requests"] if row["kind"] == "storage"]
    assert [row["path"] for row in metadata_requests] == [
        "/computeMetadata/v1/instance/service-accounts/default/email",
        "/computeMetadata/v1/instance/service-accounts/default/token",
    ]
    assert all(row["host"] == "metadata.google.internal" for row in metadata_requests)
    assert all(row["headers"]["Metadata-Flavor"] == "Google" for row in metadata_requests)
    assert [row["method"] for row in storage_requests] == ["POST", "GET", "GET", "DELETE"]
    assert all(row["host"] == "storage.googleapis.com" for row in storage_requests)
    assert all(row["headers"]["Authorization"] == f"Bearer {token}" for row in storage_requests)
    assert all("Proxy-Authorization" not in row["headers"] for row in storage_requests)
    assert "ifGenerationMatch=0" in storage_requests[0]["path"]
    assert storage_requests[0]["body"] == lease_body
    assert "fields=generation" in storage_requests[1]["path"]
    assert "generation=7" in storage_requests[2]["path"]
    assert storage_requests[2]["headers"]["Range"] == "bytes=0-4095"
    assert "ifGenerationMatch=7" in storage_requests[3]["path"]
    tls_connections = [row for row in records["connections"] if row.kind == "storage"]
    assert all(row.kwargs["timeout"] == module.HTTP_TIMEOUT_SECONDS for row in tls_connections)
    assert all(row.kwargs["context"].check_hostname for row in tls_connections)
    assert all(
        row.kwargs["context"].verify_mode == module.ssl.CERT_REQUIRED for row in tls_connections
    )


@pytest.mark.parametrize(
    ("status", "expected_kind"),
    [
        (412, "precondition"),
        (302, "failure"),
        (403, "failure"),
        (404, "failure"),
        (409, "failure"),
        (408, "uncertain"),
        (500, "uncertain"),
    ],
)
def test_cloud_storage_lease_treats_only_http_412_as_contention(monkeypatch, status, expected_kind):
    module = load_auth_health_job()
    token = "ya29." + "B" * 32
    metadata = [
        (200, {}, b"auth-health-check@hushh-pda-uat.iam.gserviceaccount.com"),
        (
            200,
            {},
            json.dumps(
                {"access_token": token, "token_type": "Bearer", "expires_in": 3600}
            ).encode(),
        ),
    ]
    marker = "private-provider-response-marker"
    records, queues = install_lease_http(
        monkeypatch,
        module,
        metadata,
        [(status, {"Location": "https://private.invalid/"}, marker.encode())],
    )
    store = module.CloudStorageLease("hushh-pda-uat")

    expected_type = {
        "precondition": module.LeasePreconditionFailed,
        "failure": module.HealthCommandFailure,
        "uncertain": module.LeaseWriteUncertain,
    }[expected_kind]
    with pytest.raises(expected_type) as error:
        store.write(b'{"holder":"fixture"}', "0")

    assert type(error.value) is expected_type
    assert error.value.stage is module.HealthCommandStage.LEASE_CLAIM
    assert error.value.http_status == status
    if expected_kind == "uncertain":
        assert error.value.reason is module.BoundedFailureReason.UNCLASSIFIED
    assert marker not in str(error.value)
    assert len(records["requests"]) == 3
    assert len([row for row in records["requests"] if row["kind"] == "storage"]) == 1
    assert records["responses"][-1].read_limits == []
    assert queues["storage"] == []


@pytest.mark.parametrize(
    ("email", "token", "metadata_count"),
    [
        ("someone-else@example.invalid", "ya29." + "C" * 32, 1),
        (
            "auth-health-check@hushh-pda-uat.iam.gserviceaccount.com",
            "ya29.safe\r\nAuthorization: Bearer private-marker",
            2,
        ),
    ],
)
def test_cloud_storage_lease_refuses_wrong_identity_or_unsafe_token(
    monkeypatch, email, token, metadata_count
):
    module = load_auth_health_job()
    metadata = [(200, {}, email.encode())]
    if metadata_count == 2:
        metadata.append(
            (
                200,
                {},
                json.dumps(
                    {"access_token": token, "token_type": "Bearer", "expires_in": 3600}
                ).encode(),
            )
        )
    records, queues = install_lease_http(monkeypatch, module, metadata, [])
    store = module.CloudStorageLease("hushh-pda-uat")

    with pytest.raises(module.HealthCommandFailure) as error:
        store.write(b'{"holder":"fixture"}', "0")

    assert error.value.stage is module.HealthCommandStage.LEASE_CLAIM
    assert len(records["requests"]) == metadata_count
    assert not any(row["kind"] == "storage" for row in records["requests"])
    assert "private-marker" not in str(error.value)
    assert queues["storage"] == []


def test_cloud_storage_lease_bounds_api_responses_before_reading(monkeypatch):
    module = load_auth_health_job()
    token = "ya29." + "D" * 32
    metadata = [
        (200, {}, b"auth-health-check@hushh-pda-uat.iam.gserviceaccount.com"),
        (
            200,
            {},
            json.dumps(
                {"access_token": token, "token_type": "Bearer", "expires_in": 3600}
            ).encode(),
        ),
    ]
    records, _ = install_lease_http(
        monkeypatch,
        module,
        metadata,
        [(200, {"Content-Length": "2049"}, b"x" * 2049)],
    )
    store = module.CloudStorageLease("hushh-pda-uat")

    with pytest.raises(module.HealthCommandFailure) as error:
        store.generation()

    assert error.value.stage is module.HealthCommandStage.LEASE_READ
    assert error.value.reason is module.BoundedFailureReason.SIZE
    assert error.value.diagnostic == (
        "storage_generation",
        "body_read",
        None,
    )
    assert records["responses"][-1].read_limits == []


@pytest.mark.parametrize(
    ("content_range", "expected_reason"),
    [(None, "read"), ("bytes 0-4095/4097", "size")],
)
def test_cloud_storage_lease_rejects_unbounded_partial_lease_reads(
    monkeypatch, content_range, expected_reason
):
    module = load_auth_health_job()
    token = "ya29." + "E" * 32
    valid_prefix = json.dumps({"holder": "a" * 32, "expires": 2000}, separators=(",", ":")).encode()
    full_object = valid_prefix + b" " * (module.LEASE_BODY_LIMIT - len(valid_prefix)) + b" "
    bounded_body = full_object[: module.LEASE_BODY_LIMIT]
    assert len(full_object) == module.LEASE_BODY_LIMIT + 1
    metadata = [
        (200, {}, b"auth-health-check@hushh-pda-uat.iam.gserviceaccount.com"),
        (
            200,
            {},
            json.dumps(
                {"access_token": token, "token_type": "Bearer", "expires_in": 3600}
            ).encode(),
        ),
    ]
    response_headers = {"Content-Length": str(len(bounded_body))}
    if content_range is not None:
        response_headers["Content-Range"] = content_range
    records, _ = install_lease_http(
        monkeypatch,
        module,
        metadata,
        [
            (200, {}, b'{"generation":"7"}'),
            (206, response_headers, bounded_body),
        ],
    )
    store = module.CloudStorageLease("hushh-pda-uat")

    with pytest.raises(module.HealthCommandFailure) as error:
        module._read_exact_lease(store)

    assert error.value.stage is module.HealthCommandStage.LEASE_READ
    assert error.value.reason.value == expected_reason
    assert error.value.diagnostic == (
        "storage_range",
        "range_validation",
        None,
    )
    assert len([row for row in records["requests"] if row["kind"] == "storage"]) == 2


def test_cloud_storage_lease_recovers_ambiguous_upload_by_exact_own_readback(monkeypatch):
    module = load_auth_health_job()
    holder = "f" * 32
    monkeypatch.setattr(module.uuid, "uuid4", lambda: SimpleNamespace(hex=holder))
    token = "ya29." + "F" * 32
    email = "auth-health-check@hushh-pda-uat.iam.gserviceaccount.com"
    body = json.dumps({"holder": holder, "expires": 1900}).encode()
    metadata = [
        (200, {}, email.encode()),
        (
            200,
            {},
            json.dumps(
                {"access_token": token, "token_type": "Bearer", "expires_in": 3600}
            ).encode(),
        ),
    ]
    storage = [
        (500, {}, b"private-provider-error"),
        (200, {}, b'{"generation":"7"}'),
        (206, {"Content-Range": f"bytes 0-{len(body) - 1}/{len(body)}"}, body),
        (204, {}, b""),
    ]
    records, queues = install_lease_http(monkeypatch, module, metadata, storage)
    store = module.CloudStorageLease("hushh-pda-uat")

    with module.lease("hushh-pda-uat", storage=store, clock=lambda: 1000) as acquired:
        assert acquired

    requests = [row for row in records["requests"] if row["kind"] == "storage"]
    assert [row["method"] for row in requests] == ["POST", "GET", "GET", "DELETE"]
    assert "generation=7" in requests[2]["path"]
    assert "ifGenerationMatch=7" in requests[3]["path"]
    assert queues == {"metadata": [], "storage": []}


@pytest.mark.parametrize(
    ("status", "expected_status"),
    [(503, "; http_status=503"), ("503", ""), (700, ""), (True, "")],
)
def test_auth_health_job_logs_only_validated_http_status(
    monkeypatch, capsys, status, expected_status
):
    module = load_auth_health_job()

    class FailedLease:
        def __enter__(self):
            raise module.HealthCommandFailure(
                module.HealthCommandStage.LEASE_READ,
                module.BoundedFailureReason.UNCLASSIFIED,
                http_status=status,
                diagnostic=module.read_diagnostic("storage_generation", "http_status"),
            )

        def __exit__(self, *_args):
            return False

    monkeypatch.setattr(module, "lease", lambda _project: FailedLease())
    monkeypatch.setenv("AUTH_HEALTH_PROJECT", "hushh-pda")
    monkeypatch.setenv("AUTH_PHONE_RUNTIME_HEALTH_ENABLED", "false")

    assert module.main() == 2
    output = capsys.readouterr()
    assert output.out == (
        "Auth health check unavailable; stage=lease_read; reason=unclassified"
        f"{expected_status}; read_step=storage_generation; failure_kind=http_status\n"
    )
    assert "private-provider-error" not in output.out + output.err
