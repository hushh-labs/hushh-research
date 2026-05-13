"use client";

/**
 * Kai Dashboard Layout
 *
 * Top route tabs are now mounted at app/kai/layout.tsx so they persist across
 * Market / Dashboard / Analysis route switches without remount flicker.
 */

export default function KaiDashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="w-full">
      <div className="w-full pb-24">{children}</div>
    </div>
  );
}
