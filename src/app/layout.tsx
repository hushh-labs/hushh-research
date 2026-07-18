import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hussh — Privacy Trust Dashboard",
  description:
    "Monitor connected services, manage permissions, and audit data access in real time.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <head>
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
