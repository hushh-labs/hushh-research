from pathlib import Path


AGENTS_DIR = Path("agents")
REPORT_PATH = Path("reports/agent_compliance_report.md")


REQUIRED_FILES = [
    "README.md",
    "manifest.py",
]


def validate_agent(agent_path):
    results = {}

    for required in REQUIRED_FILES:
        results[required] = (agent_path / required).exists()

    results["tests"] = (agent_path / "tests").exists()

    return results


def generate_report():
    lines = ["# Agent Compliance Report\n"]

    if not AGENTS_DIR.exists():
        lines.append("No agents directory found.")

        with open(REPORT_PATH, "w", encoding="utf-8") as report:
            report.write("\n".join(lines))

        return

    for agent in AGENTS_DIR.iterdir():
        if agent.is_dir():
            lines.append(f"## Agent: {agent.name}")

            validation = validate_agent(agent)

            for item, passed in validation.items():
                status = "PASS" if passed else "FAIL"
                lines.append(f"- {item}: {status}")

            lines.append("")

    with open(REPORT_PATH, "w", encoding="utf-8") as report:
        report.write("\n".join(lines))

    print("Compliance report generated")
    print(f"Report saved to: {REPORT_PATH}")


if __name__ == "__main__":
    generate_report()