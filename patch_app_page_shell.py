import re

with open('hushh-webapp/components/app-ui/app-page-shell.tsx', 'r') as f:
    content = f.read()

# Make reading width fully dynamic on Mobile
content = re.sub(
    r'reading: "max-w-\[min\(100vw,var\(--app-shell-reading\)\)\]"',
    'reading: "w-full sm:max-w-2xl lg:max-w-[min(100vw,var(--app-shell-reading))]"',
    content
)

with open('hushh-webapp/components/app-ui/app-page-shell.tsx', 'w') as f:
    f.write(content)
