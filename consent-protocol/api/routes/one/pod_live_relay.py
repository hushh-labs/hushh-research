"""Hub admission and a no-redirect connection to the owner's registered pod.

No provider runs here. The existing ticket endpoint remains responsible for
browser authentication; this function accepts only its verified Firebase UID.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

from websockets.asyncio.client import connect

from api.routes.one.pod_live_authority import HubVoiceAuthority
from api.routes.one.pod_live_courier import run_live_courier
from api.routes.one.pod_live_transport import MAX_FRAME_BYTES
from api.routes.one.pod_relay import _identity_token, _pod_url, _require_enabled
from hushh_mcp.consent.token import validate_token_with_db
from hushh_mcp.constants import ConsentScope
from hushh_mcp.services.action_directive_ledger import get_action_directive_store
from hushh_mcp.services.personal_agent_grant_service import (
    PERSONAL_AGENT_ID,
    PersonalAgentGrantService,
)
from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo
from hushh_mcp.services.pod_access_audit import PodAccessAuditService, _owner_binding_denials

# websockets debug logging contains handshake headers and entire frames. Never
# send this credential-bearing wire lane to application logging, even in DEBUG.
_WIRE_LOGGER = logging.Logger("private-pod-live-wire")
_WIRE_LOGGER.disabled = True
logger = logging.getLogger(__name__)


class NoRedirectConnect(connect):
    """Reject every redirect using the pinned websocket client's redirect seam."""

    def process_redirect(self, exc: Exception) -> Exception:
        return exc


def _socket_url(url: str) -> str:
    parsed = urlsplit(url)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
    ):
        raise ValueError("private pod endpoint unavailable")
    return "wss://" + parsed.netloc + "/api/one/pod/live"


@dataclass
class HubLiveAdmission:
    user_id: str
    hushh_id: str
    url: str
    session_id: str
    token: str = field(repr=False)
    registry: Any = field(repr=False)

    async def require_access(self) -> None:
        _require_enabled()
        row = await self.registry.get(self.user_id)
        if _owner_binding_denials(row, self.hushh_id) or _pod_url(row) != self.url:
            raise PermissionError("private voice owner unavailable")
        valid, _, parsed = await validate_token_with_db(
            self.token, expected_scope=ConsentScope.PKM_READ.value
        )
        if (
            not valid
            or parsed is None
            or parsed.user_id != self.user_id
            or parsed.agent_id != PERSONAL_AGENT_ID
        ):
            raise PermissionError("private voice consent unavailable")


async def admit_private_live(user_id: str) -> HubLiveAdmission:
    """Resolve and receipt serving ownership before grant or network access."""
    _require_enabled()
    if not user_id:
        raise PermissionError("private voice owner required")
    registry = PersonalAgentRegistryRepo()
    row = await registry.get(user_id)
    if _owner_binding_denials(row, None):
        raise PermissionError("private voice owner unavailable")
    hushh_id = row["hushh_id"]
    await PodAccessAuditService(registry=registry).authorize_owner_read(
        user_id=user_id,
        agent_id=PERSONAL_AGENT_ID,
        scope=ConsentScope.PKM_READ.value,
        hushh_id=hushh_id,
        request_id="relay-live:" + uuid.uuid4().hex,
    )
    url = _pod_url(row)
    _socket_url(url or "")
    grant = await PersonalAgentGrantService().issue_or_reuse_standing_pkm_read(user_id)
    token = str(grant.get("token") or "")
    if not token:
        raise PermissionError("private voice consent unavailable")
    admission = HubLiveAdmission(
        user_id, hushh_id, url, "voice_" + uuid.uuid4().hex, token, registry
    )
    await admission.require_access()
    return admission


class PodSocket:
    def __init__(self, socket: Any) -> None:
        self.socket = socket

    async def receive_text(self) -> str:
        frame = await self.socket.recv()
        if not isinstance(frame, str):
            raise ValueError("private voice requires text frames")
        return frame

    async def send_text(self, data: str) -> None:
        await self.socket.send(data)

    async def close(self, code: int = 1000, reason: str | None = None) -> None:
        await self.socket.close(code=code, reason=reason or "")


async def relay_private_live(browser: Any, *, user_id: str) -> None:
    """Called only after the hub consumes its existing one-use browser ticket."""
    try:
        async with asyncio.timeout(30.0):
            admission = await admit_private_live(user_id)
            identity = await asyncio.to_thread(_identity_token, admission.url)
            if not identity:
                raise PermissionError("private voice hub identity unavailable")
            await admission.require_access()
        async with NoRedirectConnect(
            _socket_url(admission.url),
            additional_headers={
                "Authorization": "Bearer " + identity,
                "X-Consent-Token": admission.token,
                "X-Hussh-Voice-Session": admission.session_id,
            },
            proxy=None,
            compression=None,
            logger=_WIRE_LOGGER,
            open_timeout=10.0,
            close_timeout=3.0,
            max_size=MAX_FRAME_BYTES,
            max_queue=8,
        ) as socket:
            identity = None
            await run_live_courier(
                browser,
                PodSocket(socket),
                authority=HubVoiceAuthority(
                    user_id=admission.user_id,
                    session_id=admission.session_id,
                    require_access=admission.require_access,
                    store=get_action_directive_store(),
                ),
                require_access=admission.require_access,
            )
    except Exception as error:
        logger.warning("private_voice_relay_unavailable error=%s", type(error).__name__)
    finally:
        try:
            async with asyncio.timeout(3.0):
                await browser.close(code=1008, reason="Private voice connection ended.")
        except Exception:
            pass
