"""Correlation survives the actual privacy filter without exposing identities."""

# ruff: noqa: S106 -- synthetic credentials never leave the mocked adapter

import asyncio
import logging
import re
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

from hushh_mcp.consent.audit_logger import audit_context
from hushh_mcp.services.drive_chat_service import DriveChatService
from hushh_mcp.services.drive_owner_search_service import DriveOwnerSearchService
from hushh_mcp.services.drive_telemetry import correlation_tag, drive_logger, drive_operation
from hushh_mcp.services.google_drive_adapter import GoogleDriveAdapter
from mcp_modules.log_redaction import install_sensitive_log_filter


@pytest.fixture(autouse=True)
def filtered_logs(caplog):
    factory = logging.getLogRecordFactory()
    install_sensitive_log_filter()
    caplog.set_level(logging.INFO)
    yield
    logging.setLogRecordFactory(factory)


def messages(caplog):
    return [record.getMessage() for record in caplog.records if "drive_op=" in record.getMessage()]


def operation(message):
    return re.search(r"drive_op=([a-f0-9]{16}|none)", message).group(1)


async def test_background_pages_slices_and_rest_keep_same_private_job_tag(caplog):
    job_id = str(uuid4())
    job = {"checkpoint": {"phase": "user"}}
    store = SimpleNamespace(
        claim=AsyncMock(return_value=job),
        require_current=AsyncMock(),
        commit_page=AsyncMock(return_value={"status": "completed", "matched": 1}),
    )
    adapter = GoogleDriveAdapter()
    adapter._get_private = AsyncMock(return_value=b"{}")
    service = DriveOwnerSearchService(store=store, transport=SimpleNamespace())

    async def page(_):
        await adapter._get(
            "/files", access_token="private-token", params={"q": "private-query"}, limit=1
        )
        return {}, [{"id": "private-file"}], False, True

    service._page = page
    with audit_context("private-request-id"):
        for _ in range(2):
            job["checkpoint"] = {"phase": "user"}
            assert await service.run_one(user_id="private-owner", job_id=job_id) == "completed"
    logs = messages(caplog)
    assert len(logs) == 6
    assert all(operation(message) == correlation_tag(job_id) for message in logs)
    assert all(
        f"request_tag={correlation_tag('private-request-id')}" in message for message in logs
    )
    assert all(
        job_id not in message and "private-" not in message and "[REDACTED]" not in message
        for message in logs
    )


async def test_actual_foreground_error_and_rest_share_fresh_operation(caplog):
    adapter = GoogleDriveAdapter()
    adapter._get_private = AsyncMock(return_value=b"{}")

    async def credential(**_):
        await adapter._get("/about", access_token="private-token", params={}, limit=1)
        raise RuntimeError("private provider detail")

    chat = DriveChatService(oauth=SimpleNamespace(current_credential=credential))
    for _ in range(2):
        await chat.run_live_query(
            user_id="private-owner",
            consent_token="private-token",
            query="private-query",
            require_access=AsyncMock(),
        )
    logs = messages(caplog)
    assert len(logs) == 4
    assert operation(logs[0]) == operation(logs[1]) != "none"
    assert operation(logs[2]) == operation(logs[3]) != operation(logs[0])
    assert all("private-" not in message for message in logs)


async def test_concurrent_operations_and_child_tasks_are_isolated(caplog):
    ready = asyncio.Event()
    entered = 0
    logger = drive_logger("drive_telemetry_test")

    @drive_operation(job_key="job_id")
    async def task(*, job_id, request):
        nonlocal entered
        with audit_context(request):
            entered += 1
            if entered == 2:
                ready.set()
            await ready.wait()

            async def child():
                logger.info("drive_test.child")

            await asyncio.create_task(child())
            await asyncio.sleep(0)
            logger.info("drive_test.parent")

    pairs = [(str(uuid4()), str(uuid4())) for _ in range(2)]
    await asyncio.gather(*(task(job_id=job, request=request) for job, request in pairs))
    logs = messages(caplog)
    for job, request in pairs:
        own = [message for message in logs if operation(message) == correlation_tag(job)]
        assert len(own) == 2
        assert all(f"request_tag={correlation_tag(request)}" in message for message in own)
    logger.info("drive_test.outside")
    assert "drive_op=none request_tag=none" in messages(caplog)[-1]


@pytest.mark.parametrize("failure", [RuntimeError, asyncio.CancelledError])
async def test_failed_operation_resets_context(caplog, failure):
    logger = drive_logger("drive_telemetry_test")

    @drive_operation()
    async def task():
        logger.info("drive_test.inside")
        raise failure()

    with pytest.raises(failure):
        await task()
    logger.info("drive_test.outside")
    assert operation(messages(caplog)[0]) != "none"
    assert operation(messages(caplog)[1]) == "none"


async def test_invalid_job_id_does_not_change_method_validation_or_log_input(caplog):
    @drive_operation(job_key="job_id")
    async def task(*, job_id):
        drive_logger("drive_telemetry_test").info("drive_test.invalid")
        return "existing validation result"

    assert await task(job_id="private-invalid-input") == "existing validation result"
    assert "private-invalid-input" not in messages(caplog)[0]


async def test_even_numeric_only_tags_survive_global_filter(caplog, monkeypatch):
    monkeypatch.setattr("hushh_mcp.services.drive_telemetry.correlation_tag", lambda _: "0" * 16)

    @drive_operation()
    async def task():
        drive_logger("drive_telemetry_test").info("drive_test.numeric")

    with audit_context("synthetic-request"):
        await task()
    assert "drive_op=0000000000000000 request_tag=0000000000000000" in messages(caplog)[0]
