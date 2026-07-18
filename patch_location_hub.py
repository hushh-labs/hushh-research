import re

with open('hushh-webapp/components/one-location/redesign/location-redesign-hub.tsx', 'r') as f:
    content = f.read()

# Replace any lingering raw semantic overrides with pure AppPageShell components.
content = re.sub(
    r'<div className="mb-4 sm:mb-6 lg:mb-8">\n\s*<h2 className="text-xl sm:text-2xl font-bold tracking-tight">Location</h2>\n\s*<p className="text-muted-foreground mt-1 min-w-0 pr-4">',
    '<div><p className="text-muted-foreground mt-1 max-w-sm">',
    content
)

content = re.sub(
    r'w-full max-w-3xl flex-col',
    'w-full flex-col',
    content
)

with open('hushh-webapp/components/one-location/redesign/location-redesign-hub.tsx', 'w') as f:
    f.write(content)
