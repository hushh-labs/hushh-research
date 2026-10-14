import type { Metadata } from "next";
import { CalendarReschedulingPage } from "@/components/calendar/calendar-rescheduling-page";

export const metadata: Metadata = {
  title: "Find another meeting time",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};
export default function ReschedulingPage() { return <CalendarReschedulingPage />; }
