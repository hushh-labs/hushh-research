import type { GoogleCalendarAccount, GoogleCalendarStatus } from "@/lib/services/google-calendar-service";

/** Optional owner-bound presentation metadata in Calendar account status. */
export type CalendarPhotoAccount = GoogleCalendarAccount & {
  scope_csv?: string;
  grant_generation?: string;
  provider_subject_sha256?: string;
  hosted_domain?: string | null;
  guest_photo_access?: boolean;
};

export type CalendarPhotoStatus = Omit<GoogleCalendarStatus, "accounts"> & {
  accounts?: CalendarPhotoAccount[];
};
