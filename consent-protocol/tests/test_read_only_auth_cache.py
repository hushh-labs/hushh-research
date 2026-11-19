from __future__ import annotations

from contextlib import contextmanager


def test_read_only_tombstone_and_device_positive_caches(monkeypatch):
    from api.middlewares.observability import _read_only_request_ctx
    from hushh_mcp.services import account_deletion_lifecycle_service as deletion_mod
    from hushh_mcp.services import trusted_device_service as device_mod

    deletion_mod.invalidate_tombstone_cache()
    device_mod.invalidate_active_device_cache("u_cache_1")

    db_tombstone_calls = 0
    tombstoned_flag = False

    class _FakeExecResult:
        def first(self):
            return ("erased",) if tombstoned_flag else None

    class _FakeConn:
        def execute(self, *_args, **_kwargs):
            return _FakeExecResult()

    @contextmanager
    def _fake_conn():
        nonlocal db_tombstone_calls
        db_tombstone_calls += 1
        yield _FakeConn()

    monkeypatch.setattr(
        deletion_mod, "_allow_read_only_tombstone_cache", lambda: _read_only_request_ctx.get()
    )
    monkeypatch.setattr(deletion_mod, "get_db_connection", _fake_conn)

    # Read-only request caches False once and invalidates on explicit call.
    tok = _read_only_request_ctx.set(True)
    try:
        assert deletion_mod.AccountDeletionLifecycleService.is_tombstoned("u_cache_1") is False
        assert deletion_mod.AccountDeletionLifecycleService.is_tombstoned("u_cache_1") is False
        assert db_tombstone_calls == 1
        deletion_mod.invalidate_tombstone_cache("u_cache_1")
        tombstoned_flag = True
        assert deletion_mod.AccountDeletionLifecycleService.is_tombstoned("u_cache_1") is True
        # True results must never be cached.
        assert deletion_mod.AccountDeletionLifecycleService.is_tombstoned("u_cache_1") is True
        assert db_tombstone_calls == 3
    finally:
        _read_only_request_ctx.reset(tok)

    # Mutations never read the cache even if an entry exists.
    tombstoned_flag = False
    tok = _read_only_request_ctx.set(False)
    try:
        assert deletion_mod.AccountDeletionLifecycleService.is_tombstoned("u_cache_1") is False
        assert db_tombstone_calls == 4
    finally:
        _read_only_request_ctx.reset(tok)

    # Active device cache mirrors the same read-only contract + revoke invalidation.
    store_lookups = 0

    class _FakeStore:
        def get_active_device(self, *, user_id: str, device_id: str):
            nonlocal store_lookups
            store_lookups += 1
            return {"device_id": device_id, "user_id": user_id, "status": "active"}

        def revoke_device(self, *, user_id: str, device_id: str, now_ms: int) -> bool:
            return True

        def audit(self, **_kwargs) -> None:
            return None

    svc = device_mod.TrustedDeviceService(store=_FakeStore())
    monkeypatch.setattr(
        device_mod, "_allow_read_only_device_cache", lambda: _read_only_request_ctx.get()
    )
    dev_id = "tdv_" + ("a" * 24)
    tok = _read_only_request_ctx.set(True)
    try:
        assert svc.is_active_device(user_id="u_cache_1", device_id=dev_id) is True
        assert svc.is_active_device(user_id="u_cache_1", device_id=dev_id) is True
        assert store_lookups == 1
        assert svc.revoke_device(user_id="u_cache_1", device_id=dev_id) is True
        assert svc.is_active_device(user_id="u_cache_1", device_id=dev_id) is True
        assert store_lookups == 2
    finally:
        _read_only_request_ctx.reset(tok)
    deletion_mod.invalidate_tombstone_cache()
    device_mod.invalidate_active_device_cache("u_cache_1")
