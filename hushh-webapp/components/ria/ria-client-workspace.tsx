"use client";
import { RiaPageShell } from "@/components/ria/ria-page-shell";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
// ... (other imports)
export function RiaClientWorkspace(props: any) {
  // You can destructure your variables here
  const { activeAccountBranches, activeTemplate, selectedAccountIds } = props;
  // ... (your logic)

  return (
    <RiaPageShell title="Client Workspace">
  {/* Your content... */}

     <SettingsGroup embedded title={<>Visible accounts</>}>
  {/* The map function is correctly attached here, inside the SettingsGroup */}
  {activeAccountBranches
    ?.filter((branch: any) => branch.status === "approved")
    .map((branch: any) => (
      <SettingsRow
        key={branch.branch_id}
        title={`${branch.name}${branch.mask ? ` ••${branch.mask}` : ""}`}
        description={
          [branch.institution_name, branch.type, branch.subtype]
            .filter(Boolean)
            .join(" • ") || "Linked account"
        }
      />
    ))}
</SettingsGroup>
      
    </RiaPageShell>
  );
}