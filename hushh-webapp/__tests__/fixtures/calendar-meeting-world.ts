/**
 * CONTROLLED model of the server for the Calendar meeting-request journey.
 *
 * This is a test double, not Google. It stands in for the request store, the
 * identity layer, the Drive sharing job and the ACL on a file, so that two
 * separate people (a requester and an organizer, each with their own tokens)
 * can be driven against ONE shared state. It proves how the client behaves
 * against the documented API contract. It cannot prove that Google shared a
 * file; that needs a live run with real accounts.
 */
import { DriveSharingError } from "@/lib/services/drive-sharing-wire";

export type Kind = "recording" | "notes";
type Status = "pending" | "review_ready" | "approved" | "completed" | "partial" | "failed" | "declined";
export type Person = { userId: string; idToken: string; vaultToken: string };
type Fixture = { title: string; calendarId: string; eventId: string; occurrenceId: string; grantId: string; start: string; notesFileId?: string };
type Reply = (status: number, value: unknown) => Response;

type Request = {
  requestId: string; requester: string; organizer: string; recipientEmail: string;
  occurrenceId: string; types: Kind[]; status: Status; revision: number;
  /** Requested types the organizer said they do not have. */
  notAvailable: Kind[];
  prepared: { fileIds: string[]; digest: string } | null; sharedFileIds: string[];
};
type Job = { requestId: string; fileIds: string[] };
/** A durable Feed event, addressed to one person (the cross-user delivery model). */
export type FeedEvent = { type: "document_share_request" | "document_share_request_sent" | "document_share_decided"; to: string; requestId: string; revision: number };
// Mirrors the server: these statuses already answer a type, so it is not asked again.
const LIVE: Status[] = ["pending", "review_ready", "approved", "completed", "partial"];

const HEX = (character: string) => character.repeat(64);
const DATE = "2026-10-14";

export class CalendarMeetingWorld {
  /** The One sign-in account (A) differs from the selected Google account (B). */
  readonly requester: Person & { oneEmail: string; googleEmail: string } = {
    userId: "requester-user", idToken: "id-requester", vaultToken: "vault-requester",
    oneEmail: "requester-one@example.test", googleEmail: "requester-google@example.test",
  };
  readonly organizer: Person & { email: string } = {
    userId: "organizer-user", idToken: "id-organizer", vaultToken: "vault-organizer", email: "organizer@example.test",
  };
  readonly stranger: Person = { userId: "stranger-user", idToken: "id-stranger", vaultToken: "vault-stranger" };

  readonly target: Fixture & { files: Record<Kind, string> } = {
    title: "Hussh Growth Sync", calendarId: "primary", eventId: "event-growth-sync",
    occurrenceId: HEX("a"), grantId: HEX("b"), start: `${DATE}T10:00:00Z`,
    files: { recording: "recordingfile1", notes: "notesfile12345" },
  };
  /** A different occurrence the requester can already open through Calendar. */
  readonly prior: Fixture & { notesFileId: string } = {
    title: "Design Review", calendarId: "primary", eventId: "event-design-review",
    occurrenceId: HEX("c"), grantId: HEX("d"), start: `${DATE}T08:00:00Z`, notesFileId: "priornotesfile1",
  };

  readonly requests = new Map<string, Request>();
  readonly acl = new Set<string>();
  readonly shares: { requestId: string; fileId: string; to: string }[] = [];
  readonly approvals: string[] = [];
  readonly sentBodies: Record<string, unknown>[] = [];
  readonly unhandled: string[] = [];
  readonly events: FeedEvent[] = [];
  /** Every Drive read the organizer's page made for a request (none for "Don't have"). */
  readonly driveReads: string[] = [];
  private jobs: Job[] = [];
  private sequence = 0;
  /** Is the organizer a verified, connected One user for the requester? */
  organizerConnected = true;
  /** A connection request to the organizer that has not been accepted yet. */
  connectionPending = false;
  readonly readinessReads: Record<string, unknown>[] = [];

  constructor() {
    this.acl.add(`${this.prior.notesFileId}|${this.requester.googleEmail}`);
  }

