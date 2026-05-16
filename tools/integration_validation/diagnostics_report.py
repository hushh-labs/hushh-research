import json
from datetime import datetime


def generate_report(results, output_path="runtime_diagnostics_report.json"):
    report = {
        "timestamp": datetime.utcnow().isoformat(),
        "results": results
    }

    with open(output_path, "w") as report_file:
        json.dump(report, report_file, indent=4)

    print(f"\n[INFO] Diagnostics report generated: {output_path}")