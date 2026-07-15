import logging

import uvicorn
from flask import Flask
from python_a2a.models.agent import AgentCard

# Import WSGI Middleware from Uvicorn
from uvicorn.middleware.wsgi import WSGIMiddleware

from hushh_mcp.adk_bridge.kai_agent import KaiA2AServer
from hushh_mcp.agents.kai.manifest import MANIFEST

# Configure Logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("server_a2a")


def create_app():
    """
    Creates the ADK A2A Application (Flask -> ASGI).
    """
    logger.info("Initializing Agent Kai (A2A Server)...")

    # 1. Create Flask App
    flask_app = Flask(__name__)

    # 2. Generate Agent Card
    agent_card = AgentCard(
        name=MANIFEST["name"],
        version=MANIFEST["version"],
        description=MANIFEST["description"],
        url="http://localhost:8001",
        capabilities={
            "streaming": True,
            # Flatten capabilities dict for A2A
            **{k: v for k, v in MANIFEST.get("capabilities", {}).items()},
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


# Create Flask App
flask_app = create_app()

# Wrap in ASGI for Uvicorn
app = WSGIMiddleware(flask_app)

if __name__ == "__main__":
    logger.info("Starting Kai A2A Server on Port 8001 (WSGI/ASGI)...")
    uvicorn.run(app, host="0.0.0.0", port=8001)  # noqa: S104
