from __future__ import annotations


def test_read_only_tombstone_negative_cache(monkeypatch):
    from api.middlewares.observability import _read_only_request_ctx
    from hushh_mcp.services import read_only_auth_cache

    read_only_auth_cache.invalidate_tombstone_cache()
    db_tombstone_calls = 0
    tombstoned_flag = False

    def _probe_and_settle(uid: str) -> bool:
        use_cache, cached_clear = read_only_auth_cache.probe_cached_not_tombstoned(uid)
        if cached_clear:
            return False
        nonlocal db_tombstone_calls
        db_tombstone_calls += 1
        row = ("erased",) if tombstoned_flag else None
        return read_only_auth_cache.settle_tombstone_row(
            uid,
            row,
            use_cache=use_cache,
            in_progress_exc_cls=RuntimeError,
        )

    monkeypatch.setattr(
        read_only_auth_cache, "allow_read_only_auth_cache", lambda: _read_only_request_ctx.get()
    )

    tok = _read_only_request_ctx.set(True)
    try:
        assert _probe_and_settle("u_cache_1") is False
        assert _probe_and_settle("u_cache_1") is False
        assert db_tombstone_calls == 1
        read_only_auth_cache.invalidate_tombstone_cache("u_cache_1")
        tombstoned_flag = True
        assert _probe_and_settle("u_cache_1") is True
        assert _probe_and_settle("u_cache_1") is True
        assert db_tombstone_calls == 3
    finally:
        _read_only_request_ctx.reset(tok)

    tombstoned_flag = False
    tok = _read_only_request_ctx.set(False)
    try:
        assert _probe_and_settle("u_cache_1") is False
        assert db_tombstone_calls == 4
    finally:
        _read_only_request_ctx.reset(tok)
    read_only_auth_cache.invalidate_tombstone_cache()


def test_read_only_active_device_positive_cache(monkeypatch):
    from api.middlewares.observability import _read_only_request_ctx
    from hushh_mcp.services import read_only_auth_cache
    from hushh_mcp.services import trusted_device_service as device_mod

    read_only_auth_cache.invalidate_active_device_cache("u_cache_1")
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
        read_only_auth_cache, "allow_read_only_auth_cache", lambda: _read_only_request_ctx.get()
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
    read_only_auth_cache.invalidate_active_device_cache("u_cache_1")
