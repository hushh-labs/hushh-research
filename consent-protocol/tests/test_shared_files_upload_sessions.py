"""Shared Files resumable-session custody and provider terminal evidence."""

from __future__ import annotations

import pytest


@pytest.mark.parametrize(
    "outcome",
    [
        "complete",
        "incomplete",
        "cancel_completed",
        "uncertain_cancel",
        "invalidated",
        "expired",
        "lost_cancel",
    ],
)
async def test_shared_resumable_recovery_requires_provider_terminal_proof(monkeypatch, outcome):
    import hashlib
    import uuid
    from unittest.mock import AsyncMock

    from hushh_mcp.services.shared_files import bucket_admission, write_receipts, writes

    body = b"synthetic-encrypted-file-content"
    receipt = {
        "protocol": 2,
        "state": "uncertain",
        "path": "a" * 64 + "/" + "b" * 64,
        "digest": hashlib.sha256(body).hexdigest(),
        "byteCount": len(body),
        "expectedGeneration": "",
        "session": {"ciphertext": "sealed"},
    }
    row = {
        "user_id": "alice",
        "library_id": str(uuid.uuid4()),
        "bucket": "synthetic-files",
        "state": "active",
    }
    transitions = AsyncMock(return_value=True)
    monkeypatch.setattr(write_receipts, "transition", transitions)
    monkeypatch.setattr(write_receipts, "restore", lambda *args: "private-session-memory-only")
    monkeypatch.setattr(bucket_admission, "observe", AsyncMock(return_value={}))
    monkeypatch.setattr(bucket_admission, "verify", lambda *args: None)
    store = type("Store", (), {})()
    store.status = AsyncMock(
        return_value="invalidated"
        if outcome == "invalidated"
        else "uncertain"
        if outcome in {"expired", "uncertain_cancel"}
        else "complete"
        if outcome == "complete"
        else "incomplete"
    )
    store.cancel = AsyncMock(return_value=outcome != "expired")
    if outcome == "lost_cancel":
        store.cancel.side_effect = TimeoutError("synthetic lost response")
    store.get_bounded_with_generation = AsyncMock(
        return_value=(body, "3") if outcome in {"complete", "cancel_completed"} else (None, "")
    )
    if outcome == "lost_cancel":
        with pytest.raises(TimeoutError):
            await writes.reconcile(store, row, "operation", receipt)
    else:
        await writes.reconcile(store, row, "operation", receipt)
    terminal = [call for call in transitions.await_args_list if call.args[3] is None]
    assert bool(terminal) == (
        outcome in {"complete", "incomplete", "cancel_completed", "uncertain_cancel", "invalidated"}
    )
    if outcome == "invalidated":
        store.cancel.assert_not_awaited()
    if outcome == "expired":
        store.cancel.assert_awaited_once_with("private-session-memory-only", receipt["path"])
        store.get_bounded_with_generation.assert_not_awaited()
    assert transitions.await_args_list[-1].args[3]["state"] == "uncertain"


async def test_shared_upload_retains_cancel_proof_across_failed_verification(monkeypatch):
    import hashlib
    import uuid
    from unittest.mock import AsyncMock

    from hushh_mcp.services.pod_files.contracts import FilesRefused
    from hushh_mcp.services.shared_files import bucket_admission, write_receipts, writes

    body = b"synthetic-encrypted-file-content"
    receipt = {
        "protocol": 2,
        "state": "uncertain",
        "path": "a" * 64 + "/" + "b" * 64,
        "digest": hashlib.sha256(body).hexdigest(),
        "byteCount": len(body),
        "expectedGeneration": "",
        "session": {"ciphertext": "sealed"},
    }
    row = {
        "user_id": "alice",
        "library_id": str(uuid.uuid4()),
        "bucket": "synthetic-files",
        "state": "active",
    }
    current = receipt

    async def transition(_row, _operation, previous, replacement, **kwargs):
        nonlocal current
        if current != previous:
            return False
        current = replacement
        return True

    monkeypatch.setattr(write_receipts, "transition", transition)
    monkeypatch.setattr(write_receipts, "restore", lambda *args: "private-session-memory-only")
    monkeypatch.setattr(bucket_admission, "observe", AsyncMock(return_value={}))
    monkeypatch.setattr(bucket_admission, "verify", lambda *args: None)
    store = type("Store", (), {})()
    store.status = AsyncMock(return_value="uncertain")
    store.cancel = AsyncMock(return_value=True)
    store.get_bounded_with_generation = AsyncMock(
        side_effect=TimeoutError("synthetic read failure")
    )
    with pytest.raises(TimeoutError):
        await writes.reconcile(store, row, "operation", current)
    assert current["providerTerminal"] == "cancelled"
    assert current["state"] == "uncertain"

    # The already-cancelled provider session cannot supply another receipt.
    store.status.side_effect = AssertionError("terminal proof must survive restart")
    store.cancel.side_effect = AssertionError("do not repeat cancellation after confirmed receipt")
    store.get_bounded_with_generation.side_effect = None
    store.get_bounded_with_generation.return_value = (body, "3")

    def changed_bucket(*args):
        raise FilesRefused("FILES_BUCKET_CHANGED", 409)

    monkeypatch.setattr(bucket_admission, "verify", changed_bucket)
    with pytest.raises(FilesRefused, match="FILES_BUCKET_CHANGED"):
        await writes.reconcile(store, row, "operation", current)
    assert current["providerTerminal"] == "cancelled"
    monkeypatch.setattr(bucket_admission, "verify", lambda *args: None)
    await writes.reconcile(store, row, "operation", current)
    assert current is None
    store.cancel.assert_awaited_once()


