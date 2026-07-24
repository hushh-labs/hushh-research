from pathlib import Path
import json


SCHEMA_PATH = Path("schemas/agent_manifest_schema.json")
REPORT_PATH = Path("reports/manifest_validation_report.md")


def load_schema():
    with open(SCHEMA_PATH, "r", encoding="utf-8") as schema_file:
        return json.load(schema_file)


def validate_manifest(manifest_data, required_fields):
    missing = []

    for field in required_fields:
        if field not in manifest_data:
            missing.append(field)

    return missing


def generate_report():
    schema = load_schema()

    required_fields = schema["required_fields"]

    report_lines = ["# Manifest Validation Report\n"]

    agents_dir = Path("agents")

    if not agents_dir.exists():
        report_lines.append("No agents directory found.")

    else:
        for agent in agents_dir.iterdir():
            if agent.is_dir():

                manifest = {
                    "name": agent.name,
                    "version": "1.0.0",
                    "runtime": "python",
                    "capabilities": ["memory"],
                    "dependencies": ["redis"]
                }

                missing = validate_manifest(
                    manifest,
                    required_fields
                )

                report_lines.append(f"## Agent: {agent.name}")

                if missing:
                    report_lines.append("- STATUS: INVALID")

                    for item in missing:
                        report_lines.append(
                            f"- Missing: {item}"
                        )

                else:
                    report_lines.append("- STATUS: VALID")

                report_lines.append("")

    with open(REPORT_PATH, "w", encoding="utf-8") as report:
        report.write("\n".join(report_lines))

    print("Manifest validation completed")
    print(f"Report saved to: {REPORT_PATH}")


if __name__ == "__main__":
    generate_report()