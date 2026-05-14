import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "One KYC",
  description:
    "Review broker KYC requests and send replies only after approval.",
};

export default function OneKycLayout({ children }: { children: ReactNode }) {
  return children;
}
