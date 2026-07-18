import re

file_path = 'hushh-webapp/components/kai/layout/dashboard-route-tabs.tsx'
with open(file_path, 'r') as f:
    content = f.read()

content = content.replace(
    'import { SegmentedPill } from "@/lib/morphy-ux/ui/segmented-tabs";',
    'import { SegmentedPill } from "@/lib/morphy-ux/ui/segmented-pill";'
)

# Fix the internal implicit any arg
content = content.replace(
    'onValueChange={(val) => handleTabChange(val)}',
    'onValueChange={(val: string) => handleTabChange(val)}'
)

with open(file_path, 'w') as f:
    f.write(content)
