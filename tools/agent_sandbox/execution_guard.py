from tools.agent_sandbox.command_validator import (
    validate_command,
)

from tools.agent_sandbox.permission_checker import (
    validate_tool_access,
)

def analyze_execution(command, tool):

    command_result = validate_command(command)

    tool_result = validate_tool_access(tool)

    risks = []

    if not command_result["allowed"]:
        risks.append(
            f"Blocked command detected: "
            f"{command_result['reason']}"
        )

    if not tool_result["allowed"]:
        risks.append(
            f"Restricted tool usage: "
            f"{tool_result['reason']}"
        )

    if risks:

        return {
            "risk_level": "HIGH",
            "issues": risks,
        }

    return {
        "risk_level": "SAFE",
        "issues": [],
    }


if __name__ == "__main__":

    result = analyze_execution(
        command="rm -rf /",
        tool="subprocess",
    )

    print(result)