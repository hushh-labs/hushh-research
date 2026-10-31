import { Capacitor } from "@capacitor/core";
import type { DrivePickerSession } from "./external-connector-service";

export type PickedDriveFile = { id: string; name: string };
interface Picker {
  setVisible: (visible: boolean) => void;
  dispose: () => void;
}
interface DocsView {
  setMimeTypes: (types: string) => DocsView;
  setIncludeFolders: (value: boolean) => DocsView;
}
interface PickerBuilder {
  addView: (view: DocsView) => PickerBuilder;
  enableFeature: (feature: string) => PickerBuilder;
  setOAuthToken: (token: string) => PickerBuilder;
  setDeveloperKey: (key: string) => PickerBuilder;
  setAppId: (id: string) => PickerBuilder;
  setOrigin: (origin: string) => PickerBuilder;
  setSize: (width: number, height: number) => PickerBuilder;
  setCallback: (callback: (result: unknown) => void) => PickerBuilder;
  build: () => Picker;
}
interface PickerApi {
  DocsView: new () => DocsView;
  PickerBuilder: new () => PickerBuilder;
  Feature: { MULTISELECT_ENABLED: string };
  Action: { PICKED: string; CANCEL: string };
}
type PickerWindow = Window & {
  google?: { picker?: PickerApi };
  gapi?: {
    load: (
      name: string,
      options: {
        callback: () => void;
        onerror: () => void;
        timeout: number;
        ontimeout: () => void;
      },
    ) => void;
  };
};
let loading: Promise<PickerApi> | null = null;

async function loadPicker(): Promise<PickerApi> {
  const target = window as PickerWindow;
  if (target.google?.picker) return target.google.picker;
  if (!loading) {
    loading = new Promise<PickerApi>((resolve, reject) => {
      let completed = false;
      const script = document.createElement("script");
      const finish = (ok: boolean) => {
        if (completed) return;
        completed = true;
        window.clearTimeout(timer);
        script.onload = script.onerror = null;
        if (ok && target.google?.picker) resolve(target.google.picker);
        else {
          script.remove();
          reject(new Error("Picker could not load. Try again."));
        }
      };
      const timer = window.setTimeout(() => finish(false), 15_000);
      const loadModule = () =>
        target.gapi?.load("picker", {
          callback: () => finish(true),
          onerror: () => finish(false),
          timeout: 10_000,
          ontimeout: () => finish(false),
        });
      script.src = "https://apis.google.com/js/api.js";
      script.async = true;
      script.referrerPolicy = "origin";
      script.onload = loadModule;
      script.onerror = () => finish(false);
      if (target.gapi) loadModule();
      else document.head.appendChild(script);
    }).catch((error) => {
      loading = null;
      throw error;
    });
  }
  return loading;
}

export function parsePickedDriveFiles(value: unknown): PickedDriveFile[] {
  if (!Array.isArray(value) || !value.length || value.length > 25)
    throw new Error("Choose between 1 and 25 files.");
  const files = value.map((file: unknown) => {
    if (!file || typeof file !== "object")
      throw new Error("Invalid file selection.");
    const { id, name } = file as Record<string, unknown>;
    if (
      typeof id !== "string" ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(id) ||
      typeof name !== "string" ||
      !name ||
      name.length > 1024
    )
      throw new Error("Invalid file selection.");
    return { id, name }; // Discard provider URLs and all unneeded metadata.
  });
  if (new Set(files.map((file) => file.id)).size !== files.length)
    throw new Error("Invalid file selection.");
  return files;
}

/** Fixed official web Picker only. Native must use its system-browser flow. */
export class GoogleDrivePickerService {
  static async choose(
    session: DrivePickerSession,
    signal: AbortSignal,
  ): Promise<PickedDriveFile[]> {
    if (Capacitor.isNativePlatform())
      throw new Error("Use system-browser Drive authorization.");
    const api = await loadPicker();
    const deadline = Math.min(
      Date.parse(session.expiresAt),
      Date.parse(session.tokenExpiresAt),
    );
    if (
      signal.aborted ||
      session.origin !== window.location.origin ||
      !Number.isFinite(deadline) ||
      deadline <= Date.now()
    )
      throw new Error("Selection expired. Try again.");
    return new Promise((resolve, reject) => {
      let picker: Picker | null = null;
      let settled = false;
      const finish = (files: PickedDriveFile[], failed = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        picker?.dispose();
        picker = null;
        // Drop our reference as soon as Picker is disposed; no state/cache/logs.
        session.accessToken = "";
        if (failed) reject(new Error("Selection could not finish. Try again."));
        else resolve(files);
      };
      const cancel = () => finish([]);
      const timer = window.setTimeout(
        () => finish([], true),
        deadline - Date.now(),
      );
      signal.addEventListener("abort", cancel, { once: true });
      try {
        const view = new api.DocsView()
          .setIncludeFolders(false)
          .setMimeTypes(
            [
              "application/vnd.google-apps.document",
              "application/vnd.google-apps.presentation",
              "application/pdf",
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              "text/plain",
              "text/markdown",
            ].join(","),
          );
        picker = new api.PickerBuilder()
          .addView(view)
          .enableFeature(api.Feature.MULTISELECT_ENABLED)
          .setDeveloperKey(session.developerKey)
          .setAppId(session.appId)
          .setOAuthToken(session.accessToken)
          .setOrigin(session.origin)
          .setSize(
            Math.max(280, Math.min(900, window.innerWidth - 16)),
            Math.max(300, Math.min(600, window.innerHeight - 32)),
          )
          .setCallback((result) => {
            if (!result || typeof result !== "object") return;
            const data = result as Record<string, unknown>;
            if (data.action === api.Action.CANCEL) finish([]);
            if (data.action === api.Action.PICKED) {
              try {
                finish(parsePickedDriveFiles(data.docs));
              } catch {
                finish([], true);
              }
            }
          })
          .build();
        picker.setVisible(true);
      } catch {
        finish([], true);
      }
    });
  }
}
