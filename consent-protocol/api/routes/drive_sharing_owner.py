"""Drive owner authentication and placement freshness, shared by route facades."""

from __future__ import annotations

from dataclasses import dataclass, field

from fastapi import Depends, HTTPException, Response

from api.middleware import require_vault_owner_token
from hushh_mcp.services.owner_placement_guard import admit_hub_content, hub_content_owner

NO_STORE = {"Cache-Control": "private, no-store", "Pragma": "no-cache"}


@dataclass(frozen=True)
class Owner:
    user_id: str
    token: str = field(repr=False)

    async def require_current(self):
        # No Request argument: bypass the request-local scope cache after I/O.
        current = await require_vault_owner_token(
            authorization=f"Bearer {self.token}", hushh_consent=None
        )
        if current.get("user_id") != self.user_id:
            raise HTTPException(403, "Owner identity mismatch", headers=NO_STORE)


async def _owner(response: Response, token: dict = Depends(require_vault_owner_token)):
    response.headers.update(NO_STORE)
    user_id = token.get("user_id")
    if not isinstance(user_id, str) or not user_id:
        raise HTTPException(401, "Owner authorization required", headers=NO_STORE)
    return Owner(user_id, token["token"])


@dataclass(frozen=True)
class ContentOwner(Owner):
    async def require_current(self):
        await super().require_current()
        await admit_hub_content(self.user_id, "drive_content")


async def _content_owner(response: Response, token: dict = Depends(hub_content_owner)):
    owner = await _owner(response, token)
    return ContentOwner(owner.user_id, owner.token)
