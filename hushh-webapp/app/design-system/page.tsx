import type { Metadata } from "next";
import { ReferenceStorybook } from "@/components/design-system/reference-storybook";

export const metadata: Metadata = {
  title: "Reference Design System | Hussh One",
  description:
    "Internal reference showcase of Hussh One core primitives, button density, top-bar progressive mask fade, Sandbox cards, and financial tables.",
  robots: {
    index: false,
    follow: false,
  },
};

export default function ReferenceDesignSystemPage() {
  return <ReferenceStorybook />;
}
