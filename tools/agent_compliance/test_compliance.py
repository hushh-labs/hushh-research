from pathlib import Path
import subprocess


def test_compliance_checker():
    process = subprocess.run(
        ["python", "tools/agent_compliance/check_structure.py"],
        text=True,
        capture_output=True
    )

    assert process.returncode == 0

    report_path = Path("reports/agent_compliance_report.md")

    assert report_path.exists()