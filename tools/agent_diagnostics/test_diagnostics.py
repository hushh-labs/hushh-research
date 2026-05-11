from pathlib import Path
import subprocess


def test_runtime_diagnostics():
    process = subprocess.run(
        ["python", "tools/agent_diagnostics/check_agents.py"],
        text=True,
        capture_output=True
    )

    assert process.returncode == 0

    report_path = Path("reports/agent_runtime_report.md")

    assert report_path.exists()