#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hussh
"""Run the existing protected-list check once under an expiring conditional lease."""

import http.client
import json
import os
import re
import ssl
import sys
import tempfile
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import quote, urlencode

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "deploy/observability"))
sys.path.insert(0, str(ROOT / "scripts/ci"))
from auth_health_read_diagnostics import (  # noqa: E402
    BoundedFailureReason,
    HealthCommandFailure,
    HealthCommandStage,
    read_diagnostic,
    summarize_health_outcome,
)
from process_group import BoundedReadError, bounded_stdout  # noqa: E402

PROJECTS = {"hushh-pda-uat", "hushh-pda"}
LEASE_SECONDS = 900  # Greater than the job's hard 600-second task timeout.
METADATA_HOST = "metadata.google.internal"
STORAGE_HOST = "storage.googleapis.com"
LEASE_OBJECT = "lease.json"
LEASE_BODY_LIMIT = 4096
HTTP_TIMEOUT_SECONDS = 10
TLS_CA_BUNDLE_PATH = "/etc/ssl/certs/ca-certificates.crt"


def _verified_tls_context() -> ssl.SSLContext:
    context = ssl.create_default_context(cafile=TLS_CA_BUNDLE_PATH)
    ca_count = context.cert_store_stats().get("x509_ca")
    if (
        type(ca_count) is not int
        or ca_count < 1
        or context.verify_mode != ssl.CERT_REQUIRED
        or context.check_hostname is not True
    ):
        raise ValueError("Default TLS trust configuration is unavailable")
    return context


class LeasePreconditionFailed(HealthCommandFailure):
    """Storage refused the exact generation precondition."""

    def __init__(self, stage: HealthCommandStage, http_status: int = 412):
        super().__init__(
            stage, BoundedFailureReason.UNCLASSIFIED, http_status=http_status
        )


class LeaseWriteUncertain(HealthCommandFailure):
    """A POST response was lost and requires exact readback of our holder."""

    def __init__(
        self,
        stage: HealthCommandStage,
        reason: BoundedFailureReason,
        http_status: int | None = None,
    ):
        super().__init__(stage, reason, http_status=http_status)


def _read_failure(
    stage, reason, read_step, failure_kind, error=None, http_status=None
):
    return HealthCommandFailure(
        stage,
        reason,
        http_status=http_status,
        diagnostic=read_diagnostic(read_step, failure_kind, error),
    )


def _range_failure(reason):
    return _read_failure(
        HealthCommandStage.LEASE_READ, reason, "storage_range", "range_validation"
    )


def command(
    args: list[str], *, stage: HealthCommandStage, timeout: int = 45, limit: int = 65536
) -> bytes:
    if not isinstance(stage, HealthCommandStage):
        raise ValueError("Unclassified health command stage")
    try:
        return bounded_stdout(args, max_bytes=limit, timeout=timeout)
    except BoundedReadError as exc:
        try:
            reason = BoundedFailureReason(exc.reason)
        except (TypeError, ValueError):
            reason = BoundedFailureReason.UNCLASSIFIED
        raise HealthCommandFailure(stage, reason, exitcode=exc.exitcode) from None
    except OSError:
        raise HealthCommandFailure(
            stage, BoundedFailureReason.UNCLASSIFIED
        ) from None


def _bounded_http_body(
    response, limit: int, stage: HealthCommandStage, read_step=None
) -> bytes:
    content_length = response.getheader("Content-Length")
    if content_length is not None:
        if not content_length.isdecimal() or int(content_length) > limit:
            raise _read_failure(stage, BoundedFailureReason.SIZE, read_step, "body_read")
    try:
        body = response.read(limit + 1)
    except TimeoutError as exc:
        raise _read_failure(stage, BoundedFailureReason.TIMEOUT, read_step, "body_read", exc) from None
    except (OSError, http.client.HTTPException) as exc:
        raise _read_failure(stage, BoundedFailureReason.READ, read_step, "body_read", exc) from None
    if len(body) > limit:
        raise _read_failure(stage, BoundedFailureReason.SIZE, read_step, "body_read")
    return body


