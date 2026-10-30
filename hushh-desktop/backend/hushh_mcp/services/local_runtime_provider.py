"""Desktop-only glue: exposes the on-device local model as a standard runtime
provider, so Kai (and any One/Hermes caller) reaches it through the exact same
``runtime_client`` facade as Gemini/OpenAI/Anthropic/Grok -- never a hardcoded
local branch.

This is the "local/on-device adapter path for One" the maintainer asked for,
built to stay ON the One/Hermes runtime boundary rather than beside it:

  * It adds NO new transport and modifies NONE of the vendored
    ``hushh_mcp/runtime_providers/*`` files (they stay byte-identical to
    upstream ``consent-protocol``, so future syncs stay trivial). It just
    constructs upstream's own ``OpenAITransport`` pointed at a different
    ``base_url`` -- exactly how upstream already supports Grok/x.ai
    (``OpenAITransport(base_url=GROK_BASE_URL, provider="grok")``).
  * The ``base_url`` is the local bridge (``local_bridge/server.py``, port
    18182), which presents GenieX as a spec-compliant, tool-calling-capable
    OpenAI surface -- i.e. an Open-WebUI/OpenAI-compatible surface, the
    convention One/Hermes speak, not a desktop-private protocol.

Why a desktop-side helper rather than a new ``ProviderId`` in the vendored
registry: "local/on-device" is a desktop concept the cloud webapp has no
reason to carry, so keeping it out of the shared registry keeps the boundary
clean in both directions. Callers use ``build_local_runtime_client()`` to get
a genai-client-shaped object and then treat it identically to a cloud client.
"""

from __future__ import annotations

from typing import Any

# Fixed local bridge address -- must match local_bridge/server.py's BRIDGE_PORT
# and the "/v1" base the OpenAI SDK expects. The bridge (not GenieX at 18181)
# is the target because it guarantees OpenAI streaming/finish_reason compliance
# and adds the tool-calling translation GenieX itself lacks.
LOCAL_BRIDGE_BASE_URL = "http://localhost:18182/v1"

# Provider label carried on the transport for logging/telemetry. Deliberately
# not a registry ProviderId (see module docstring) -- it never flows through
# normalize_provider().
LOCAL_PROVIDER_LABEL = "local"

# The OpenAI SDK requires a non-empty api_key even when the backend ignores it;
# the local bridge does no auth, so any placeholder works.
_LOCAL_PLACEHOLDER_KEY = "local-no-auth"


def build_local_runtime_client(*, base_url: str = LOCAL_BRIDGE_BASE_URL) -> Any:
    """Return a genai-client-shaped runtime client bound to the local bridge.

    The returned object exposes the same
    ``client.aio.models.generate_content(...)`` /
    ``generate_content_stream(...)`` surface every other provider does (via
    ``runtime_providers.base.ProviderTransport``), so callers never branch on
    local-vs-cloud.
    """
    from hushh_mcp.runtime_providers.openai_transport import OpenAITransport

    return OpenAITransport(
        api_key=_LOCAL_PLACEHOLDER_KEY,
        base_url=base_url,
        provider=LOCAL_PROVIDER_LABEL,
    )
