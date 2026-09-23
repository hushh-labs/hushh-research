import sys
sys.path.append('consent-protocol')

from hushh_mcp.one_adk.agent_tree import _one_roster_tools
tools = _one_roster_tools()

has_pkm = False
for tool in tools:
    if hasattr(tool, '__name__') and tool.__name__ == 'add_to_pkm':
        print("Found add_to_pkm in roster!")
        has_pkm = True
        break
    if hasattr(tool, 'name') and getattr(tool, 'name') == 'add_to_pkm':
        print("Found add_to_pkm by name in roster!")
        has_pkm = True
        break

if not has_pkm:
    print("add_to_pkm NOT found!")
