"""Core browser privacy contracts; synthetic fixtures do not qualify cloud isolation."""

import asyncio

import pytest

from hushh_mcp.services.pod_browser.contracts import BrowserRefused
from tests.helpers.pod_browser import (
    _remembered,
    _session_fixture,
    binding,
    readiness,
)


async def test_remember_is_ciphertext_only_restore_requires_exact_task_approval_and_forget_survives_restart(
    tmp_path,
):
    from hushh_mcp.services.pod_browser.sessions import BrowserSessions

    sessions, auth, store, log, site, state, origins, closed = await _session_fixture(tmp_path)
    current = await sessions.remember(binding(), site, state, approved_origins=origins)
    raw = await store.get(current.object_key)
    assert b"synthetic-session" not in raw
    records = await log.replay()
    assert all(
        "synthetic-session" not in str(record) and "example.com" not in str(record)
        for record in records
    )
    installed = []

    async def install(value):
        installed.append(value)

    with pytest.raises(BrowserRefused, match="APPROVAL_REQUIRED"):
        await sessions.restore_for_task(binding(), site, approved_origins=origins, install=install)
    auth.approve(
        "session_restore",
        {
            "site": site,
            "generation": 0,
            "object": current.object_key,
            "digest": current.digest,
            "origins": sorted(origins),
        },
    )
    assert await sessions.restore_for_task(
        binding(), site, approved_origins=origins, install=install
    )
    assert [c.name for c in installed[0].cookies] == ["persistent"]
    assert (await sessions.forget(binding(), site)).persisted
    assert closed == [site] and await store.get(current.object_key) is None
    # Same owner custody recovers metadata, including the Forget generation.
    rebuilt = BrowserSessions(
        owner_id="owner",
        store=store,
        log=log,
        custody_key=b"S" * 32,
        consent=auth,
        readiness=readiness(),
        fence_live_contexts=install,
        clock=lambda: 1000,
    )
    assert not await rebuilt.restore_for_task(
        binding(), site, approved_origins=origins, install=install
    )
    assert await rebuilt.recovery_inventory() == ()


async def test_forget_fences_a_pending_restore_before_import_and_failed_save_remains_in_inventory(
    tmp_path,
):
    from hushh_mcp.services.pod_commit_log import LocalObjectStore

    class PausedStore(LocalObjectStore):
        pause = False
        entered, release = asyncio.Event(), asyncio.Event()

        async def get_bounded(self, key, *, max_bytes):
            if self.pause:
                self.entered.set()
                await self.release.wait()
            return await super().get_bounded(key, max_bytes=max_bytes)

    store = PausedStore(str(tmp_path))
    sessions, auth, store, log, site, state, origins, closed = await _session_fixture(
        tmp_path, store
    )
    current = await sessions.remember(binding(), site, state, approved_origins=origins)
    auth.approve(
        "session_restore",
        {
            "site": site,
            "generation": 0,
            "object": current.object_key,
            "digest": current.digest,
            "origins": sorted(origins),
        },
    )
    store.pause = True
    imported = []

    async def install(value):
        imported.append(value)

    pending = asyncio.create_task(
        sessions.restore_for_task(binding(), site, approved_origins=origins, install=install)
    )
    await store.entered.wait()
    forgetting = asyncio.create_task(sessions.forget(binding(), site))
    await asyncio.sleep(0)
    store.release.set()
    with pytest.raises(BrowserRefused, match="FORGOTTEN"):
        await pending
    assert (await forgetting).persisted and imported == []
    assert await store.get(current.object_key) is None


async def test_session_tampering_owner_incarnation_and_retention_fail_closed(tmp_path):
    from hushh_mcp.services.pod_browser.sessions import BrowserSessions

    sessions, auth, store, log, site, state, origins, closed = await _session_fixture(tmp_path)
    with pytest.raises(BrowserRefused, match="OWNER_REFUSED"):
        await sessions.remember(binding(owner_id="other"), site, state, approved_origins=origins)
    with pytest.raises(BrowserRefused, match="BINDING_REFUSED"):
        await sessions.remember(binding(incarnation="old"), site, state, approved_origins=origins)
    current = await sessions.remember(binding(), site, state, approved_origins=origins)
    auth.approve(
        "session_restore",
        {
            "site": site,
            "generation": 0,
            "object": current.object_key,
            "digest": current.digest,
            "origins": sorted(origins),
        },
    )
    _, version = await store.get_with_generation(current.object_key)
    await store.put_if_generation(current.object_key, b"tampered", version)

    async def no_import(_):
        pytest.fail("tampered state imported")

    with pytest.raises(BrowserRefused, match="OBJECT_INVALID"):
        await sessions.restore_for_task(
            binding(), site, approved_origins=origins, install=no_import
        )

    class Retained:
        def __getattr__(self, name):
            return getattr(store, name)

        async def delete(self, key):
            raise RuntimeError("retention")

    async def fence(_):
        pass

    retained = BrowserSessions(
        owner_id="owner",
        store=Retained(),
        log=log,
        custody_key=b"S" * 32,
        consent=auth,
        readiness=readiness(),
        fence_live_contexts=fence,
        clock=lambda: 1000,
    )
    receipt = await retained.forget(binding(), site)
    assert receipt.persisted and not receipt.deletion_requested and not receipt.remote_logout


