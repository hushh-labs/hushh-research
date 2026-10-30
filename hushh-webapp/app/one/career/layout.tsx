import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Career",
  description: "Keep your resume in your Personal Knowledge Model and apply to hussh roles from Agent One.",
};

export default function OneCareerLayout({ children }: { children: ReactNode }) {
  return children;
}
