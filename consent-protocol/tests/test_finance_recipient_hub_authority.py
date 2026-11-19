"""Recipient-picker authority stays owner authenticated without reading Finance contents."""

import pytest
from fastapi import HTTPException
from fastapi.routing import APIRoute

from api.hub_route_classes import ROUTE_CLASSES, RouteClass
from api.middleware import require_firebase_auth, require_vault_owner_token
from api.routes.one.finance_sharing import identity, router


def dependency_calls(node):
    for child in node.dependencies:
        yield child.call
        yield from dependency_calls(child)


def test_finance_recipient_authority_metadata_keeps_owner_authentication():
    key = ("GET", "/api/one/finance/shares/active-recipients")
    assert ROUTE_CLASSES[key] is RouteClass.AUTHORITY
    route = next(
        route
        for route in router.routes
        if isinstance(route, APIRoute) and route.path == key[1] and key[0] in route.methods
    )
    calls = set(dependency_calls(route.dependant))
    assert identity in calls
    assert require_firebase_auth in calls
    assert require_vault_owner_token in calls


@pytest.mark.asyncio
async def test_finance_metadata_rejects_another_owners_vault_token():
    with pytest.raises(HTTPException) as refused:
        await identity(uid="owner-a", consent={"user_id": "owner-b"})
    assert refused.value.status_code == 403
    assert refused.value.detail == {"code": "FINANCE_SHARE_OWNER_MISMATCH"}