class CloudStorageLease:
    """Direct, bounded Cloud Run metadata and Cloud Storage JSON lease access."""

    def __init__(self, project: str):
        if project not in PROJECTS:
            raise ValueError("Ungoverned health project")
        self.project = project
        self.bucket = f"{project}-auth-health-ops"
        self.object_path = f"/storage/v1/b/{quote(self.bucket, safe='')}/o/{quote(LEASE_OBJECT, safe='')}"
        self._access_token: str | None = None

    def _metadata(
        self, path: str, stage: HealthCommandStage, limit: int, read_step: str
    ) -> bytes:
        connection = http.client.HTTPConnection(
            METADATA_HOST, timeout=HTTP_TIMEOUT_SECONDS
        )
        try:
            connection.request(
                "GET",
                path,
                headers={"Metadata-Flavor": "Google", "Accept": "application/json"},
            )
            response = connection.getresponse()
            if response.status != 200:
                raise _read_failure(
                    stage,
                    BoundedFailureReason.UNCLASSIFIED,
                    read_step,
                    "http_status",
                    http_status=response.status,
                )
            return _bounded_http_body(response, limit, stage, read_step)
        except HealthCommandFailure:
            raise
        except TimeoutError as exc:
            raise _read_failure(stage, BoundedFailureReason.TIMEOUT, read_step, "transport", exc) from None
        except (OSError, http.client.HTTPException) as exc:
            raise _read_failure(stage, BoundedFailureReason.READ, read_step, "transport", exc) from None
        finally:
            connection.close()

    def _token(self, stage: HealthCommandStage) -> str:
        if self._access_token is not None:
            return self._access_token
        try:
            email = self._metadata(
                "/computeMetadata/v1/instance/service-accounts/default/email",
                stage,
                256,
                "metadata_identity",
            ).decode("ascii")
        except UnicodeDecodeError:
            raise HealthCommandFailure(
                stage, BoundedFailureReason.UNCLASSIFIED
            ) from None
        expected = f"auth-health-check@{self.project}.iam.gserviceaccount.com"
        if email != expected:
            raise HealthCommandFailure(stage, BoundedFailureReason.UNCLASSIFIED)
        token_response = self._metadata(
            "/computeMetadata/v1/instance/service-accounts/default/token",
            stage,
            8192,
            "metadata_token",
        )
        try:
            token_data = json.loads(token_response)
        except (UnicodeDecodeError, ValueError):
            raise _read_failure(
                stage, BoundedFailureReason.UNCLASSIFIED, "metadata_token", "json_parse"
            ) from None
        token = token_data.get("access_token") if isinstance(token_data, dict) else None
        if (
            not isinstance(token, str)
            or not re.fullmatch(r"[A-Za-z0-9._~+/-]{20,4094}={0,2}", token)
            or token_data.get("token_type") != "Bearer"
            or type(token_data.get("expires_in")) is not int
            or token_data["expires_in"] <= 0
        ):
            raise HealthCommandFailure(stage, BoundedFailureReason.UNCLASSIFIED)
        self._access_token = token
        return token

    def _storage_request(
        self,
        method: str,
        path: str,
        *,
        stage: HealthCommandStage,
        accepted_statuses: tuple[int, ...],
        body: bytes | None = None,
        headers: dict[str, str] | None = None,
        response_limit: int = LEASE_BODY_LIMIT,
        read_step: str | None = None,
    ):
        token = self._token(stage)
        request_headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
        }
        if body is not None:
            request_headers["Content-Type"] = "application/json"
        request_headers.update(headers or {})
        connection = http.client.HTTPSConnection(
            STORAGE_HOST,
            timeout=HTTP_TIMEOUT_SECONDS,
            context=_verified_tls_context(),
        )
        try:
            connection.request(method, path, body=body, headers=request_headers)
            response = connection.getresponse()
            if response.status == 412:
                raise LeasePreconditionFailed(stage, response.status)
            if method == "POST" and (response.status == 408 or response.status >= 500):
                raise LeaseWriteUncertain(
                    stage,
                    BoundedFailureReason.UNCLASSIFIED,
                    http_status=response.status,
                )
            if response.status not in accepted_statuses:
                raise _read_failure(
                    stage,
                    BoundedFailureReason.UNCLASSIFIED,
                    read_step,
                    "http_status",
                    http_status=response.status,
                )
            content = (
                _bounded_http_body(response, response_limit, stage, read_step)
                if response_limit
                else b""
            )
            return response.status, response.headers, content
        except HealthCommandFailure:
            raise
        except TimeoutError as exc:
            if method == "POST":
                raise LeaseWriteUncertain(stage, BoundedFailureReason.TIMEOUT) from None
            raise _read_failure(stage, BoundedFailureReason.TIMEOUT, read_step, "transport", exc) from None
        except (OSError, http.client.HTTPException) as exc:
            if method == "POST":
                raise LeaseWriteUncertain(
                    stage, BoundedFailureReason.UNCLASSIFIED
                ) from None
            raise _read_failure(stage, BoundedFailureReason.READ, read_step, "transport", exc) from None
        finally:
            connection.close()

    def write(self, payload: bytes, expected_generation: str) -> None:
        if not re.fullmatch(r"[0-9]{1,20}", expected_generation):
            raise HealthCommandFailure(
                HealthCommandStage.LEASE_CLAIM, BoundedFailureReason.ARGUMENTS
            )
        path = "/upload/storage/v1/b/{}/o?{}".format(
            quote(self.bucket, safe=""),
            urlencode(
                {
                    "uploadType": "media",
                    "name": LEASE_OBJECT,
                    "ifGenerationMatch": expected_generation,
                }
            ),
        )
        self._storage_request(
            "POST",
            path,
            stage=HealthCommandStage.LEASE_CLAIM,
            accepted_statuses=(200,),
            body=payload,
            response_limit=0,
        )

    def generation(self) -> str:
        _, _, body = self._storage_request(
            "GET",
            self.object_path + "?fields=generation",
            stage=HealthCommandStage.LEASE_READ,
            accepted_statuses=(200,),
            response_limit=2048,
            read_step="storage_generation",
        )
        try:
            value = json.loads(body).get("generation")
        except (AttributeError, TypeError, ValueError):
            raise _read_failure(
                HealthCommandStage.LEASE_READ,
                BoundedFailureReason.UNCLASSIFIED,
                "storage_generation",
                "json_parse",
            ) from None
        if not isinstance(value, str) or not re.fullmatch(r"[0-9]{1,20}", value):
            raise HealthCommandFailure(
                HealthCommandStage.LEASE_READ, BoundedFailureReason.UNCLASSIFIED
            )
        return value

    def read(self, generation: str) -> bytes:
        if not re.fullmatch(r"[0-9]{1,20}", generation):
            raise HealthCommandFailure(
                HealthCommandStage.LEASE_READ, BoundedFailureReason.ARGUMENTS
            )
        response_status, response_headers, body = self._storage_request(
            "GET",
            self.object_path
            + "?"
            + urlencode({"alt": "media", "generation": generation}),
            stage=HealthCommandStage.LEASE_READ,
            accepted_statuses=(200, 206),
            headers={"Range": f"bytes=0-{LEASE_BODY_LIMIT - 1}"},
            response_limit=LEASE_BODY_LIMIT,
            read_step="storage_lease_body",
        )
        content_range = response_headers.get("Content-Range")
        if response_status == 206 and content_range is None:
            raise _range_failure(BoundedFailureReason.READ)
        if content_range is not None:
            match = re.fullmatch(r"bytes 0-([0-9]+)/([0-9]+)", content_range)
            if (
                match is None
                or int(match.group(1)) >= LEASE_BODY_LIMIT
                or len(body) != int(match.group(1)) + 1
            ):
                raise _range_failure(BoundedFailureReason.READ)
            if int(match.group(2)) != len(body):
                raise _range_failure(BoundedFailureReason.SIZE)
        return body

    def delete(self, generation: str) -> None:
        if not re.fullmatch(r"[0-9]{1,20}", generation):
            raise HealthCommandFailure(
                HealthCommandStage.LEASE_RELEASE, BoundedFailureReason.ARGUMENTS
            )
        path = self.object_path + "?" + urlencode({"ifGenerationMatch": generation})
        self._storage_request(
            "DELETE",
            path,
            stage=HealthCommandStage.LEASE_RELEASE,
            accepted_statuses=(204,),
            response_limit=0,
        )


