from pathlib import Path

BASE_DIR = Path(__file__).parent
TEMPLATE_DIR = BASE_DIR / "templates" / "fastapi"


def create_agent(agent_name):
    root = Path("agents") / agent_name

    folders = [
        root / "app",
        root / "tests"
    ]

    for folder in folders:
        folder.mkdir(parents=True, exist_ok=True)

    gitkeep = root / "tests" / ".gitkeep"
    gitkeep.touch(exist_ok=True)

    files = {
        "main.py.template": root / "app" / "main.py",
        "manifest.py.template": root / "manifest.py",
        "requirements.txt.template": root / "requirements.txt",
        "README.md.template": root / "README.md",
    }

    for template_name, output_path in files.items():
        template_path = TEMPLATE_DIR / template_name

        content = template_path.read_text()

        content = content.replace("{{AGENT_NAME}}", agent_name)

        output_path.write_text(content)

    print("\n===================================")
    print(f"✅ Agent '{agent_name}' created")
    print("===================================")
    print(f"📁 Location : {root}")
    print("🚀 Ready for development")


if __name__ == "__main__":
    name = input("Enter agent name: ").strip().lower().replace(" ", "-")
    create_agent(name)