import re

with open('hushh-webapp/components/kai/debate-stream-view.tsx', 'r') as f:
    content = f.read()

# Replace hardcoded max-w blocks with clean semantic sizes
content = re.sub(
    r'className="max-w-md w-full"',
    'className="w-full"',
    content
)

content = re.sub(
    r'className="mx-auto w-full max-w-3xl space-y-4 px-0 pb-8"',
    'className="mx-auto w-full space-y-4 px-0 pb-8"',
    content
)

with open('hushh-webapp/components/kai/debate-stream-view.tsx', 'w') as f:
    f.write(content)
