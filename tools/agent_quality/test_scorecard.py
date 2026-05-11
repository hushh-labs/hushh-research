from pathlib import Path
import subprocess


def test_quality_scorecard():
    process = subprocess.run(
        ["python", "tools/agent_quality/generate_scorecard.py"],
        text=True,
        capture_output=True
    )

    assert process.returncode == 0

    report_path = Path("reports/agent_quality_scorecard.md")

    assert report_path.exists()