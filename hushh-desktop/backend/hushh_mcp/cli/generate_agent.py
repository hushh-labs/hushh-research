# hushh_mcp/cli/generate_agent.py

import argparse
from pathlib import Path

AGENTS_DIR = Path(__file__).resolve().parent.parent / "agents"


def snake_case(name: str) -> str:
    return name.lower().replace("-", "_").replace(" ", "_")


def generate_index_py(agent_id: str) -> str:
    return f"""# hushh_mcp/agents/{agent_id}/index.py

def run_agent():
    print(\"{agent_id} agent initialized.\")
"""


def generate_manifest_py(agent_id: str) -> str:
    return f"""# hushh_mcp/agents/{agent_id}/manifest.py

manifest = {{
    "id": "{agent_id}",
    "name": "{agent_id.replace("_", " ").title()} Agent",
    "scopes": ["attr.food.*"],
    "version": "0.1.0",
    "description": "Generated agent for {agent_id}"
}}
"""


def create_agent(agent_name: str):
    agent_id = snake_case(agent_name)
    agent_path = AGENTS_DIR / agent_id
    agent_path.mkdir(parents=True, exist_ok=True)

    index_path = agent_path / "index.py"
    manifest_path = agent_path / "manifest.py"

    if index_path.exists() or manifest_path.exists():
        print(f"⚠️ Agent '{agent_id}' already exists. Skipping overwrite.")
        return

    index_path.write_text(generate_index_py(agent_id))
    manifest_path.write_text(generate_manifest_py(agent_id))

    print(f"✅ Agent scaffolded: hushh_mcp/agents/{agent_id}/")


def main():
    parser = argparse.ArgumentParser(description="HushhMCP Agent Generator CLI")
    parser.add_argument("name", help="Agent name (e.g., finance-coach or order_bot)")
    args = parser.parse_args()
    create_agent(args.name)


if __name__ == "__main__":
    main()
