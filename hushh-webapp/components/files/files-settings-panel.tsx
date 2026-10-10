"use client";

import { useState } from "react";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { FilesService, type FilesSettings } from "@/lib/files/service";

export type FilesAction = (
  operation: () => Promise<unknown>,
  success: string | (() => string),
  refresh?: boolean,
) => Promise<void>;

function reportedDays(seconds: number | null | undefined): number | null {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
    ? Math.ceil(seconds / 86400)
    : null;
}

export function FilesSettingsPanel({
  settings,
  signal,
  busy,
  unavailable,
  act,
}: {
  settings: FilesSettings | null;
  signal: AbortSignal;
  busy: boolean;
  unavailable: boolean;
  act: FilesAction;
}) {
  const [usage, setUsage] = useState<number | null>(null);
  const disabled = busy || unavailable || !settings;
  const retention = settings?.retention;
  const retentionDays = reportedDays(retention?.retentionSeconds);
  const softDeleteDays = reportedDays(retention?.softDeleteSeconds);

  return (
    <div className="space-y-4">
      {settings ? (
        <SettingsGroup title="Files Agent" embedded headingClassName="mt-0">
          <SettingsRow
            title="Allow library analysis"
            description="Allow your model provider to analyze file content."
            trailing={
              <Switch
                size="ios"
                aria-label="Allow library analysis"
                checked={settings.analysis}
                disabled={disabled}
                onCheckedChange={(analysis) =>
                  void act(
                    () =>
                      FilesService.configure(
                        {
                          ...settings,
                          analysis,
                          automatic: analysis && settings.automatic,
                        },
                        signal,
                      ),
                    "Analysis preference saved",
                  )
                }
              />
            }
          />
          <SettingsRow
            title="Organize new uploads"
            description={
              settings.backgroundAvailable && settings.backgroundProvider
                ? "New uploads only. View provider details below."
                : "Unavailable. You can still turn it off."
            }
            trailing={
              <Switch
                size="ios"
                aria-label="Automatically organize new uploads"
                checked={settings.automatic}
                disabled={
                  disabled ||
                  (!settings.automatic &&
                    (!settings.analysis || !settings.backgroundAvailable))
                }
                onCheckedChange={(automatic) =>
                  void act(
                    () =>
                      FilesService.configure(
                        { ...settings, automatic },
                        signal,
                      ),
                    "Organization preference saved",
                  )
                }
              />
            }
          />
        </SettingsGroup>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Folder exclusions also protect everything inside. Use the file or folder
        menu.
      </p>
      <SettingsGroup title="Storage" embedded>
        <SettingsRow
          title={
            usage === null
              ? "Library usage"
              : `${(usage / 1024 ** 3).toFixed(2)} GiB uploaded`
          }
          description="Includes partial uploads and Trash."
          trailing={
            <Button
              variant="ghost"
              size="compact"
              aria-label="Check storage"
              disabled={disabled}
              onClick={() =>
                void act(
                  async () => {
                    let next = "",
                      bytes = 0;
                    do {
                      const page = await FilesService.usagePage(next, signal);
                      signal.throwIfAborted();
                      bytes += page.bytes;
                      next = page.cursor;
                    } while (next);
                    setUsage(bytes);
                  },
                  "Storage checked",
                  false,
                )
              }
            >
              Check
            </Button>
          }
        />
      </SettingsGroup>
      <details className="text-sm">
        <summary className="min-h-11 cursor-pointer py-3 font-medium">
          Storage details
        </summary>
        <div className="space-y-2 pb-1 text-muted-foreground">
          <p>
            Trash is reversible. It does not physically delete files or reduce
            storage charges.
          </p>
          <p>Cloud versions and storage overhead are additional.</p>
          {settings?.backgroundProvider ? (
            <p>Background organization: {settings.backgroundProvider}.</p>
          ) : null}
          {retention ? (
            <dl className="space-y-2">
              <div className="flex flex-wrap justify-between gap-2">
                <dt>Minimum retention</dt>
                <dd>
                  {retentionDays === null
                    ? retention.retentionLocked
                      ? "Restricted; duration is unavailable"
                      : "Not reported"
                    : `${retentionDays} days${retention.retentionLocked ? " (locked)" : ""}`}
                </dd>
              </div>
              <div className="flex flex-wrap justify-between gap-2">
                <dt>Soft-delete retention</dt>
                <dd>
                  {softDeleteDays === null
                    ? "Not reported"
                    : `${softDeleteDays} days`}
                </dd>
              </div>
              <div className="flex flex-wrap justify-between gap-2">
                <dt>Object versioning</dt>
                <dd>{retention.versioning ? "Enabled" : "Disabled"}</dd>
              </div>
            </dl>
          ) : (
            <p>Retention settings have not been reported by your storage.</p>
          )}
        </div>
      </details>
    </div>
  );
}
