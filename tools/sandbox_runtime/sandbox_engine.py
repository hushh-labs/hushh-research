from pathlib import Path
import json


POLICY_PATH = Path(
    "sandbox/agent_permissions.json"
)

REPORT_PATH = Path(
    "reports/sandbox_violation_report.md"
)


def load_permissions():
    with open(POLICY_PATH, "r", encoding="utf-8") as file:
        return json.load(file)


def is_action_allowed(agent, action):
    permissions = load_permissions()

    allowed_actions = permissions.get(agent, [])

    return action in allowed_actions


def generate_report():
    permissions = load_permissions()

    report_lines = [
        "# Sandbox Violation Report\n"
    ]

    test_cases = [
        ("memory-agent", "delete_database"),
        ("search-agent", "shutdown_server"),
        ("kyc-agent", "access_payments")
    ]

    for agent, action in test_cases:

        allowed = is_action_allowed(
            agent,
            action
        )

        report_lines.append(f"## {agent}")

        if allowed:
            report_lines.append(
                f"- ALLOWED: {action}"
            )

        else:
            report_lines.append(
                f"- BLOCKED: {action}"
            )

        report_lines.append("")

    with open(REPORT_PATH, "w", encoding="utf-8") as report:
        report.write("\n".join(report_lines))

    print("Sandbox report generated")


if __name__ == "__main__":
    generate_report()