def test_remembered_state_excludes_session_cookies_preserves_official_expiry_and_refuses_extra_origins():
    from hushh_mcp.services.pod_browser.session_state import RememberedState, persistent_state

    state = _remembered()
    assert state.cookies[0].expires == 1100
    assert state.for_origins(frozenset({"https://example.com"}), now=1101).cookies == ()
    with pytest.raises(BrowserRefused, match="ORIGINS_REFUSED"):
        state.for_origins(frozenset({"https://other.com"}), now=1000)
    raw = state.model_dump(mode="json")
    raw["origins"][0]["indexedDB"] = []
    with pytest.raises(BrowserRefused, match="STATE_REFUSED"):
        persistent_state(raw, frozenset({"https://example.com"}), now=1000)
    raw = state.model_dump(mode="json")
    raw["origins"][0]["localStorage"] = [{"name": "a", "value": "x" * (1024 * 1024)}]
    with pytest.raises(ValueError):
        RememberedState.model_validate_json(__import__("json").dumps(raw))


async def test_session_receipt_revoked_during_read_and_on_repeat_never_authorizes_import(tmp_path):
    from hushh_mcp.services.pod_commit_log import LocalObjectStore

    class RevokingStore(LocalObjectStore):
        revoke = False

        async def get_bounded(self, key, *, max_bytes):
            if self.revoke:
                auth.grants.clear()  # keep task admission valid
            return await super().get_bounded(key, max_bytes=max_bytes)

    store = RevokingStore(str(tmp_path))
    sessions, auth, store, log, site, state, origins, closed = await _session_fixture(
        tmp_path, store
    )
    current = await sessions.remember(binding(), site, state, approved_origins=origins)
    terms = {
        "site": site,
        "generation": 0,
        "object": current.object_key,
        "digest": current.digest,
        "origins": sorted(origins),
    }
    installed = []

    async def install(value):
        installed.append(value)

    auth.approve("session_restore", terms)
    store.revoke = True
    with pytest.raises(BrowserRefused, match="APPROVAL_REQUIRED"):
        await sessions.restore_for_task(binding(), site, approved_origins=origins, install=install)
    assert installed == []
    store.revoke = False
    auth.approve("session_restore", terms)
    assert await sessions.restore_for_task(
        binding(), site, approved_origins=origins, install=install
    )
    auth.grants.clear()
    with pytest.raises(BrowserRefused, match="APPROVAL_REQUIRED"):
        await sessions.restore_for_task(binding(), site, approved_origins=origins, install=install)
    assert len(installed) == 1
    assert closed == [site]


async def test_lost_publication_response_retains_ciphertext_for_restart(tmp_path):
    sessions, auth, store, log, site, state, origins, closed = await _session_fixture(tmp_path)
    append = log.append

    async def committed_then_cancelled(kind, payload, **kwargs):
        result = await append(kind, payload, **kwargs)
        if payload.get("operation") == "publish":
            raise asyncio.CancelledError()
        return result

    log.append = committed_then_cancelled
    with pytest.raises(asyncio.CancelledError):
        await sessions.remember(binding(), site, state, approved_origins=origins)
    log.append = append
    keys = await sessions.recovery_inventory()
    assert len(keys) == 1 and await store.get(keys[0]) is not None


async def test_forget_during_final_restore_receipt_check_cannot_install(tmp_path):
    sessions, auth, store, log, site, state, origins, closed = await _session_fixture(tmp_path)
    current = await sessions.remember(binding(), site, state, approved_origins=origins)
    auth.approve(
        "session_restore",
        {
            "site": site,
            "generation": 0,
            "object": current.object_key,
            "digest": current.digest,
            "origins": sorted(origins),
        },
    )
    entered, release = asyncio.Event(), asyncio.Event()
    require = auth.require
    calls = 0

    async def paused(bound, purpose, terms):
        nonlocal calls
        if purpose == "session_restore":
            calls += 1
            if calls == 2:
                entered.set()
                await release.wait()
        await require(bound, purpose, terms)

    auth.require = paused
    installed = []

    async def install(value):
        installed.append(value)

    restoring = asyncio.create_task(
        sessions.restore_for_task(binding(), site, approved_origins=origins, install=install)
    )
    await entered.wait()
    forgetting = asyncio.create_task(sessions.forget(binding(), site))
    await asyncio.sleep(0)
    release.set()
    with pytest.raises(BrowserRefused, match="FORGOTTEN"):
        await restoring
    assert (await forgetting).persisted and installed == []


@pytest.mark.parametrize(
    "declared,chunks,refused",
    [
        ("8", [b"1234", b"5678"], False),
        ("9", [b"123456789"], True),
        (None, [b"1234", b"56789"], True),
    ],
)
def test_remembered_object_reader_bounds_before_materializing(declared, chunks, refused):
    from hushh_mcp.services.pod_bounded_object import ObjectReadTooLarge, read_bounded_response

    class Response:
        status_code = 200
        headers = {} if declared is None else {"Content-Length": declared}
        closed = False

        @property
        def content(self):
            pytest.fail("unbounded response body accessed")

        def iter_content(self, **kwargs):
            return iter(chunks)

        def close(self):
            self.closed = True

    response = Response()
    if refused:
        with pytest.raises(ObjectReadTooLarge):
            read_bounded_response(response, max_bytes=8)
    else:
        assert read_bounded_response(response, max_bytes=8) == b"12345678"
    assert response.closed
