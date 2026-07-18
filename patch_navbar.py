import re

with open('hushh-webapp/components/navbar.tsx', 'r') as f:
    content = f.read()

# Remove specialistOptions definition
content = re.sub(
    r'  const specialistOptions = useMemo<SegmentedPillOption\[\]>\(\n.*?resolveBottomNavSpecialistOptionKeys.*?\n.*?\]\n  \);\n',
    '',
    content,
    flags=re.DOTALL
)

# Remove the specialistOptions DOM block
content = re.sub(
    r'          \{specialistOptions\.length > 0 \? \(\n            <div\n              className="hidden min-w-0 pointer-events-auto md:block".*?            </div>\n          \) : null\}\n',
    '',
    content,
    flags=re.DOTALL
)

# Update activeSpecialistNav usage if any
content = re.sub(
    r'  const activeSpecialistNav = resolveBottomNavContextKey\(\n    normalizedPathname,\n    bottomNavScope,\n  \);\n',
    '',
    content,
    flags=re.DOTALL
)

with open('hushh-webapp/components/navbar.tsx', 'w') as f:
    f.write(content)
