from pathlib import Path
import json


HEARTBEAT_PATH = Path(
    "monitoring/agent_heartbeats.json"
)

REPORT_PATH = Path(
    "reports/agent_health_report.md"
)


def load_heartbeats():
    with open(HEARTBEAT_PATH, "r", encoding="utf-8") as file:
        return json.load(file)


def get_offline_agents():
    heartbeats = load_heartbeats()

    offline = []

    for agent, status in heartbeats.items():
        if status != "healthy":
            offline.append(agent)

    return offline


def generate_report():
    heartbeats = load_heartbeats()

    report_lines = [
        "# Agent Health Report\n"
    ]

    for agent, status in heartbeats.items():

        report_lines.append(f"## {agent}")

        report_lines.append(
            f"- STATUS: {status.upper()}"
        )

        report_lines.append("")

    with open(REPORT_PATH, "w", encoding="utf-8") as report:
        report.write("\n".join(report_lines))

    print("Health monitoring report generated")


if __name__ == "__main__":
    generate_report()