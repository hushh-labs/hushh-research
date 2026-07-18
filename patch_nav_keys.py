import re

with open('hushh-webapp/lib/navigation/app-bottom-nav.ts', 'r') as f:
    content = f.read()

# Update option keys logic
old_logic = r'''export function resolveBottomNavOptionKeys\(
  _pathname: string \| null \| undefined,
  _scope: AppBottomNavScope,
  _context\?: AppBottomNavContext,
\): AppBottomNavKey\[\] \{
  // The primary group is stable on every signed-in route\. Specialist tabs are
  // deliberately rendered beside it on wide layouts, never folded into a
  // six-slot global control\.
  return \["dashboard", "connect", "search"\];
\}'''

new_logic = '''export function resolveBottomNavOptionKeys(
  _pathname: string | null | undefined,
  scope: AppBottomNavScope,
  _context?: AppBottomNavContext,
): AppBottomNavKey[] {
  if (scope === "investor") {
    return ["dashboard", "finance", "portfolio", "analysis", "connect", "search"];
  }
  if (scope === "ria") {
    return ["dashboard", "ria-home", "clients", "picks", "connect", "search"];
  }
  return ["dashboard", "connect", "search"];
}'''

content = re.sub(old_logic, new_logic, content, flags=re.DOTALL)

with open('hushh-webapp/lib/navigation/app-bottom-nav.ts', 'w') as f:
    f.write(content)
