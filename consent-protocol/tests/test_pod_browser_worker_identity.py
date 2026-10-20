"""Native worker identity and private scratch lifecycle; no cloud qualification."""

import pytest

from hushh_mcp.services.pod_browser.contracts import BrowserRefused


def test_worker_privilege_drop_refuses_retained_authority_before_private_scratch(monkeypatch):
    from types import SimpleNamespace

    from hushh_mcp.services.pod_browser import worker_identity as worker

    ids = {"uid": (0, 0, 0), "gid": (0, 0, 0)}
    environment = {}
    capability = "0"
    native = SimpleNamespace(
        geteuid=lambda: ids["uid"][1],
        getgroups=lambda: [],
        setresuid=lambda *values: ids.update(uid=values),
        setresgid=lambda *values: ids.update(gid=values),
        getresuid=lambda: ids["uid"],
        getresgid=lambda: ids["gid"],
        environ=environment,
    )
    monkeypatch.setattr(worker, "os", native)
    monkeypatch.setattr(worker, "sys", SimpleNamespace(platform="linux"))
    monkeypatch.setattr(
        worker,
        "ctypes",
        SimpleNamespace(CDLL=lambda *_args, **_kw: SimpleNamespace(prctl=lambda *_: 0)),
    )
    monkeypatch.setattr(
        worker,
        "Path",
        lambda _: SimpleNamespace(
            read_text=lambda: f"NoNewPrivs: 1\nCapPrm: 0\nCapEff: {capability}\nCapAmb: 0"
        ),
    )
    monkeypatch.setattr(worker, "MemoryScratch", lambda: SimpleNamespace(path="private-scratch"))
    worker.prepare_worker_identity()
    assert ids == {"uid": (10002, 10002, 10002), "gid": (10002, 10002, 10002)}
    assert environment["HOME"] == "private-scratch"

    capability = "1"
    environment.clear()
    with pytest.raises(BrowserRefused, match="WORKER_IDENTITY_REFUSED"):
        worker.prepare_worker_identity()
    assert not environment  # no browser/home initialization under retained authority


async def test_native_probe_releases_private_scratch_if_browser_startup_fails(
    monkeypatch, tmp_path
):
    import sys
    from types import SimpleNamespace

    from hushh_mcp.services.pod_browser import gcp_probe, worker_identity

    closed = []
    monkeypatch.setattr(
        worker_identity,
        "prepare_worker_identity",
        lambda: SimpleNamespace(
            close=lambda: closed.append(True),
        ),
    )
    monkeypatch.setitem(sys.modules, "playwright.async_api", None)
    with pytest.raises(ModuleNotFoundError):
        await gcp_probe._inside(tmp_path)
    assert closed == [True]