def _read_exact_lease(storage) -> tuple[str, dict]:
    generation = storage.generation()
    try:
        existing = json.loads(storage.read(generation))
    except (UnicodeDecodeError, ValueError):
        raise _read_failure(
            HealthCommandStage.LEASE_READ,
            BoundedFailureReason.UNCLASSIFIED,
            "storage_lease_body",
            "json_parse",
        ) from None
    if (
        not isinstance(existing, dict)
        or not isinstance(existing.get("holder"), str)
        or not re.fullmatch(r"[0-9a-f]{32}", existing["holder"])
        or type(existing.get("expires")) is not int
    ):
        raise HealthCommandFailure(
            HealthCommandStage.LEASE_READ, BoundedFailureReason.UNCLASSIFIED
        )
    return generation, existing


@contextmanager
def lease(project: str, *, storage=None, clock=time.time):
    if project not in PROJECTS:
        raise ValueError("Ungoverned health project")
    storage = storage or CloudStorageLease(project)
    holder = uuid.uuid4().hex
    with tempfile.TemporaryDirectory(prefix="auth-health-") as directory:
        payload = Path(directory, "lease.json")
        payload.write_text(json.dumps({"holder": holder, "expires": int(clock()) + LEASE_SECONDS}))
        payload.chmod(0o600)
        payload_bytes = payload.read_bytes()
        generation = None
        exact = None
        try:
            storage.write(payload_bytes, "0")
        except LeasePreconditionFailed:
            observed_generation, existing = _read_exact_lease(storage)
            if existing["holder"] != holder:
                if existing["expires"] > clock():
                    yield False
                    return
                try:
                    storage.write(payload_bytes, observed_generation)
                except LeaseWriteUncertain as uncertain:
                    generation, exact = _read_exact_lease(storage)
                    if exact["holder"] != holder:
                        raise uncertain
            else:
                generation, exact = observed_generation, existing
        except LeaseWriteUncertain as uncertain:
            generation, exact = _read_exact_lease(storage)
            if exact["holder"] != holder:
                raise uncertain
        if generation is None:
            generation, exact = _read_exact_lease(storage)
        if exact["holder"] != holder or exact["expires"] <= clock():
            raise HealthCommandFailure(
                HealthCommandStage.LEASE_READ, BoundedFailureReason.UNCLASSIFIED
            )
        try:
            yield True
        finally:
            # Never remove a successor's lease. Failure leaves a bounded lease
            # for the next scheduled run rather than claiming successful cleanup.
            storage.delete(generation)


