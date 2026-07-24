from pathlib import Path


AGENTS_DIR = Path("agents")
REPORT_PATH = Path("reports/agent_runtime_report.md")


def inspect_agent(agent_path):
    checks = {
        "README": (agent_path / "README.md").exists(),
        "Manifest": (agent_path / "manifest.py").exists(),
        "Tests": (agent_path / "tests").exists(),
    }

    return checks


def generate_report():
    report_lines = ["# Agent Runtime Diagnostics Report\n"]

    if not AGENTS_DIR.exists():
        report_lines.append("No agents directory found.\n")

        with open(REPORT_PATH, "w", encoding="utf-8") as report:
            report.write("\n".join(report_lines))

        return

    for agent_dir in AGENTS_DIR.iterdir():
        if agent_dir.is_dir():
            report_lines.append(f"## Agent: {agent_dir.name}\n")

            checks = inspect_agent(agent_dir)

            for item, status in checks.items():
                icon = "PASS" if status else "FAIL"
                report_lines.append(f"- {item}: {icon}")

            report_lines.append("")

    with open(REPORT_PATH, "w", encoding="utf-8") as report:
        report.write("\n".join(report_lines))

    print("Diagnostics report generated")
    print(f"Report location: {REPORT_PATH}")


if __name__ == "__main__":
    generate_report()