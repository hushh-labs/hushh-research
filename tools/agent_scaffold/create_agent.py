def create_agent(agent_name):
    agent_dir = Path("agents") / agent_name

    (agent_dir / "tests").mkdir(parents=True, exist_ok=True)

    with open(agent_dir / "README.md", "w", encoding="utf-8") as file:
        file.write(f"# {agent_name}\n")

    with open(agent_dir / "manifest.py", "w", encoding="utf-8") as file:
        file.write(f"AGENT_NAME = '{agent_name}'\n")

    print(f"Agent '{agent_name}' created")
    print("=" * 35)
    print(f"Location : {agent_dir}")
    print("Ready for development")