from pathlib import Path
from datetime import datetime

REPORT_PATH = Path("reports/recovery_audit_report.md")

AGENT_EVENTS = [
    "FAILED",
    "RETRY_ATTEMPT_1",
    "RECOVERY_SUCCESS",
    "HEALTHY",
]


def simulate_recovery(agent_name):
    lines = [f"## Agent: {agent_name}"]

    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    for event in AGENT_EVENTS:
        lines.append(f"- [{timestamp}] {event}")

    lines.append("")

    return lines


def generate_report():
    agents_dir = Path("agents")

    report_lines = ["# Agent Recovery Audit Report\n"]

    if not agents_dir.exists():
        report_lines.append("No agents directory found.")

    else:
        for agent in agents_dir.iterdir():
            if agent.is_dir():
                report_lines.extend(simulate_recovery(agent.name))

    with open(REPORT_PATH, "w", encoding="utf-8") as report:
        report.write("\n".join(report_lines))

    print("Recovery workflow completed")
    print(f"Report saved to: {REPORT_PATH}")


if __name__ == "__main__":
    generate_report()