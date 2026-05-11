from pathlib import Path
import os


REPORT_PATH = Path("reports/runtime_verification_report.md")


REQUIRED_ENV_VARS = [
    "OPENAI_API_KEY",
    "REDIS_URL",
]


REQUIRED_FILES = [
    "README.md",
    "manifest.py",
]


def verify_agent(agent_path):
    score = []

    lines = [f"## Agent: {agent_path.name}"]

    for env_var in REQUIRED_ENV_VARS:
        exists = env_var in os.environ

        status = "PASS" if exists else "FAIL"

        lines.append(f"- ENV {env_var}: {status}")

        score.append(exists)

    for file_name in REQUIRED_FILES:
        exists = (agent_path / file_name).exists()

        status = "PASS" if exists else "FAIL"

        lines.append(f"- FILE {file_name}: {status}")

        score.append(exists)

    final_status = "READY" if all(score) else "BLOCKED"

    lines.append(f"- STATUS: {final_status}")
    lines.append("")

    return lines


def generate_report():
    agents_dir = Path("agents")

    report_lines = ["# Runtime Dependency Verification Report\n"]

    if not agents_dir.exists():
        report_lines.append("No agents directory found.")

    else:
        for agent in agents_dir.iterdir():
            if agent.is_dir():
                report_lines.extend(verify_agent(agent))

    with open(REPORT_PATH, "w", encoding="utf-8") as report:
        report.write("\n".join(report_lines))

    print("Runtime verification completed")
    print(f"Report saved to: {REPORT_PATH}")


if __name__ == "__main__":
    generate_report()