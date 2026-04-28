import dynamic from "next/dynamic";

const ConsentAuditTimeline = dynamic(
  () => import("../../src/components/privacy/ConsentAuditTimeline"),
  { ssr: false } // 👈 VERY IMPORTANT
);

export default function ConsentAuditDemoPage() {
  return (
    <main className="min-h-screen bg-slate-50 p-6">
      <ConsentAuditTimeline />
    </main>
  );
}