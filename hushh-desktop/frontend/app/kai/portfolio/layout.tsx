"use client";

export default function KaiPortfolioLayout({
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
