import { parseForegroundProposal } from "./proposal";
import type { FileEntry, OrganizationJob } from "../service";
import { SharedFilesLibrary, publicEntry, identifier } from "./library";

function projection(entry: FileEntry) {
  return {
    id: entry.id,
    name: entry.name,
    parent: entry.parent,
    kind: entry.kind,
    revision: entry.revision,
  };
}
export class SharedFilesForeground {
  private readonly work = new Map<string, AbortController>();
  constructor(private readonly library: SharedFilesLibrary) {}
  async job(fileId: string, signal?: AbortSignal): Promise<OrganizationJob> {
    const result = await this.library.store.read<
      OrganizationJob & { expiresAt?: number }
    >("jobs", identifier(fileId), signal);
    if (!result.value) throw new Error("FILES_JOB_NOT_FOUND");
    if (
      result.value.state === "running" &&
      !this.work.has(fileId) &&
      (result.value.expiresAt ?? 0) < Date.now()
    ) {
      return {
        ...result.value,
        state: "interrupted",
        result: {
          state: "failed",
          explanation:
            "This foreground task was interrupted. Start a new request while your vault is unlocked.",
        },
      };
    }
    return result.value;
  }
  private async requireAllowed(
    fileId: string,
    revision: number,
    signal: AbortSignal,
  ): Promise<void> {
    const settings = await this.library.settings(signal);
    if (!settings.analysis || settings.revision !== revision)
      throw new Error("FILES_CONSENT_CHANGED");
    let current = fileId;
    for (let depth = 0; current !== "root"; depth++) {
      if (depth >= 256) throw new Error("FILES_FOLDER_DEPTH_LIMIT");
      if (settings.excluded.includes(current))
        throw new Error("FILES_EXCLUDED");
      const { entry } = await this.library.entry(current, signal);
      if (entry.state !== "ready") throw new Error("FILES_SOURCE_UNAVAILABLE");
      current = entry.parent;
    }
    if ((await this.library.settings(signal)).revision !== revision)
      throw new Error("FILES_CONSENT_CHANGED");
  }
  async run(
    fileId: string,
    cancel: boolean,
    signal?: AbortSignal,
  ): Promise<OrganizationJob> {
    identifier(fileId);
    if (cancel) {
      this.work.get(fileId)?.abort();
      const current = await this.library.store.read<OrganizationJob>(
        "jobs",
        fileId,
        signal,
      );
      if (!current.value || current.value.state !== "running")
        return this.job(fileId, signal);
      const value = { ...current.value, state: "cancelled" };
      await this.library.store.write(
        "jobs",
        fileId,
        value,
        current.generation,
        signal,
      );
      return value;
    }
    const consent = await this.library.settings(signal);
    if (!consent.analysis) throw new Error("FILES_ANALYSIS_CONSENT_REQUIRED");
    const { entry } = await this.library.entry(fileId, signal);
    let ancestor = fileId;
    for (let depth = 0; ancestor !== "root"; depth++) {
      if (depth >= 256) throw new Error("FILES_FOLDER_DEPTH_LIMIT");
      if (consent.excluded.includes(ancestor))
        throw new Error("FILES_EXCLUDED");
      const current = await this.library.entry(ancestor, signal);
      if (current.entry.state !== "ready")
        throw new Error("FILES_SOURCE_UNAVAILABLE");
      ancestor = current.entry.parent;
    }
    if (entry.kind !== "file" || entry.size > 256 * 1024)
      throw new Error("FILES_ANALYSIS_SIZE_LIMIT");
    const data = entry.size
      ? await this.library.chunk(fileId, 0, undefined, signal)
      : new Uint8Array();
    if (!(data instanceof Uint8Array))
      throw new Error("FILES_FORMAT_UNSUPPORTED");
    const content = new TextDecoder("utf-8", { fatal: true }).decode(data);
    if (content.includes("\0")) throw new Error("FILES_FORMAT_UNSUPPORTED");
    const prior = await this.library.store.read<
      OrganizationJob & { expiresAt?: number }
    >("jobs", fileId, signal);
    if (
      prior.value?.state === "running" &&
      (prior.value.expiresAt ?? 0) > Date.now()
    )
      throw new Error("FILES_JOB_ALREADY_RUNNING");
    const operation = crypto.randomUUID();
    const job = {
      id: fileId,
      file: fileId,
      state: "running",
      operation,
      expiresAt: Date.now() + 130_000,
    };
    await this.library.store.write(
      "jobs",
      fileId,
      job,
      prior.generation,
      signal,
    );
    const controller = new AbortController();
    this.work.set(fileId, controller);
    const requestSignal = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    try {
      const immediateConsent = await this.library.settings(requestSignal);
      const immediateFile = (await this.library.entry(fileId, requestSignal))
        .entry;
      if (
        !immediateConsent.analysis ||
        immediateConsent.revision !== consent.revision ||
        immediateFile.revision !== entry.revision
      )
        throw new Error("FILES_CONSENT_CHANGED");
      await this.requireAllowed(fileId, consent.revision, requestSignal);
      const result = parseForegroundProposal(
        await this.library.store.analysis(
          {
            file: projection(publicEntry(entry)),
            content,
            // Selected-file consent does not include sibling folder labels.
            folders: [],
            processing_consent: true,
            provider: "gemini",
            consent_revision: consent.revision,
          },
          requestSignal,
          async () => {
            await this.requireAllowed(fileId, consent.revision, requestSignal);
            if (
              (await this.library.entry(fileId, requestSignal)).entry
                .revision !== entry.revision
            )
              throw new Error("FILES_SOURCE_CHANGED");
          },
        ),
      );
      const currentConsent = await this.library.settings(requestSignal);
      let latest = (await this.library.entry(fileId, requestSignal)).entry;
      if (
        !currentConsent.analysis ||
        currentConsent.revision !== consent.revision ||
        latest.revision !== entry.revision ||
        result.fileId !== fileId ||
        result.revision !== entry.revision ||
        result.consentRevision !== consent.revision ||
        result.provider !== "gemini" ||
        !Array.isArray(result.changes) ||
        result.changes.length > 8 ||
        result.result?.state === "failed"
      )
        throw new Error("FILES_SOURCE_CHANGED");
      const folders = new Map<string, string>();
      for (const change of result.changes) {
        requestSignal.throwIfAborted();
        this.library.store.check();
        const state = await this.library.store.read<typeof job>(
          "jobs",
          fileId,
          requestSignal,
        );
        if (
          state.value?.operation !== operation ||
          state.value.state !== "running"
        )
          throw new Error("FILES_JOB_CANCELLED");
        await this.requireAllowed(fileId, consent.revision, requestSignal);
        if (
          change.operation === "move" &&
          change.parent !== "root" &&
          !folders.has(change.parent)
        )
          await this.requireAllowed(
            change.parent,
            consent.revision,
            requestSignal,
          );
        if (
          (await this.library.settings(requestSignal)).revision !==
          consent.revision
        )
          throw new Error("FILES_CONSENT_CHANGED");
        const beforeCommit = async () => {
          requestSignal.throwIfAborted();
          await this.requireAllowed(fileId, consent.revision, requestSignal);
          const parent = folders.get(change.parent) ?? change.parent;
          if (parent && parent !== "root")
            await this.requireAllowed(parent, consent.revision, requestSignal);
          const current = await this.library.store.read<typeof job>(
            "jobs",
            fileId,
            requestSignal,
          );
          if (
            current.value?.operation !== operation ||
            current.value.state !== "running"
          )
            throw new Error("FILES_JOB_CANCELLED");
        };
        if (change.operation === "create_folder") {
          if (change.parent !== entry.parent)
            throw new Error("FILES_PROJECTION_INVALID");
          const folder = await this.library.create(
            {
              name: change.name,
              parent: change.parent,
              size: 0,
              folder: true,
              request_id: `${operation}:${change.request_id}`,
            },
            requestSignal,
            beforeCommit,
          );
          folders.set(change.id, folder.id);
        } else {
          if (
            change.file_id !== fileId ||
            !["rename", "move"].includes(change.operation)
          )
            throw new Error("FILES_PROJECTION_INVALID");
          latest = {
            ...latest,
            ...(await this.library.mutate(
              {
                file_id: fileId,
                revision: latest.revision,
                operation: change.operation,
                name: change.name,
                parent: folders.get(change.parent) ?? change.parent,
              },
              requestSignal,
              beforeCommit,
            )),
          };
        }
      }
      const state = await this.library.store.read<typeof job>(
        "jobs",
        fileId,
        requestSignal,
      );
      if (
        state.value?.operation !== operation ||
        state.value.state !== "running"
      )
        throw new Error("FILES_JOB_CANCELLED");
      const settled = { ...job, state: "completed", result: result.result };
      await this.library.store.write(
        "jobs",
        fileId,
        settled,
        state.generation,
        requestSignal,
      );
      return settled;
    } catch (error) {
      // No private model/provider text is persisted. A cancelled/changed job wins.
      this.library.store.check();
      const state = await this.library.store.read<typeof job>(
        "jobs",
        fileId,
        signal,
      );
      if (
        state.value?.operation === operation &&
        state.value.state === "running"
      ) {
        await this.library.store.write(
          "jobs",
          fileId,
          {
            ...job,
            state: requestSignal.aborted ? "cancelled" : "failed",
            result: {
              state: "failed",
              explanation:
                "Organization stopped. Original file contents are preserved; review Activity and undo any completed changes.",
            },
          },
          state.generation,
          signal,
        );
      }
      throw error;
    } finally {
      if (this.work.get(fileId) === controller) this.work.delete(fileId);
    }
  }
}