  private people(): Person[] { return [this.requester, this.organizer, this.stranger]; }
  private byToken(token: string): Person | undefined {
    return this.people().find(person => person.idToken === token || person.vaultToken === token);
  }
  private requestIdFor(n: number) { return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`; }
  private documentIdFor(fileId: string) {
    return `11111111-1111-4111-8111-${String([...fileId].reduce((sum, char) => sum + char.charCodeAt(0), 0)).padStart(12, "0")}`;
  }
  private fileName(kind: Kind) { return `${this.target.title} ${kind}`; }
  private fileKind(fileId: string): Kind { return fileId === this.target.files.recording ? "recording" : "notes"; }
  private hasAccess(fileId: string, email: string) { return this.acl.has(`${fileId}|${email}`); }

  /** Requests addressed to this person as the organizer (their One Feed). */
  feedFor(person: Person): string[] {
    return [...this.requests.values()].filter(request => request.organizer === person.userId).map(request => request.requestId);
  }
  /** Feed events addressed to this person, oldest first. */
  eventsFor(person: Person, type?: FeedEvent["type"]): FeedEvent[] {
    return this.events.filter(event => event.to === person.userId && (!type || event.type === type));
  }
  shareCount(fileId?: string) { return this.shares.filter(share => !fileId || share.fileId === fileId).length; }
  request(requestId?: string): Request {
    const found = requestId ? this.requests.get(requestId) : [...this.requests.values()][0];
    if (!found) throw new Error("no such request");
    return found;
  }

  // ---- test controls -------------------------------------------------------
  /** Drive finishes the queued sharing job. `grantTo` models sharing with the wrong account. */
  finishSharing(options: { grantTo?: string; only?: Kind[]; failed?: boolean } = {}) {
    const queued = this.jobs; this.jobs = [];
    for (const job of queued) {
      const request = this.request(job.requestId);
      if (options.failed) { request.status = "failed"; continue; }
      const wanted = options.only ? job.fileIds.filter(id => options.only!.includes(this.fileKind(id))) : job.fileIds;
      for (const fileId of wanted) {
        const to = options.grantTo ?? request.recipientEmail;
        this.acl.add(`${fileId}|${to}`);
        this.shares.push({ requestId: job.requestId, fileId, to });
        request.sharedFileIds.push(fileId);
      }
      request.status = wanted.length < job.fileIds.length ? "partial" : "completed";
    }
  }
  revoke(fileId: string, email = this.requester.googleEmail) { this.acl.delete(`${fileId}|${email}`); }
  /** The organizer's prepared review is superseded (a new digest), so an older one is stale. */
  supersedeReview() {
    const request = this.request();
    request.revision += 1;
    if (request.prepared) request.prepared = { ...request.prepared, digest: `e${String(++this.sequence).padStart(63, "0")}` };
  }

  // ---- HTTP boundary (the real services run against this) -----------------
  fetch = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    const auth = (headers.get("Authorization") || "").replace(/^Bearer /, "");
    const consent = (headers.get("X-Hushh-Consent") || "").replace(/^Bearer /, "");
    const body: Record<string, unknown> = init.body ? JSON.parse(String(init.body)) : {};
    const json: Reply = (status, value) =>
      new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
    const person = this.byToken(auth);
    if (!person) return json(401, { detail: { code: "unauthorized" } });

    if (path.startsWith("/api/one/calendar/")) {
      const route = path.slice("/api/one/calendar/".length);
      // Reading the library needs only the signed-in person; request routes also need their own Vault consent.
      const protectedRoute = route.startsWith("meetings/");
      if (person.userId !== this.requester.userId || (protectedRoute && consent !== person.vaultToken))
        return json(403, { detail: { code: "forbidden" } });
      return this.calendarRoute(route, body, person, json);
    }
    const root = "/api/connectors/google_drive/sharing/calendar-requests/";
    if (path.startsWith(root)) return this.reviewRoute(path.slice(root.length), body, person, json, init.method || "GET");
    this.unhandled.push(path);
    return json(404, { detail: { code: "not_found" } });
  };

  private selectionError(body: Record<string, unknown>): { status: number; code: string } | null {
    const known = [this.target, this.prior].find(meeting => meeting.occurrenceId === body.occurrence_id);
    if (!known || known.grantId !== body.expected_grant || known.eventId !== body.event_id)
      return { status: 409, code: "calendar_occurrence_changed" };
    return null;
  }

  private row(meeting: Fixture) {
    const linked = Boolean(meeting.notesFileId) && this.hasAccess(meeting.notesFileId!, this.requester.googleEmail);
    return {
      id: meeting.eventId, title: meeting.title, calendar_id: meeting.calendarId, account_id: "default",
      occurrence_id: meeting.occurrenceId, grant_id: meeting.grantId,
      sources: [{ calendar_id: meeting.calendarId, event_id: meeting.eventId }],
      artifact_kinds: linked ? ["notes"] : [], availability: linked ? { notes: "available" } : {},
      discovery: "checked", file_state: linked ? "available" : "unknown",
      start: { dateTime: meeting.start }, organizer: { email: this.organizer.email },
    };
  }

  private artifactsFor(occurrenceId: string): Record<string, unknown>[] {
    if (occurrenceId === this.prior.occurrenceId)
      return this.hasAccess(this.prior.notesFileId, this.requester.googleEmail)
        ? [{ file_id: this.prior.notesFileId, kind: "notes", state: "available", title: "Design Review notes",
            url: `https://docs.google.com/document/d/${this.prior.notesFileId}/edit`, can_download: false,
            provenance: "calendar_linked" }] : [];
    const out: Record<string, unknown>[] = [];
    for (const request of this.requests.values()) {
      if (request.requester !== this.requester.userId || request.occurrenceId !== occurrenceId) continue;
      for (const fileId of request.sharedFileIds) {
        // Verified with the requester's own selected Google account, never the organizer's view.
        if (!this.hasAccess(fileId, this.requester.googleEmail)) continue;
        out.push({ file_id: fileId, kind: this.fileKind(fileId), state: "available",
          title: this.fileName(this.fileKind(fileId)), url: `https://docs.google.com/document/d/${fileId}/edit`,
          can_download: false, download_reason: "app_permission", provenance: "approved_request" });
      }
    }
    return out;
  }

  private calendarRoute(route: string, body: Record<string, unknown>, person: Person, json: Reply): Response {
    if (route === "insights")
      return json(200, { complete: true, meeting_count: 0, meeting_minutes: 0, days: [], recurring: [], focus: [], overlaps: 0, back_to_back: 0 });
    if (route === "meetings")
      return json(200, { complete: true, calendar_complete: true, next_cursor: null, date: body.date, time_zone: body.time_zone,
        account_id: "default", limitations: [], checked_events: 2, meetings: [this.row(this.target), this.row(this.prior)],
        meeting_file_access: "ready" });
    if (route === "meetings/approved-detail") {
      const error = this.selectionError(body);
      if (error) return json(error.status, { detail: { code: error.code } });
      const meeting = body.occurrence_id === this.prior.occurrenceId ? this.prior : this.target;
      return json(200, { event: this.row(meeting), calendar_id: meeting.calendarId, discovery: "checked", complete: true,
        artifacts: this.artifactsFor(String(body.occurrence_id)) });
    }
    if (route === "meetings/request-statuses") {
      const selections = Array.isArray(body.meetings) ? body.meetings as Record<string, unknown>[] : [];
      return json(200, { meetings: selections.map(selection => ({
        occurrence_id: selection.occurrence_id,
        requests: [...this.requests.values()].filter(request => request.requester === person.userId &&
          request.occurrenceId === selection.occurrence_id)
          .map(request => ({ requestId: request.requestId, status: request.status, requestedTypes: request.types,
            ...(request.notAvailable.length ? { notAvailableTypes: request.notAvailable } : {}) })),
        artifacts: this.artifactsFor(String(selection.occurrence_id)).map(({ kind, state }) => ({ kind, state })),
      })) });
    }
    if (route === "meetings/request-readiness") {
      // Advisory and read-only: it creates nothing, and create re-checks the relationship.
      this.readinessReads.push(body);
      const error = this.selectionError(body);
      if (error) return json(error.status, { detail: { code: error.code, message: "This meeting changed. Refresh and try again." } });
      return json(200, { state: this.organizerConnected ? "ready" : this.connectionPending ? "pending" : "not_connected" });
    }
    if (route === "meetings/requests") {
      // The browser names only the verified selection and the types. Anything
      // else (an organizer or a recipient address) is refused, never trusted.
      this.sentBodies.push(body);
      const allowed = ["account_id", "calendar_id", "event_id", "occurrence_id", "expected_grant", "date", "time_zone", "requested_types"];
      if (Object.keys(body).some(key => !allowed.includes(key))) return json(400, { detail: { code: "invalid_request" } });
      const error = this.selectionError(body);
      if (error) return json(error.status, { detail: { code: error.code, message: "This meeting changed. Refresh and try again." } });
      if (body.occurrence_id !== this.target.occurrenceId) return json(409, { detail: { code: "calendar_occurrence_changed" } });
      if (!this.organizerConnected)
        return json(409, { detail: { code: "calendar_organizer_unavailable", reason: "organizer_unresolved", message: "Server wording" } });
      const wanted = (body.requested_types as Kind[]).slice().sort();
      const mine = [...this.requests.values()].filter(request => request.requester === person.userId &&
        request.occurrenceId === body.occurrence_id);
      // A type already asked for, or answered "Don't have", is never asked again.
      const answered = new Set(mine.flatMap(request => [...(LIVE.includes(request.status) ? request.types : []), ...request.notAvailable]));
      const outstanding = wanted.filter(kind => !answered.has(kind));
      const existing = outstanding.length ? undefined : mine.find(request => wanted.some(kind => request.types.includes(kind)));
      const request = existing ?? this.create(person.userId, String(body.occurrence_id), outstanding);
      return json(existing ? 200 : 201, { requestType: "calendar_meeting", requestId: request.requestId,
        recipientEmail: request.recipientEmail, status: request.status, requestedTypes: request.types,
        notAvailableTypes: request.notAvailable });
    }
    this.unhandled.push(route);
    return json(404, { detail: { code: "not_found" } });
  }

  private create(requester: string, occurrenceId: string, types: Kind[]): Request {
    const request: Request = {
      requestId: this.requestIdFor(++this.sequence),
      requester, organizer: this.organizer.userId,
      // Derived on the server from the selected Google account, never from the browser.
      recipientEmail: this.requester.googleEmail,
      occurrenceId, types, status: "pending", revision: 0, notAvailable: [], prepared: null, sharedFileIds: [],
    };
    this.requests.set(request.requestId, request);
    // Durable and cross-user: the organizer is asked, the requester sees it was sent.
    this.events.push({ type: "document_share_request", to: this.organizer.userId, requestId: request.requestId, revision: 0 });
    this.events.push({ type: "document_share_request_sent", to: requester, requestId: request.requestId, revision: 0 });
    return request;
  }

  private reviewRoute(route: string, body: Record<string, unknown>, person: Person, json: Reply, method: string): Response {
    const [requestId = "", ...rest] = route.split("/");
    const request = this.requests.get(requestId);
    const suffix = rest.join("/");
    // Only the addressed organizer may read or act on a request.
    if (!request || request.organizer !== person.userId) return json(404, { detail: { code: "request_unavailable" } });
    const open = request.types.filter(kind => !request.notAvailable.includes(kind));
    if (method === "GET" && suffix === "") {
      return json(200, { requestType: "calendar_meeting", requestId, revision: request.revision, status: request.status,
        recipientEmail: request.recipientEmail, ownerDriveReady: true, notAvailableTypes: request.notAvailable,
        meeting: { title: this.target.title, date: DATE, start_at: this.target.start, organizer_email: this.organizer.email,
          account_id: "default", occurrence_id: request.occurrenceId, requested_types: request.types,
          exact_refs: open.map(kind => ({ file_id: this.target.files[kind], kind })) } });
    }
    if (method === "POST" && suffix === "unavailable") {
      // Saved without reading Drive: only the types still open can be answered, once, for this revision.
      const said = Array.isArray(body.types) ? body.types as Kind[] : [];
      if (!said.length || said.some(kind => !request.types.includes(kind))) return json(400, { detail: { code: "invalid_selection" } });
      // Repeating an answer already recorded is not an error and changes nothing.
      if (said.every(kind => request.notAvailable.includes(kind)))
        return json(200, { requestId, status: request.status, revision: request.revision, notAvailableTypes: request.notAvailable });
      if (body.revision !== request.revision) return json(409, { detail: { code: "review_changed" } });
      if (!["pending", "review_ready"].includes(request.status)) return json(409, { detail: { code: "request_unavailable" } });
      request.notAvailable = request.types.filter(kind => request.notAvailable.includes(kind) || said.includes(kind));
      // A review prepared for the old set is void.
      request.prepared = null;
      request.status = request.types.every(kind => request.notAvailable.includes(kind)) ? "declined" : "pending";
      request.revision += 1;
      this.events.push({ type: "document_share_decided", to: request.requester, requestId, revision: request.revision });
      return json(200, { requestId, status: request.status, revision: request.revision, notAvailableTypes: request.notAvailable });
    }
    if (method === "GET" && suffix === "linked-files") {
      this.driveReads.push(`linked-files:${requestId}`);
      return json(200, { files: open.map(kind => ({ file_id: this.target.files[kind], name: this.fileName(kind),
        mime_type: "application/vnd.google-apps.document", artifact_kind: kind })),
        candidateToken: { ciphertext: "sealed" }, hasMore: false, accountLabel: "Organizer Drive" });
    }
    if (method === "POST" && suffix === "review") {
      this.driveReads.push(`review:${requestId}`);
      const ids = Array.isArray(body.fileIds) ? body.fileIds as string[] : [];
      const allowed = open.map(kind => this.target.files[kind]);
      if (body.occurrenceConfirmed !== true || !ids.length || ids.some(id => !allowed.includes(id)))
        return json(400, { detail: { code: "invalid_selection" } });
      request.prepared = { fileIds: ids, digest: `d${String(++this.sequence).padStart(63, "0")}` };
      request.status = "review_ready";
      return json(200, { requestType: "calendar_meeting", requestId });
    }
    this.unhandled.push(`review:${suffix}`);
    return json(404, { detail: { code: "not_found" } });
  }

  // ---- organizer Drive-sharing service (the part with the large wire format) ----
  private owned(token: string, requestId: string): Request {
    const person = this.byToken(token);
    const request = this.requests.get(requestId);
    if (!person || !request || (request.organizer !== person.userId && request.requester !== person.userId))
      throw new DriveSharingError("request_unavailable", 404);
    return request;
  }
  driveStatus = async (token: string, requestId: string) => {
    const request = this.owned(token, requestId);
    const person = this.byToken(token)!;
    return { requestId, requestType: "calendar_meeting" as const,
      direction: request.organizer === person.userId ? "incoming" as const : "outgoing" as const,
      revision: request.revision, status: request.status };
  };
  driveReview = async (token: string, requestId: string) => {
    const request = this.owned(token, requestId);
    if (request.organizer !== this.byToken(token)!.userId || !request.prepared) throw new DriveSharingError("request_unavailable", 404);
    return { requestId, requestType: "calendar_meeting" as const, recipientEmail: request.recipientEmail,
      revision: request.revision, canApprove: true, reviewDigest: request.prepared.digest,
      expiresAt: "2099-01-01T00:00:00Z",
      files: request.prepared.fileIds.map(fileId => ({ documentId: this.documentIdFor(fileId), name: this.fileName(this.fileKind(fileId)) })) };
  };
  driveApprove = async (token: string, requestId: string, review: { reviewDigest: string }, _guard: unknown, documentIds: string[]) => {
    const request = this.owned(token, requestId);
    if (request.organizer !== this.byToken(token)!.userId) throw new DriveSharingError("request_unavailable", 404);
    // One-time: a request that already left review cannot be approved again.
    if (request.status !== "review_ready") throw new DriveSharingError("request_unavailable", 409);
    if (!request.prepared || review.reviewDigest !== request.prepared.digest) throw new DriveSharingError("review_changed", 409);
    const fileIds = request.prepared.fileIds.filter(fileId => documentIds.includes(this.documentIdFor(fileId)));
    if (!fileIds.length) throw new DriveSharingError("invalid_selection", 400);
    request.status = "approved";
    this.approvals.push(requestId);
    this.jobs.push({ requestId, fileIds });
    return { requestId, status: "approved" };
  };
  driveDecide = async (token: string, requestId: string) => {
    const request = this.owned(token, requestId);
    request.status = "declined";
    return { requestId, status: "declined" };
  };
}
