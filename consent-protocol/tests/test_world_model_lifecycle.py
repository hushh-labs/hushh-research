"""Regression tests for email authority, evidence receipts and preview encryption."""

import asyncio
import secrets
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

from hushh_mcp.services import world_model_invitations as invitations
from hushh_mcp.services import world_model_notifications as mod
from hushh_mcp.services import world_model_source_review as sources


@pytest.mark.asyncio
@pytest.mark.parametrize("boundary", ["read", "dispatch"])
@pytest.mark.parametrize("moves_private", [False, True])
async def test_source_reviews_revalidate_placement_after_checkpoint_work(
    monkeypatch, boundary, moves_private
):
    import time
    from unittest.mock import Mock

    from fastapi import HTTPException

    from hushh_mcp.runtime_providers import factory
    from hushh_mcp.services import owner_placement_guard as placement

    mode = {"value": "shared"}
    monkeypatch.setattr(placement, "pod_mode", lambda: False)
    monkeypatch.setattr(
        placement, "get_owner_hosting_mode", AsyncMock(side_effect=lambda _: mode["value"])
    )
    monkeypatch.setattr(sources, "one_profile_research_enabled", lambda: True)
    monkeypatch.setattr(
        invitations, "verified_owner", AsyncMock(return_value={"full_name": "Alex"})
    )
    checkpoint = {
        "job_id": str(uuid4()),
        "status": "offered",
        "allowed_use": "reviewable_fact",
        "finished_at": time.time(),
        "result": {"report": "synthetic"},
    }

    async def get(_):
        if moves_private and boundary == "read":
            mode["value"] = "byoc"
        return checkpoint if boundary == "read" else None

    async def write(*_):
        if moves_private:
            mode["value"] = "byoc"
        return {"job_id": str(uuid4())}

    monkeypatch.setattr(sources, "STORE", SimpleNamespace(get=AsyncMock(side_effect=get)))
    monkeypatch.setattr(
        sources, "scoped_store", lambda _: SimpleNamespace(write=AsyncMock(side_effect=write))
    )
    provider = Mock(side_effect=RuntimeError("synthetic dispatch reached"))
    monkeypatch.setattr(factory, "build_managed_runtime_client", provider)
    if boundary == "read":
        if moves_private:
            with pytest.raises(HTTPException) as failure:
                await sources.read("owner", "token")
            assert failure.value.detail["code"] == "AGENT_PRIVATE_RUNTIME_REQUIRED"
        else:
            assert await sources.read("owner", "token") == checkpoint
    else:
        operation = sources.prepare(
            "owner",
            "token",
            sources.SourceReviewInput(
                name="Alex",
                urls=["https://example.test/profile"],
                purpose="owner",
                permitted_public_sources=True,
            ),
        )
        if moves_private:
            with pytest.raises(HTTPException) as failure:
                await operation
            assert failure.value.detail["code"] == "AGENT_PRIVATE_RUNTIME_REQUIRED"
        else:
            with pytest.raises(RuntimeError, match="synthetic dispatch reached"):
                await operation
    assert provider.call_count == int(boundary == "dispatch" and not moves_private)


@asynccontextmanager
async def value_scope(value):
    yield value


