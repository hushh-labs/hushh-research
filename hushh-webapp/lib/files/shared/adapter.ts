import type { FilesSettings } from "../service";
import { SharedFilesLibrary, publicEntry } from "./library";
import { SharedFilesForeground } from "./foreground";
import type { SharedFilesAccess } from "./store";

/** Mirrors Files' existing browser service, keeping crypto on the unlocked client. */
export class SharedFilesAdapter {
  private readonly library: SharedFilesLibrary;
  private readonly foreground: SharedFilesForeground;
  constructor(access: SharedFilesAccess) {
    this.library = new SharedFilesLibrary(access);
    this.foreground = new SharedFilesForeground(this.library);
  }
  async request(path: string, init: RequestInit = {}): Promise<Response> {
    this.library.store.check();
    const url = new URL(path, "https://files.invalid/");
    const method = init.method ?? "GET";
    const signal = init.signal ?? undefined;
    const fileId = url.searchParams.get("file_id") ?? "";
    const cursor = url.searchParams.get("cursor") ?? "";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
    let result: unknown;
    switch (url.pathname) {
      case "/entry":
        result = publicEntry((await this.library.entry(fileId, signal)).entry);
        break;
      case "/list":
        result = await this.library.list(
          url.searchParams.get("parent") ?? "root",
          cursor,
          url.searchParams.get("trash") === "true",
          signal,
        );
        break;
      case "/settings":
        result =
          method === "PUT"
            ? await this.library.configure(body as FilesSettings, signal)
            : await this.library.settings(signal);
        break;
      case "/create":
        result = await this.library.create(body, signal);
        break;
      case "/mutate":
        result = await this.library.mutate(body, signal);
        break;
      case "/complete":
        result = await this.library.complete(body.file_id, signal);
        break;
      case "/chunk": {
        if (!url.searchParams.has("index"))
          throw new Error("FILES_CHUNK_INVALID");
        const data =
          method === "PUT"
            ? new Uint8Array(await new Response(init.body).arrayBuffer())
            : undefined;
        result = await this.library.chunk(
          fileId,
          Number(url.searchParams.get("index")),
          data,
          signal,
        );
        if (result instanceof Uint8Array) {
          this.library.store.check();
          return new Response(new Uint8Array(result).buffer);
        }
        break;
      }
      case "/usage": {
        const page = await this.library.store.page("entries", cursor, signal);
        const files = page.values as Array<{ kind: string; received: number }>;
        result = {
          bytes: files.reduce(
            (total, entry) =>
              total + (entry.kind === "file" ? entry.received : 0),
            0,
          ),
          files: files.filter((entry) => entry.kind === "file").length,
          cursor: page.cursor,
        };
        break;
      }
      case "/jobs": {
        if (method === "POST")
          result = await this.foreground.run(
            body.file_id,
            body.cancel === true,
            signal,
          );
        else if (fileId) result = await this.foreground.job(fileId, signal);
        else {
          const page = await this.library.store.page("jobs", cursor, signal);
          result = { entries: page.values, cursor: page.cursor };
        }
        break;
      }
      default:
        throw new Error("FILES_OPERATION_UNSUPPORTED");
    }
    this.library.store.check();
    signal?.throwIfAborted();
    return Response.json(result);
  }
}
