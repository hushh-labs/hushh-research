"""Choose how a Wallet Profile pass gets signed, and hide that choice.

The route asks two questions — *can we sign?* and *sign this* — and must not
care which identity answers. Two providers exist:

``local``
    Sign in-process from the PEMs in Secret Manager, as
    ``pass.com.hushh.app.one``. This is the default, so a deployment that sets
    nothing keeps exactly the behaviour it already had.

``service``
    Delegate to the org-owned ``hushh-wallet-api``, which signs as
    ``pass.com.hushh.wallet`` with a certificate this project never sees.

Switching is one environment variable, which is what makes the integration
reversible: flip ``WALLET_PASS_PROVIDER`` back to ``local`` and redeploy.

Both providers raise the same ``WalletPassSigningUnavailableError`` on failure,
so the route keeps returning its single friendly 503 and a visitor can never
tell the two apart.
"""

from __future__ import annotations

import logging

from PIL import Image

from hushh_mcp.runtime_settings import get_wallet_pass_settings
from hushh_mcp.services import hushh_wallet_api_client
from hushh_mcp.services.apple_wallet_pass_service import (
    WalletPassContent,
    build_pkpass,
)
from hushh_mcp.services.apple_wallet_pass_service import (
    wallet_pass_signing_available as _local_signing_available,
)

logger = logging.getLogger(__name__)

SERVICE_PROVIDER = "service"
LOCAL_PROVIDER = "local"


def active_provider() -> str:
    """``service`` or ``local`` — anything unrecognised falls back to local."""
    settings = get_wallet_pass_settings()
    return SERVICE_PROVIDER if settings.uses_service_provider else LOCAL_PROVIDER


def signing_available() -> bool:
    """Whether the active provider could sign a pass right now.

    Deliberately cheap: the route calls this before rendering anything, so a
    deployment with the feature on but signing unconfigured pays a settings
    read rather than an image render or a network round trip.
    """
    settings = get_wallet_pass_settings()
    if settings.uses_service_provider:
        return settings.service_is_complete
    return _local_signing_available()


def build_wallet_pass(
    content: WalletPassContent,
    *,
    avatar_image: Image.Image | None = None,
) -> bytes:
    """Return the signed ``.pkpass`` bytes from whichever provider is active.

    ``avatar_image`` is honoured only by the local provider. The service card
    is a flat gold membership card with no thumbnail slot, so an avatar has
    nowhere to render and is dropped rather than silently resized into nothing.
    """
    settings = get_wallet_pass_settings()
    if settings.uses_service_provider:
        return hushh_wallet_api_client.sign_pass(
            content,
            base_url=settings.api_base_url,
            api_key=settings.api_key,
        )
    return build_pkpass(content, avatar_image=avatar_image)
