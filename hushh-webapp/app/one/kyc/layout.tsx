import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Email",
  description:
    "Review email requests and send replies only after approval.",
};

export default function OneKycLayout({ children }: { children: ReactNode }) {
  return children;
}
