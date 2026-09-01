import { notFound } from "next/navigation";

import {
  isOneHotelCheckInEnabled,
  isOneHotelCheckInUatDemoEnabled,
} from "@/lib/one-location/hotel-check-in";

/**
 * Silent hotel online check-in entry point.
 *
 * The route exists so a real partner stay can land here later without adding a
 * second check-in surface. Until a supported provider confirms an eligible
 * opaque stay id, it fails closed and remains invisible from nearby check-in.
 */
export default function OneLocationHotelCheckInPage() {
  if (!isOneHotelCheckInEnabled() || !isOneHotelCheckInUatDemoEnabled()) {
    notFound();
  }

  notFound();
}
