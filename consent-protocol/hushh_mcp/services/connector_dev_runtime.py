"""Whether this process is a local development runtime on a loopback origin.

One predicate for everything that is allowed to behave differently on a
developer's machine than on a deployed environment: the OAuth redirect
allow-list (`external_connector_google_oauth.registered_redirect_uris`) and the
read-only manifest overlay on the connector registry. Both must agree on what
"local development" means, and neither may ever turn on in a deployed process,
so the rule lives here once: `ENVIRONMENT=development` AND a frontend origin
that is a plain `http` loopback host.
"""

from __future__ import annotations

import os

from hushh_mcp.runtime_settings import get_app_runtime_settings

LOCAL_WEB_RETURN_PATH = "/one/profile/connectors/oauth/return"
_LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "[::1]"})


def loopback_development_origin() -> str | None:
    """The frontend origin when this is a loopback development runtime, else None."""
    if os.getenv("ENVIRONMENT", "").strip().lower() != "development":
        return None
    origin = get_app_runtime_settings().app_frontend_origin
    scheme, _, rest = origin.partition("://")
    host = rest.split("/", 1)[0].rsplit(":", 1)[0] if rest else ""
    if scheme != "http" or host not in _LOOPBACK_HOSTS or "@" in rest or "/" in rest:
        return None
    return origin
