import json
from pathlib import Path


POLICY_DIR = Path("policies")
REPORT_PATH = Path("reports/permission_enforcement_report.md")


def load_policy(agent_name):
    policy_path = POLICY_DIR / f"{agent_name}-policy.json"

    if not policy_path.exists():
        return None

    with open(policy_path, "r", encoding="utf-8") as file:
        return json.load(file)


def validate_permission(agent_name, capability):
    policy = load_policy(agent_name)

    report_lines = [
        "# Permission Enforcement Report\n",
        f"## Agent: {agent_name}",
        f"## Capability Check: {capability}",
        ""
    ]

    if not policy:
        report_lines.append("- STATUS: FAILED")
        report_lines.append("- ERROR: Policy file not found")

        with open(REPORT_PATH, "w", encoding="utf-8") as report:
            report.write("\n".join(report_lines))

        print("Policy file not found")
        return False

    allowed_permissions = policy.get("permissions", [])

    if capability in allowed_permissions:
        report_lines.append("- STATUS: ALLOWED")
        print("Permission allowed")

    else:
        report_lines.append("- STATUS: BLOCKED")
        print("Permission blocked")

    with open(REPORT_PATH, "w", encoding="utf-8") as report:
        report.write("\n".join(report_lines))

    return True


if __name__ == "__main__":
    validate_permission("memory-agent", "read_memory")