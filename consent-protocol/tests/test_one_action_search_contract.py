"""The browser's action search and the server that answers it must agree.

The client sent `GET /api/one/actions/search?query=...` with no VAULT_OWNER
token. The server has always served that path as an authenticated POST. Every
call was therefore a 405 or a 401, and the single caller
(`searchKaiActionsSemantic` in lib/voice/kai-action-gateway.ts) catches every
failure and returns `[]` -- so a broken endpoint and "nothing matched" produced
the same empty command palette. Nobody could see it.

There is also a second, unmounted implementation of this exact path in
`api/routes/one/action_proposals.py`, whose router is imported and exported in
`api/routes/one/__init__.py` but deliberately never included. It returns a
different response shape (`{results, ranking}`) than the live handler
(`{status, query, total, results}`). Mounting it would not add an endpoint --
it would silently replace the one the palette already depends on, because
FastAPI resolves to the first matching route.

So the invariant worth holding is not "mount everything imported". It is that
exactly one handler answers this path, and that it stays a POST.
"""

from __future__ import annotations

import api.routes.one as one_routes

SEARCH_PATH = "/api/one/actions/search"


def _routes_for(path: str) -> list[object]:
    return [route for route in one_routes.router.routes if getattr(route, "path", "") == path]


def test_the_action_search_path_is_served_exactly_once() -> None:
    """A second handler for this path shadows the live one instead of adding to it.

    action_proposals.py declares the same route. If someone "fixes" its unused
    import by mounting the router, the palette silently starts reading a
    different response shape from a different implementation -- with no error
    anywhere, because the caller swallows failures.
    """
    matches = _routes_for(SEARCH_PATH)
    assert len(matches) == 1, (
        f"expected exactly one handler for {SEARCH_PATH}, found {len(matches)}. "
        "A duplicate almost certainly means action_proposals_router was mounted; "
        "it shadows the live agent_chat handler rather than supplementing it."
    )


def test_the_action_search_endpoint_stays_a_post() -> None:
    """Pinned because the client drifted to GET and nothing said so."""
    matches = _routes_for(SEARCH_PATH)
    assert matches, f"{SEARCH_PATH} is not mounted at all"
    methods: set[str] = set()
    for route in matches:
        methods |= set(getattr(route, "methods", set()) or set())
    assert "POST" in methods, f"expected POST, got {sorted(methods)}"
    assert "GET" not in methods, (
        "The client used to send GET here and silently got 405s. If GET is "
        "genuinely wanted, change the client deliberately rather than widening "
        "the server to absorb a mistake."
    )
