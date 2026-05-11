from pathlib import Path


AGENTS_DIR = Path("agents")
REPORT_PATH = Path("reports/agent_quality_scorecard.md")


def calculate_score(agent_path):
    score = 0

    checks = {
        "README.md": 25,
        "manifest.py": 25,
        "tests": 25,
        "main.py": 25,
    }

    results = {}

    for item, points in checks.items():
        exists = (agent_path / item).exists()

        if exists:
            score += points

        results[item] = exists

    return score, results


def generate_report():
    lines = ["# Agent Quality Scorecard\n"]

    if not AGENTS_DIR.exists():
        lines.append("No agents directory found.")

        with open(REPORT_PATH, "w", encoding="utf-8") as report:
            report.write("\n".join(lines))

        return

    for agent in AGENTS_DIR.iterdir():
        if agent.is_dir():
            score, results = calculate_score(agent)

            status = (
                "healthy"
                if score >= 75
                else "warning"
                if score >= 50
                else "failing"
            )

            lines.append(f"## {agent.name}")
            lines.append(f"- Score: {score}")
            lines.append(f"- Status: {status}")

            for item, exists in results.items():
                state = "PASS" if exists else "FAIL"
                lines.append(f"  - {item}: {state}")

            lines.append("")

    with open(REPORT_PATH, "w", encoding="utf-8") as report:
        report.write("\n".join(lines))

    print("Quality scorecard generated")
    print(f"Report saved to: {REPORT_PATH}")


if __name__ == "__main__":
    generate_report()