@pytest.mark.parametrize(
    "bad_uri",
    [
        "http://storage.googleapis.com/upload/storage/v1/b/synthetic-files/o?uploadType=resumable&upload_id=x",
        "https://metadata.google.internal/upload/storage/v1/b/synthetic-files/o?uploadType=resumable&upload_id=x",
        "https://storage.googleapis.com/upload/storage/v1/b/other-owner/o?uploadType=resumable&upload_id=x",
    ],
)
async def test_shared_upload_refuses_unbound_session_destination_without_request(bad_uri):
    from hushh_mcp.services.pod_files.contracts import FilesRefused
    from hushh_mcp.services.shared_files.uploads import SharedCipherStore

    class Transport:
        def put(self, *args, **kwargs):
            raise AssertionError("An unbound destination must never receive a request")

    store = SharedCipherStore("synthetic-files", "owner/library", session=Transport())
    with pytest.raises(FilesRefused, match="FILES_UPLOAD_SESSION_INVALID"):
        await store.send(bad_uri, "opaque", b"K" * 28)
    with pytest.raises(FilesRefused, match="FILES_UPLOAD_SESSION_INVALID"):
        await store.status(bad_uri, "opaque", 28, admission={})


@pytest.mark.parametrize(
    "status, expected",
    [
        (410, "invalidated"),
        (308, "incomplete"),
        (412, "uncertain"),
        (302, "uncertain"),
        (403, "uncertain"),
        (503, "uncertain"),
    ],
)
@pytest.mark.parametrize("admitted", [False, True])
async def test_shared_upload_only_provider_expiry_proves_session_invalidation(
    monkeypatch, status, expected, admitted
):
    from hushh_mcp.services.shared_files import bucket_admission
    from hushh_mcp.services.shared_files.uploads import SharedCipherStore
    from tests.pod_azure_fakes import FakeResponse
    from tests.services.test_shared_files_lifecycle_postgres import BUCKET

    response = FakeResponse(status)

    class Transport:
        def put(self, url, **kwargs):
            assert kwargs["allow_redirects"] is False
            return response

        def get(self, *args, **kwargs):
            raise AssertionError("A non-404 status must never enter expiry qualification")

    store = SharedCipherStore("synthetic-files", "owner/library", session=Transport())
    monkeypatch.setattr(store, "_headers", lambda: {})
    uri = "https://storage.googleapis.com/upload/storage/v1/b/synthetic-files/o?uploadType=resumable&upload_id=synthetic-session"
    admission = bucket_admission.admission(BUCKET, "synthetic-files") if admitted else None
    assert await store.status(uri, "opaque", 28, admission=admission) == expected


@pytest.mark.feature_account_deletion
@pytest.mark.trace_loop
@pytest.mark.parametrize(
    "defect", ["none", "changed_bucket", "unreadable", "unadmitted", "no_admission"]
)
async def test_exact_session_404_requires_original_bucket_admission(monkeypatch, defect):
    from hushh_mcp.services.pod_files.contracts import FilesRefused
    from hushh_mcp.services.shared_files import bucket_admission
    from hushh_mcp.services.shared_files.uploads import SharedCipherStore
    from tests.pod_azure_fakes import FakeResponse
    from tests.services.test_shared_files_lifecycle_postgres import BUCKET

    class Transport:
        def put(self, url, **kwargs):
            assert kwargs["allow_redirects"] is False and kwargs["data"] == b""
            assert kwargs["headers"]["Content-Range"] == "bytes */28"
            return FakeResponse(404)

        def get(self, url, **kwargs):
            assert defect != "no_admission", "An unbound missing response must remain generic"
            assert url == "https://storage.googleapis.com/storage/v1/b/synthetic-files"
            assert kwargs["allow_redirects"] is False
            metadata = {**BUCKET, "generation": "2"} if defect == "changed_bucket" else BUCKET
            return FakeResponse(503 if defect == "unreadable" else 200, body=metadata)

    store = SharedCipherStore("synthetic-files", "owner/library", session=Transport())
    monkeypatch.setattr(store, "_headers", lambda: {})
    admission = (
        {} if defect == "unadmitted" else bucket_admission.admission(BUCKET, "synthetic-files")
    )
    if defect == "no_admission":
        admission = None
    uri = "https://storage.googleapis.com/upload/storage/v1/b/synthetic-files/o?uploadType=resumable&upload_id=synthetic-session"
    if defect in {"none", "no_admission"}:
        expected = "missing" if defect == "no_admission" else "expired"
        assert await store.status(uri, "opaque", 28, admission=admission) == expected
    else:
        with pytest.raises(FilesRefused):
            await store.status(uri, "opaque", 28, admission=admission)


async def test_shared_upload_session_bearer_is_excluded_from_http_instrumentation(monkeypatch):
    import json

    from opentelemetry.instrumentation.utils import is_http_instrumentation_enabled

    from hushh_mcp.services.shared_files.uploads import SharedCipherStore
    from tests.pod_azure_fakes import FakeResponse

    class Transport:
        def put(self, url, **kwargs):
            assert not is_http_instrumentation_enabled(), "Provider session URI reached tracing"
            assert kwargs["allow_redirects"] is False and kwargs["stream"] is True
            return FakeResponse(
                200,
                content=json.dumps(
                    {"name": "owner/library/opaque", "generation": "123", "size": "28"}
                ).encode(),
            )

    store = SharedCipherStore("synthetic-files", "owner/library", session=Transport())
    monkeypatch.setattr(store, "_headers", lambda: {})
    uri = "https://storage.googleapis.com/upload/storage/v1/b/synthetic-files/o?uploadType=resumable&upload_id=synthetic-session"
    assert await store.send(uri, "opaque", b"K" * 28) == "123"