@pytest.mark.asyncio
@pytest.mark.parametrize("cancel_count", [1, 2])
@pytest.mark.parametrize("uncertain", [False, True])
async def test_email_keeps_authority_until_provider_stops(monkeypatch, cancel_count, uncertain):
    entered, release = asyncio.Event(), asyncio.Event()
    held = {"value": False}
    generation, draft = uuid4(), uuid4()

    @asynccontextmanager
    async def transaction():
        held["value"] = True
        try:
            yield
        finally:
            held["value"] = False

    conn = SimpleNamespace(
        fetchrow=AsyncMock(
            return_value={
                "enabled": True,
                "email_enabled": True,
                "generation": generation,
                "active_draft_id": draft,
            }
        ),
        execute=AsyncMock(),
        transaction=transaction,
    )
    pool = SimpleNamespace(acquire=lambda **kw: value_scope(conn), execute=AsyncMock())

    async def thread(fn, *args, **kwargs):
        if fn is mod.lookup_fresh_owner_identity:
            return SimpleNamespace(
                uid="owner", disabled=False, email_verified=True, email="owner@example.test"
            )
        entered.set()
        await release.wait()
        if uncertain:
            raise mod.SupportEmailDeliveryUncertainError("synthetic")
        return "accepted"

    monkeypatch.setattr(mod, "one_profile_research_enabled", lambda: True)
    monkeypatch.setattr(mod, "lock_connection_graph_users_async", AsyncMock())
    monkeypatch.setattr(mod, "owner_setup_resolved", AsyncMock(return_value=True))
    monkeypatch.setattr(mod, "run_in_threadpool", thread)
    worker = mod.WorldModelNotificationWorker()
    worker._draft_available = AsyncMock(return_value=True)
    task = asyncio.create_task(
        worker._deliver(
            pool,
            {
                "user_id": "owner",
                "draft_id": draft,
                "generation": generation,
                "outcome": "ready",
                "email_attempts": 1,
            },
            uuid4(),
        )
    )
    await asyncio.wait_for(entered.wait(), 2)
    try:
        for _ in range(cancel_count):
            task.cancel()
            await asyncio.sleep(0)
        assert held["value"] and not task.done()
    finally:
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 2)
    assert not held["value"]


@pytest.mark.asyncio
@pytest.mark.parametrize("blocked_by", ["flag", "expired", "consent", "generation", "draft"])
async def test_notification_revalidates_authority(monkeypatch, blocked_by):
    generation, draft = uuid4(), uuid4()
    current = {
        "enabled": blocked_by != "consent",
        "email_enabled": True,
        "generation": uuid4() if blocked_by == "generation" else generation,
        "active_draft_id": uuid4() if blocked_by == "draft" else draft,
    }
    conn = SimpleNamespace(
        fetchrow=AsyncMock(return_value=current),
        execute=AsyncMock(),
        transaction=lambda: value_scope(None),
    )
    pool = SimpleNamespace(acquire=lambda **kw: value_scope(conn), execute=AsyncMock())
    monkeypatch.setattr(mod, "one_profile_research_enabled", lambda: blocked_by != "flag")
    monkeypatch.setattr(mod, "lock_connection_graph_users_async", AsyncMock())
    monkeypatch.setattr(mod, "owner_setup_resolved", AsyncMock(return_value=True))
    thread = AsyncMock(side_effect=AssertionError("Should not resolve email or dispatch"))
    monkeypatch.setattr(mod, "run_in_threadpool", thread)
    worker = mod.WorldModelNotificationWorker()
    worker._draft_available = AsyncMock(return_value=blocked_by != "expired")
    await worker._deliver(
        pool,
        {
            "user_id": "owner",
            "draft_id": draft,
            "generation": generation,
            "outcome": "ready",
            "email_attempts": 1,
        },
        uuid4(),
    )
    thread.assert_not_awaited()
    assert conn.execute.call_args.args[4] == "suppressed"


@pytest.mark.parametrize(
    "url",
    [
        "http://example.test",
        "https://127.0.0.1",
        "https://metadata.google.internal",
        "https://user:secret@example.test",
        "https://example.test/path?token=private",
        "https://example.test/#secret",
    ],
)
def test_sources_reject_private_or_secret_bearing_urls(url):
    with pytest.raises(ValueError):
        sources.SourceReviewInput(
            name="Alex", urls=[url], purpose="owner", permitted_public_sources=True
        )


def test_only_requested_successful_receipts_are_evidence():
    from google.genai import types

    def response(rows):
        return types.GenerateContentResponse(
            candidates=[
                types.Candidate(url_context_metadata=types.UrlContextMetadata(url_metadata=rows))
            ]
        )

    good = {
        "retrieved_url": "https://example.test/alex",
        "url_retrieval_status": "URL_RETRIEVAL_STATUS_SUCCESS",
    }
    assert sources.successful_sources(response([good]), [good["retrieved_url"]]) == {
        "s1": good["retrieved_url"]
    }
    for rows in [
        [],
        [{**good, "url_retrieval_status": "URL_RETRIEVAL_STATUS_ERROR"}],
        [good, {**good, "retrieved_url": "https://other.test"}],
    ]:
        with pytest.raises(ValueError):
            sources.successful_sources(response(rows), [good["retrieved_url"]])


