from tools.agent_sandbox.execution_guard import (
    analyze_execution,
)


def test_blocked_command():

    result = analyze_execution(
        command="rm -rf /",
        tool="subprocess",
    )

    assert result["risk_level"] == "HIGH"


def test_safe_execution():

    result = analyze_execution(
        command="print('hello')",
        tool="math",
    )

    assert result["risk_level"] == "SAFE"