/**
 * Kai Dashboard Layout
 *
 * Top route tabs are mounted at app/kai/layout.tsx to persist across
 * Market / Dashboard / Analysis route switches without remount flicker.
 */
export default function KaiDashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <section className="w-full pb-24">
      {children}
    </section>
  );
}