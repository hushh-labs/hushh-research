import re

file_path = 'hushh-webapp/components/kai/layout/dashboard-route-tabs.tsx'
with open(file_path, 'r') as f:
    content = f.read()

# Replace the complicated nested logic with beautiful Morphic SegmentedPills!
old_tabs_body = r'''const tabsBody = \(
    <>
      <div role="tablist" className="relative grid grid-cols-3 items-center border-b border-border/70 px-1">
.*?
      </div>
    </>
  \);'''

new_tabs_body = '''const { SegmentedPill } = require("@/lib/morphy-ux/ui/segmented-tabs");

  const options = KAI_ROUTE_TABS.map(t => ({
    value: t.id,
    label: t.label,
  }));

  const tabsBody = (
    <div className="w-full px-2 py-1">
      <SegmentedPill
        size="compact"
        layout="stacked"
        hitArea="segment"
        value={activeTab}
        options={options}
        onValueChange={(val) => handleTabChange(val)}
        ariaLabel="Workspace navigation"
        className="w-full bg-[color:var(--app-card-surface-default)] rounded-full drop-shadow-sm border border-border/60"
      />
    </div>
  );'''

# Note: We need to clean up imports properly too. Since we're injecting segmented pill, let's just write the whole cleaned file
