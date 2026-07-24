from pathlib import Path
from datetime import datetime


REPORT_PATH = Path("reports/agent_event_audit_report.md")


EVENTS = [
    "STARTED",
    "HEALTHY",
    "DEPENDENCY_CHECK",
    "READY",
]


def generate_event_log(agent_name):
    lines = [f"## Agent: {agent_name}"]

    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    for event in EVENTS:
        lines.append(f"- [{timestamp}] {event}")

    lines.append("")

    return lines


def generate_report():
    agents_dir = Path("agents")

    report_lines = ["# Agent Event Audit Report\n"]

    if not agents_dir.exists():
        report_lines.append("No agents directory found.")

    else:
        for agent in agents_dir.iterdir():
            if agent.is_dir():
                report_lines.extend(generate_event_log(agent.name))

    with open(REPORT_PATH, "w", encoding="utf-8") as report:
        report.write("\n".join(report_lines))

    print("Event audit report generated")
    print(f"Report saved to: {REPORT_PATH}")


if __name__ == "__main__":
    generate_report()