"""The route the app actually serves must carry the CWE-400 path bounds.

`server.py` mounts `pkm.router` and `pkm_routes_shared.router` at the same
`/api/pkm` prefix, one line apart. FastAPI resolves first-registered-wins, so
`api.routes.pkm` serves every colliding path and the shared module's bounds
sit on handlers no request ever reaches.

The existing bounds tests build their own `FastAPI()` and mount only the
shared router, so they assert against a handler production does not use.
These tests go through the real `server.app` instead, which is the only
object whose behaviour is the product's behaviour.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

import server
from api.middleware import require_vault_owner_token
from api.routes.pkm import require_pkm_metadata_access

_USER_ID = "test-user-id"
_TOKEN_DATA = {"user_id": _USER_ID, "token": "stub-tok", "scope": "vault.owner"}
_OVERLONG = "u" * 129

# Every /api/pkm path whose user_id is taken from the URL, with the method the
# app serves it under. Each is served by api.routes.pkm.
_USER_ID_ROUTES = [
    ("post", "/api/pkm/reconcile/{user_id}"),
    ("get", "/api/pkm/metadata/{user_id}"),
    ("get", "/api/pkm/upgrade/status/{user_id}"),
    ("get", "/api/pkm/scopes/{user_id}"),
    ("get", "/api/pkm/data/{user_id}"),
]


@pytest.fixture(scope="module")
def client() -> TestClient:
    """The real app, with only the auth dependencies stubbed."""
    server.app.dependency_overrides[require_vault_owner_token] = lambda: _TOKEN_DATA
    server.app.dependency_overrides[require_pkm_metadata_access] = lambda: _TOKEN_DATA
    try:
        yield TestClient(server.app, raise_server_exceptions=False)
    finally:
        server.app.dependency_overrides.pop(require_vault_owner_token, None)
        server.app.dependency_overrides.pop(require_pkm_metadata_access, None)


@pytest.mark.parametrize("method,template", _USER_ID_ROUTES)
def test_served_route_rejects_an_oversized_user_id(client, method, template):
    """422 from path validation, before any dependency or handler body runs.

    A 403 here means the length bound is on the shadowed handler only: the
    request reached the ownership check, so validation never fired.
    """
    path = template.format(user_id=_OVERLONG)
    response = getattr(client, method)(path)
    assert response.status_code == 422, (
        f"{method.upper()} {template} accepted a 129-char user_id "
        f"(got {response.status_code}); the served handler has no length bound"
    )


def test_the_pkm_prefix_is_mounted_twice_on_purpose():
    """Pin the shadowing itself, so a silent third mount is visible.

    Both routers are required: each owns paths the other does not. This is
    the invariant that makes the bounds above necessary in pkm.py.
    """
    served: dict[tuple[str, str], list[str]] = {}
    for route in server.app.routes:
        for method in getattr(route, "methods", None) or []:
            key = (method, getattr(route, "path", ""))
            if not key[1].startswith("/api/pkm"):
                continue
            served.setdefault(key, []).append(route.endpoint.__module__)

    shadowed = {k: v for k, v in served.items() if len(v) > 1}
    assert shadowed, "expected the known /api/pkm duplicate mount"
    # api.routes.pkm registers first, so it serves every collision.
    for key, modules in shadowed.items():
        assert modules[0] == "api.routes.pkm", (
            f"{key} is now served by {modules[0]}, not api.routes.pkm; "
            "the mount order in server.py changed and the bounds moved with it"
        )
