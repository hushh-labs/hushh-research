import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "KYC",
  description:
    "Review information requests and approve responses before they are sent.",
};

export default function OneKycLayout({ children }: { children: ReactNode }) {
  return children;
}