def main() -> int:
    project = os.environ.get("AUTH_HEALTH_PROJECT", "")
    runtime = os.environ.get("AUTH_PHONE_RUNTIME_HEALTH_ENABLED", "false")
    if project not in PROJECTS or runtime not in {"true", "false"}:
        print("Auth health configuration unavailable")
        return 2
    try:
        with lease(project) as acquired:
            if not acquired:
                print("Auth health check already running; duplicate execution settled")
                return 0
            args = [sys.executable, str(ROOT / "scripts/ops/verify_secret_list_invariants.py"),
                    "--project", project, "--emit-health-log"]
            if runtime == "true":
                args.append("--check-phone-runtime")
            args.append("--health-result-json")
            result = command(
                args, stage=HealthCommandStage.PROTECTED_LIST_CHECK, timeout=450
            )
            try:
                exit_code, message = summarize_health_outcome(result)
            except ValueError:
                raise HealthCommandFailure(
                    HealthCommandStage.PROTECTED_LIST_CHECK,
                    BoundedFailureReason.UNCLASSIFIED,
                ) from None
            print(message)
            return exit_code
    except HealthCommandFailure as exc:
        # These fields are fixed enums; never echo provider stderr or command input.
        message = (
            f"Auth health check unavailable; stage={exc.stage.value}; "
            f"reason={exc.reason.value}"
        )
        if exc.exitcode is not None:
            message += f"; exitcode={exc.exitcode}"
        if exc.http_status is not None:
            message += f"; http_status={exc.http_status}"
        if exc.diagnostic is not None:
            step, kind, exception_type = exc.diagnostic
            message += f"; read_step={step}; failure_kind={kind}"
            if exception_type is not None:
                message += f"; exception_type={exception_type}"
        print(message)
        return 2
    except (BoundedReadError, ValueError, OSError):
        # Do not label an unreadable source healthy, or echo provider stderr.
        print(
            f"Auth health check unavailable; stage={HealthCommandStage.OPERATION.value}; "
            f"reason={BoundedFailureReason.UNCLASSIFIED.value}"
        )
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
