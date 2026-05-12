from pathlib import Path
import subprocess


def test_sandbox_runner():
    process = subprocess.run(
        [
            "python",
            "tools/agent_sandbox/run_agent.py",
            "memory-agent"
        ],
        text=True,
        capture_output=True
    )

    assert process.returncode == 0

    report_path = Path("reports/sandbox_execution_report.md")

    assert report_path.exists()