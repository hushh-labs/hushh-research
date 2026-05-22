// 1. UPDATED "Choose accounts" SECTION (Around line 758)
{activeTemplate?.requires_account_selection ? (
  <SettingsGroup
    embedded 
    title={<>Choose accounts</>}
  >
    {activeAccountBranches.length === 0 ? (
      <div className="px-4 py-4 text-sm text-muted-foreground">
        No linked accounts are available for account-level approval yet.
      </div>
    ) : (
      activeAccountBranches.map((branch) => {
        const checked = selectedAccountIds.includes(branch.branch_id);
        return (
          // ... keep your existing checkbox/label logic here ...
        );
      })
    )}
  </SettingsGroup>
) : null}

// 2. UPDATED "Visible accounts" SECTION (Around line 882)
<SettingsGroup embedded title={<></>}>
    
    {activeAccountBranches
    .filter((branch) => branch.status === "approved")
    .map((branch) => (
      <SettingsRow
        key={branch.branch_id}
       title={<>{`${branch.name}${branch.mask ? ` ••${branch.mask}` : ""}`}</>}
        description={
          [branch.institution_name, branch.type, branch.subtype]
            .filter(Boolean)
            .join(" • ") || "Linked account"
        }
      />
    ))}
</SettingsGroup>