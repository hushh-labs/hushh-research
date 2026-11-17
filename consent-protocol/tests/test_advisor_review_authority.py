"""Hub classification and actor/vault authentication protect every new entrypoint."""

from fastapi.routing import APIRoute
from test_finance_recipient_hub_authority import dependency_calls

from api.hub_route_classes import ROUTE_CLASSES, RouteClass
from api.middleware import require_firebase_auth, require_vault_owner_token
from api.routes.one.advisor_reviews import router
from api.routes.one.finance_sharing import identity
from hushh_mcp.services.owner_placement_guard import hub_content_owner


def test_all_review_routes_retain_firebase_and_matching_vault_owner():
    for route in router.routes:
        assert isinstance(route, APIRoute)
        calls = set(dependency_calls(route.dependant))
        assert {identity, require_firebase_auth, require_vault_owner_token} <= calls
        for method in route.methods:
            assert (method, route.path) in ROUTE_CLASSES


def test_calendar_execution_keeps_content_placement_guard():
    route = next(r for r in router.routes if r.path.endswith("/meeting/action"))
    assert ROUTE_CLASSES[("POST", route.path)] is RouteClass.CONTENT
    assert hub_content_owner in set(dependency_calls(route.dependant))
    for suffix in ("/decision", "/meeting/decision", "/billing"):
        selected = [r for r in router.routes if r.path.endswith(suffix)]
        assert selected
        for candidate in selected:
            assert hub_content_owner not in set(dependency_calls(candidate.dependant))
