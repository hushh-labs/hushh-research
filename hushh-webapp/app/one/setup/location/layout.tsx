import type { ReactNode } from "react";
import { LocationTypographyProvider } from "@/components/one-location/redesign/location-typography";

export default function LocationSetupLayout({ children }: { children: ReactNode }) {
  return <LocationTypographyProvider>{children}</LocationTypographyProvider>;
}
