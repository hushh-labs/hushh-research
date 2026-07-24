from pathlib import Path


REPORT_PATH = Path("reports/repository_health_report.md")


REQUIRED_PATHS = [
    "tools",
    "reports",
    "docs"
]


def check_repository_health():
    results = []

    results.append("# Repository Health Report\n")

    for path in REQUIRED_PATHS:
        current_path = Path(path)

        if current_path.exists():
            results.append(f"- {path}: OK")
        else:
            results.append(f"- {path}: MISSING")

    with open(REPORT_PATH, "w", encoding="utf-8") as report:
        report.write("\n".join(results))

    print("Repository health check completed")


if __name__ == "__main__":
    check_repository_health()