"use client";
import { useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { toast } from "sonner";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/hooks/use-auth";
import { initializeFCM } from "@/lib/notifications/fcm-service";
import {
  GoogleCalendarService,
  type CalendarReminderPreferences,
} from "@/lib/services/google-calendar-service";

export function CalendarReminderSettings() {
  const { user } = useAuth();
  const owner = user?.uid;
  const liveOwner = useRef(owner);
  liveOwner.current = owner;
  const operationGeneration = useRef(0);
  const [state, setState] = useState<{
    owner: string;
    prefs: CalendarReminderPreferences;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const prefs = state && state.owner === owner ? state.prefs : null;
  useEffect(() => {
    operationGeneration.current += 1;
    let current = true;
    setState(null);
    setError(false);
    setBusy(false);
    if (!user) return;
    void user
      .getIdToken()
      .then((token) => GoogleCalendarService.reminderPreferences(token))
      .then((result) => {
        if (current) setState({ owner: user.uid, prefs: result });
      })
      .catch(() => {
        if (current) setError(true);
      });
    return () => {
      current = false;
      operationGeneration.current += 1;
    };
  }, [user, retry]);
  async function update(
    change: Partial<
      Pick<CalendarReminderPreferences, "enabled" | "show_title">
    >,
  ) {
    if (!user || !prefs || busy) return;
    const expected = user.uid;
    const generation = operationGeneration.current;
    const isCurrent = () =>
      liveOwner.current === expected &&
      operationGeneration.current === generation;
    setBusy(true);
    try {
      const token = await user.getIdToken();
      if (!isCurrent()) return;
      if (change.enabled && Capacitor.isNativePlatform()) {
        const push = await initializeFCM(expected, token, {
          requestPermission: true,
        });
        if (push.status !== "push_active")
          throw new Error(
            "Allow One notifications in device settings, then try again.",
          );
      }
      if (!isCurrent()) return;
      const result = await GoogleCalendarService.reminderPreferences(token, {
        enabled: prefs.enabled,
        show_title: prefs.show_title,
        time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        ...change,
      });
      if (isCurrent()) setState({ owner: expected, prefs: result });
    } catch (error) {
      if (isCurrent())
        toast.error(
          error instanceof Error
            ? error.message
            : "Unable to update reminders.",
        );
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }
  return (
    <div className="w-full text-left">
      <SettingsGroup>
        <SettingsRow
          title="Meeting reminders"
          description="A push on your phone 10 minutes before a meeting, even when One is closed."
          trailing={
            <Switch
              aria-label="Meeting reminders"
              checked={prefs?.enabled ?? false}
              disabled={busy || !prefs || (!prefs.available && !prefs.enabled)}
              onCheckedChange={(enabled) => void update({ enabled })}
            />
          }
        />
        <SettingsRow
          title="Show meeting title"
          description="The meeting name can appear on your lock screen. Apple and Google deliver the notification."
          trailing={
            <Switch
              aria-label="Show meeting title"
              checked={prefs?.show_title ?? true}
              disabled={busy || !prefs}
              onCheckedChange={(show_title) => void update({ show_title })}
            />
          }
        />
      </SettingsGroup>
      {error ? (
        <button
          className="mt-2 text-sm text-muted-foreground"
          onClick={() => setRetry((value) => value + 1)}
        >
          Reminders couldn’t load. Tap to retry.
        </button>
      ) : prefs && !prefs.available ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Meeting reminders will be available after rollout.
        </p>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          {prefs?.show_title === false
            ? "Preview: Upcoming meeting"
            : "Preview: Design review"}{" "}
          · Starts in 10 minutes. Phone notifications must be allowed.
        </p>
      )}
    </div>
  );
}
