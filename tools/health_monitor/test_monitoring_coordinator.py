from pathlib import Path
import subprocess
import sys


sys.path.append(str(Path(__file__).resolve().parents[2]))

from tools.health_monitor.monitoring_coordinator import (
    get_offline_agents
)


def test_offline_detection():
    offline = get_offline_agents()

    assert "kyc-agent" in offline


def test_report_generation():
    process = subprocess.run(
        [
            "python",
            "tools/health_monitor/monitoring_coordinator.py"
        ],
        text=True,
        capture_output=True
    )

    assert process.returncode == 0

    report_path = Path(
        "reports/agent_health_report.md"
    )

    assert report_path.exists()