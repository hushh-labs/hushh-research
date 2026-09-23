import re

with open("consent-protocol/hushh_mcp/one_adk/action_tools.py", "r") as f:
    content = f.read()

# Replace the conflict markers
content = re.sub(
    r"<<<<<<< HEAD\n(.*?)=======\n(.*?)\n>>>>>>> origin/main",
    r"\1\n\2",
    content,
    flags=re.DOTALL
)

with open("consent-protocol/hushh_mcp/one_adk/action_tools.py", "w") as f:
    f.write(content)
