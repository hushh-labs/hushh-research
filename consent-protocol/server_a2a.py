import logging
import os
from pathlib import Path
from typing import Any

import uvicorn
from flask import Flask
from python_a2a.models.agent import AgentCard

# Import WSGI Middleware from Uvicorn
from uvicorn.middleware.wsgi import WSGIMiddleware

from hushh_mcp.adk_bridge.kai_agent import KaiA2AServer
from hushh_mcp.hushh_adk.manifest import ManifestLoader

# Configure Logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("server_a2a")
KAI_MANIFEST_PATH = Path(__file__).parent / "hushh_mcp" / "agents" / "kai" / "agent.yaml"


def create_legacy_app() -> Flask:
    """
    Creates the ADK A2A Application (Flask -> ASGI).
    """
    logger.info("Initializing Agent Kai (A2A Server)...")

    # 1. Create Flask App
    flask_app = Flask(__name__)

    # 2. Generate Agent Card
    manifest = ManifestLoader.load(str(KAI_MANIFEST_PATH))
    agent_card = AgentCard(
        name=manifest.name,
        version=manifest.version,
        description=manifest.description,
        url="http://localhost:8001",
        capabilities={
            "streaming": True,
            # Flatten capabilities dict for A2A
            **manifest.capabilities,
        },
        default_input_modes=["text/plain"],
        default_output_modes=["text/plain"],
    )

    # 3. Initialize Server
    # Note: We pass standard kwargs that BaseA2AServer expects + agent_card
    server = KaiA2AServer(agent_card=agent_card, google_a2a_compatible=True)

    # 4. Bind Routes
    server.setup_routes(flask_app)

    return flask_app


def create_app() -> Any:
    """Select the additive ADK-native transport only when explicitly enabled."""
    mode = str(os.getenv("HUSHH_KAI_A2A_TRANSPORT", "legacy")).strip().lower()
    if mode == "official_adk":
        from hushh_mcp.adk_bridge.official_a2a import create_kai_official_a2a_app

        return create_kai_official_a2a_app()
    if mode != "legacy":
        raise ValueError("HUSHH_KAI_A2A_TRANSPORT must be 'legacy' or 'official_adk'.")
    return create_legacy_app()


# Create Flask App
flask_app = create_app()

# Wrap in ASGI for Uvicorn
app = WSGIMiddleware(flask_app) if isinstance(flask_app, Flask) else flask_app

if __name__ == "__main__":
    logger.info("Starting Kai A2A Server on Port 8001 (WSGI/ASGI)...")
    uvicorn.run(app, host="0.0.0.0", port=8001)  # noqa: S104
