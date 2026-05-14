from pathlib import Path
import json


REGISTRY_PATH = Path(
    "registry/agent_capabilities.json"
)

REPORT_PATH = Path(
    "reports/agent_capability_registry.md"
)


def load_registry():
    with open(REGISTRY_PATH, "r", encoding="utf-8") as file:
        return json.load(file)


def find_agents(capability):
    registry = load_registry()

    matching_agents = []

    for agent, capabilities in registry.items():
        if capability in capabilities:
            matching_agents.append(agent)

    return matching_agents


def generate_report():
    registry = load_registry()

    report_lines = [
        "# Agent Capability Registry\n"
    ]

    for agent, capabilities in registry.items():
        report_lines.append(f"## {agent}")

        for capability in capabilities:
            report_lines.append(
                f"- {capability}"
            )

        report_lines.append("")

    with open(REPORT_PATH, "w", encoding="utf-8") as report:
        report.write("\n".join(report_lines))

    print("Capability registry report generated")


if __name__ == "__main__":
    generate_report()