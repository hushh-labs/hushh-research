import json
from pathlib import Path


EMBEDDING_FILE = Path("tests/fixtures/mock_embeddings.json")


def load_embeddings():
    if not EMBEDDING_FILE.exists():
        raise FileNotFoundError(f"{EMBEDDING_FILE} not found")

    with open(EMBEDDING_FILE, "r", encoding="utf-8") as file:
        return json.load(file)


def validate_embeddings(data):
    issues = []

    ids = set()

    for index, item in enumerate(data):
        item_id = item.get("id")
        vector = item.get("embedding")
        metadata = item.get("metadata")

        if not item_id:
            issues.append(f"Missing ID at item {index}")

        if item_id in ids:
            issues.append(f"Duplicate ID found: {item_id}")

        ids.add(item_id)

        if not isinstance(vector, list):
            issues.append(f"Invalid embedding format for {item_id}")
            continue

        if len(vector) == 0:
            issues.append(f"Empty embedding vector for {item_id}")

        if not all(isinstance(v, (int, float)) for v in vector):
            issues.append(f"Non-numeric embedding values for {item_id}")

        if not isinstance(metadata, dict):
            issues.append(f"Invalid metadata format for {item_id}")

    return issues


def generate_report(issues):
    report_path = Path("reports/semantic_search_report.md")

    with open(report_path, "w", encoding="utf-8") as report:
        report.write("# Semantic Search Validation Report\n\n")

        if not issues:
            report.write("✅ No issues found.\n")
        else:
            report.write("## Issues Found\n\n")
            for issue in issues:
                report.write(f"- {issue}\n")

    print(f"Report generated: {report_path}")


if __name__ == "__main__":
    data = load_embeddings()
    issues = validate_embeddings(data)
    generate_report(issues)

    if issues:
        print("\nValidation failed.")
        for issue in issues:
            print(f"- {issue}")
        exit(1)

    print("\nValidation successful.")