import React from "react";
import { createRoot } from "react-dom/client";
import { DataTable } from "@/components/app-ui/data-table";

const nested = new URLSearchParams(location.search).get("nested") === "true";
const rows = Array.from({ length: 20 }, (_, index) => ({ id: index + 1 }));
createRoot(document.getElementById("root")!).render(
  <div data-app-scroll-root={nested ? "true" : undefined} style={nested ? {height: "100vh", overflowY: "auto"} : undefined}>
    <div style={{paddingTop: 180, paddingBottom: 180}}>
      <DataTable columns={[{accessorKey: "id", header: "Receipt"}]} data={rows}
        initialPageSize={8} enableSearch={false} preserveMobilePaginationPosition
        renderMobileCard={row => <div data-testid={`receipt-${row.id}`} style={{height: row.id % 3 === 0 ? 180 : 120}}>Receipt {row.id}</div>} />
      <div style={{height: 80}}>Load older receipts</div>
    </div>
  </div>
);