def test_preview_token_and_invitation_are_bound():
    from cryptography.exceptions import InvalidTag

    token = secrets.token_urlsafe(32)
    invitation_id = uuid4()
    value = {"report": {"summary": "Public professional fixture"}}
    sealed = invitations.seal_preview(token, invitation_id, value)
    assert b"Public professional fixture" not in sealed
    assert invitations.open_preview(token, invitation_id, sealed) == value
    for bad_token, bad_id in [(secrets.token_urlsafe(32), invitation_id), (token, uuid4())]:
        with pytest.raises(InvalidTag):
            invitations.open_preview(bad_token, bad_id, sealed)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "match,sections,outcome",
    [
        ("no_match", [], "attention"),
        ("matched", [{"facts": []}], "attention"),
        ("uncertain", [{"facts": [{"statement": "Supported draft"}]}], "partial"),
        ("matched", [{"facts": [{"statement": "Supported draft"}]}], "ready"),
    ],
)
async def test_completion_only_announces_actual_findings(match, sections, outcome):
    import uuid

    from hushh_mcp.services.world_model_preferences import checkpoint_committed

    generation = uuid.uuid4()
    conn = SimpleNamespace(
        fetchrow=AsyncMock(return_value={"enabled": True, "generation": generation}),
        execute=AsyncMock(),
    )
    await checkpoint_committed(
        conn,
        "owner",
        {
            "job_id": str(uuid.uuid4()),
            "consent_generation": str(generation),
            "status": "offered",
            "result": {"report": {"match_status": match, "sections": sections}},
        },
    )
    delivery = next(
        call.args
        for call in conn.execute.call_args_list
        if "INSERT INTO pwm_completion_events" in call.args[0]
    )
    assert delivery[4:] == (outcome, "suppressed" if outcome == "attention" else "pending")


@pytest.mark.parametrize("status", [200, 302, 404])
async def test_public_source_review_receipt_requires_exact_successful_fetch_and_current_owner(
    status,
):
    import hashlib

    import httpx

    from hushh_mcp.one_adk.public_source_fetch import MAX_SOURCE_BYTES, retrieve_public_sources

    raw = b"<p>Synthetic public article.</p><script>ignored</script>"
    authority = AsyncMock()
    observed = []

    def factory(**kwargs):
        observed.append(kwargs)
        return httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda request: httpx.Response(
                    status,
                    content=raw,
                    headers={"content-type": "text/html", "location": "https://127.0.0.1/"},
                )
            ),
            follow_redirects=False,
        )

    if status == 200:
        result = await retrieve_public_sources(
            ["https://public.example.test/article"],
            require_current=authority,
            client_factory=factory,
        )
        assert [(r.ref, r.url) for r in result] == [("s1", "https://public.example.test/article")]
        assert result[0].sha256 == hashlib.sha256(raw).hexdigest()
        assert result[0].parts[-1].text == "Synthetic public article."
        assert authority.await_count == 2
    else:
        with pytest.raises(ValueError, match="not retrieved"):
            await retrieve_public_sources(
                ["https://public.example.test/article"],
                require_current=authority,
                client_factory=factory,
            )
    assert observed[0]["max_response_bytes"] == MAX_SOURCE_BYTES
    authority.side_effect = PermissionError("owner revoked")
    with pytest.raises(PermissionError):
        await retrieve_public_sources(
            ["https://public.example.test/article"],
            require_current=authority,
            client_factory=factory,
        )


async def test_public_source_review_preserves_successful_receipts_when_another_page_fails():
    import httpx

    from hushh_mcp.one_adk.public_source_fetch import retrieve_public_sources

    def factory(**kwargs):
        return httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda request: httpx.Response(
                    404 if request.url.path == "/missing" else 200,
                    content=b"A synthetic public source.",
                    headers={"content-type": "text/plain"},
                )
            )
        )

    result = await retrieve_public_sources(
        ["https://public.example.test/missing", "https://public.example.test/article"],
        require_current=AsyncMock(),
        client_factory=factory,
    )
    assert [(row.ref, row.url) for row in result] == [("s1", "https://public.example.test/article")]
