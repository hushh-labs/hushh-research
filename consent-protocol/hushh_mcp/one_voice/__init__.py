"""One Live Voice: Gemini Live relay on Vertex ADC with a typed tool layer.

The model interprets speech; only the typed tools in :mod:`hushh_mcp.one_voice.tools`
can read or change state. Nothing in this package constructs a provider client
directly -- clients come from :mod:`hushh_mcp.runtime_providers.factory`.
"""
