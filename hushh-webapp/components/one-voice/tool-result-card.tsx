"use client";

/**
 * What a tool actually returned, on screen.
 *
 * The summary is `spoken_facts` — the same sentences the model may say, so
 * the card and the speech never disagree. Under it, typed detail per family:
 * people, circles, shares, links, status. `ok:false` renders inline as an
 * error on this card, never as a toast; a success chip needs BOTH `ok:true`
 * and a success status (see toolResultTone).
 *
 * Location status is three distinct rows — device permission, app sharing,
 * precision — and the word "On" appears only when the persisted state is on
 * AND the device permission is granted.
 */

import type { ReactNode } from "react";
import { AlertCircle, Check, Info, Loader2 } from "@/components/icons";

import { AvatarBubble } from "@/lib/morphy-ux/ui/surface-primitives";
import { roleClasses } from "@/lib/morphy-ux/tokens/semantic-roles";
import {
  NOT_SUCCESS_STATUSES,
  SOS_GRANTS_CREATED,
  SOS_REPORT_TOOL,
  SOS_STOP_TOOL,
  SOS_TRIGGER_TOOL,
  type ToolResultPublic,
} from "@/lib/one-voice/protocol";
import {
  isPendingStatus,
  toolResultTone,
  type ToolResultTone,
} from "@/lib/one-voice/session-reducer";
import { cn } from "@/lib/utils";

import { initialsFor } from "./entity-card";

export type ToolResultCardProps = {
  result: ToolResultPublic;
  tool: string;
  /** The `ok` bit from the `tool.result` frame. Unknown never renders as success. */
  ok?: boolean;
  className?: string;
};

export type ToolResultFamily =
  | "people"
  | "circles"
  | "shares"
  | "links"
  | "status"
  | "sos"
  | "generic";

const PEOPLE_TOOLS = new Set([
  "list_people",
  "get_person",
  "invite_person",
  "accept_connection_request",
  "decline_connection_request",
  "cancel_connection_request",
  "remove_connection",
  "add_emergency_contact",
  "remove_emergency_contact",
]);
const CIRCLE_TOOLS = new Set([
  "list_circles",
  "get_circle_details",
  "list_circle_members",
  "list_circle_invites",
  "create_circle",
  "rename_circle",
  "set_circle_kind",
  "delete_circle",
  "add_circle_member",
  "remove_circle_member",
  "leave_circle",
  "respond_circle_invite",
  "cancel_circle_invite",
  "create_circle_invite_link",
]);
const SHARE_TOOLS = new Set([
  "list_shares",
  "share_with",
  "stop_share",
  "change_share_duration",
  "create_check_in",
  "request_location",
  "respond_request",
  "withdraw_request",
  "list_requests",
]);
const LINK_TOOLS = new Set([
  "list_links",
  "create_public_link",
  "revoke_public_link",
]);
const STATUS_TOOLS = new Set([
  "get_location_status",
  "get_location_settings",
  "turn_sharing_on",
  "turn_sharing_off",
  "set_precision",
  "get_location_setup_state",
]);
const SOS_TOOLS = new Set<string>([
  SOS_TRIGGER_TOOL,
  SOS_REPORT_TOOL,
  SOS_STOP_TOOL,
]);
/**
 * Save My Soul statuses, so a report that replaced the trigger's timeline
 * entry (same card, no call id) still renders as the SOS family whichever
 * tool name the entry kept.
 */
const SOS_STATUSES = new Set<string>([
  SOS_GRANTS_CREATED,
  "sos_sent",
  "sos_partial",
  "sos_not_sent",
  "sos_unverified",
  "sos_stopped",
  "sos_partially_stopped",
]);

/** Which typed detail block a tool's result gets. */
export function toolResultFamily(
  tool: string,
  status?: string | null,
): ToolResultFamily {
  const name = String(tool || "").trim();
  if (SOS_TOOLS.has(name) || SOS_STATUSES.has(String(status || "").trim()))
    return "sos";
  if (PEOPLE_TOOLS.has(name)) return "people";
  if (CIRCLE_TOOLS.has(name)) return "circles";
  if (SHARE_TOOLS.has(name)) return "shares";
  if (LINK_TOOLS.has(name)) return "links";
  if (STATUS_TOOLS.has(name)) return "status";
  return "generic";
}

/** Tone when the frame's `ok` is unknown: failures still read as failures, nothing reads as success. */
export function toneForResult(
  result: ToolResultPublic,
  ok: boolean | undefined,
): ToolResultTone {
  const status = String(result.status || "").trim();
  if (isPendingStatus(status)) return "pending";
  if (ok === undefined) {
    return NOT_SUCCESS_STATUSES.has(status) ||
      status === "rejected" ||
      status === "failed"
      ? "failure"
      : "neutral";
  }
  return toolResultTone(status, ok);
}

/**
 * The Save My Soul headline, in product words. "Sent" is written only for the
 * server-verified `sos_sent`; an armed alert says what is still happening.
 * Null falls back to the generic headline for the tone.
 */
export function sosHeadline(
  status: string | null | undefined,
  tone: ToolResultTone,
): string | null {
  switch (String(status || "").trim()) {
    case SOS_GRANTS_CREATED:
      return "Armed · sending your position";
    case "sos_sent":
      return tone === "success" ? "Sent" : null;
    case "sos_partial":
      return "Partly sent";
    case "sos_not_sent":
      return "Not sent";
    case "sos_unverified":
      return "Couldn't confirm delivery";
    case "sos_stopped":
      return tone === "success" ? "Stopped" : null;
    case "sos_partially_stopped":
      return "Partly stopped";
    case "not_active":
      return "Nothing to stop";
    default:
      return null;
  }
}

/** A plain line for an SOS refusal the facts may not spell out. */
export function sosReasonLine(reasonCode: string | null | undefined): string | null {
  switch (String(reasonCode || "").trim()) {
    case "sos_audience_changed":
      return "Your emergency contacts changed after this card was shown. Nothing was sent; ask again to see the current list.";
    case "roster_full":
      return "Your emergency contact list is full. Remove someone before adding another.";
    case "sos_already_active":
      return "Save My Soul is already on. Stop it before sending a new alert.";
    default:
      return null;
  }
}

// --- typed detail ---------------------------------------------------------------

type Row = Record<string, unknown>;

function rows(value: unknown): Row[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Row => Boolean(item) && typeof item === "object",
      )
    : [];
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean || null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function remainingLabel(expiresAt: unknown, now = Date.now()): string | null {
  const iso = text(expiresAt);
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const ms = at - now;
  if (ms <= 0) return "ended";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} min left`;
  const hours = Math.round(minutes / 60);
  return `${hours} ${hours === 1 ? "hour" : "hours"} left`;
}

function PersonRow({
  name,
  photoUrl,
  detail,
}: {
  name: string;
  photoUrl: string | null;
  detail?: string | null;
}) {
  return (
    <li className="flex min-h-9 items-center gap-2.5">
      <AvatarBubble
        initials={initialsFor(name)}
        size={28}
        imageUrl={photoUrl}
      />
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[color:var(--app-label)]">
        {name}
      </span>
      {detail ? (
        <span className="shrink-0 text-[12px] text-[color:var(--app-secondary-label)]">
          {detail}
        </span>
      ) : null}
    </li>
  );
}

function FactRow({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "success" | "warning";
}) {
  const valueClass =
    tone === "success"
      ? roleClasses("success").glyph
      : tone === "warning"
        ? roleClasses("warning").glyph
        : "text-[color:var(--app-label)]";
  return (
    <li className="flex min-h-8 items-center justify-between gap-3">
      <span className="text-[13px] text-[color:var(--app-secondary-label)]">
        {label}
      </span>
      <span className={cn("text-[13px] font-medium", valueClass)}>{value}</span>
    </li>
  );
}

const RELATIONSHIP_DETAIL: Record<string, string> = {
  connected: "Connected",
  pending_outgoing: "Request pending",
  pending_incoming: "Asked to connect",
  none: "Not connected",
  self: "You",
};

function PeopleDetail({ result }: { result: ToolResultPublic }) {
  const connected = rows(result.connected);
  const incoming = rows(result.pending_incoming);
  const outgoing = rows(result.pending_outgoing);
  const person =
    result.person && typeof result.person === "object"
      ? (result.person as Row)
      : null;
  const single = person ? [person] : [];
  const items: Array<{
    key: string;
    name: string;
    photo: string | null;
    detail: string | null;
  }> = [];
  const push = (list: Row[], fallbackDetail: string | null) => {
    list.forEach((row, index) => {
      const name = text(row.display_name);
      if (!name) return;
      const relationship = text(row.relationship);
      items.push({
        key: `${items.length}:${index}`,
        name,
        photo: text(row.photo_url),
        detail: relationship
          ? (RELATIONSHIP_DETAIL[relationship] ?? null)
          : fallbackDetail,
      });
    });
  };
  push(single, null);
  push(connected, "Connected");
  push(incoming, "Asked to connect");
  push(outgoing, "Request pending");
  const named = text(result.display_name);
  if (items.length === 0 && named)
    items.push({
      key: "named",
      name: named,
      photo: text(result.photo_url),
      detail: null,
    });
  if (items.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-col gap-0.5" aria-label="People">
      {items.slice(0, 8).map((item) => (
        <PersonRow
          key={item.key}
          name={item.name}
          photoUrl={item.photo}
          detail={item.detail}
        />
      ))}
    </ul>
  );
}

function CirclesDetail({ result }: { result: ToolResultPublic }) {
  const list = rows(result.circles);
  const one =
    result.circle && typeof result.circle === "object"
      ? (result.circle as Row)
      : null;
  const circles = list.length > 0 ? list : one ? [one] : [];
  if (circles.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-col gap-0.5" aria-label="Circles">
      {circles.slice(0, 8).map((row, index) => {
        const name = text(row.name);
        if (!name) return null;
        const count =
          typeof row.member_count === "number" ? row.member_count : null;
        const owner = bool(row.is_owner);
        const detail = [
          count !== null
            ? `${count} ${count === 1 ? "member" : "members"}`
            : null,
          owner ? "Yours" : null,
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <li
            key={`${name}:${index}`}
            className="flex min-h-8 items-center justify-between gap-3"
          >
            <span className="min-w-0 truncate text-[13px] font-medium text-[color:var(--app-label)]">
              {name}
            </span>
            {detail ? (
              <span className="shrink-0 text-[12px] text-[color:var(--app-secondary-label)]">
                {detail}
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function shareClause(row: Row): string | null {
  const tail =
    row.duration_mode === "until_stopped"
      ? "until stopped"
      : remainingLabel(row.expires_at);
  const first = bool(row.awaiting_first_position) ? "no position yet" : null;
  return [tail, first].filter(Boolean).join(", ") || null;
}

function SharesDetail({ result }: { result: ToolResultPublic }) {
  const outgoing = rows(result.outgoing).filter(
    (row) => row.status === "active",
  );
  const incoming = rows(result.incoming).filter(
    (row) => row.status === "active",
  );
  const single =
    text(result.display_name) ||
    text(result.counterpart_name) ||
    text(result.requester_name) ||
    text(result.owner_name);
  if (outgoing.length === 0 && incoming.length === 0) {
    if (!single) return null;
    const clause =
      result.duration_mode === "until_stopped"
        ? "until stopped"
        : remainingLabel(result.expires_at);
    return (
      <ul className="mt-2 flex flex-col gap-0.5" aria-label="Share">
        <PersonRow name={single} photoUrl={null} detail={clause} />
      </ul>
    );
  }
  return (
    <div className="mt-2 flex flex-col gap-2">
      {outgoing.length > 0 ? (
        <div>
          <p className="text-[12px] font-semibold text-[color:var(--app-section-label)]">
            You share with
          </p>
          <ul className="mt-1 flex flex-col gap-0.5" aria-label="Sharing with">
            {outgoing.slice(0, 6).map((row, index) => {
              const name = text(row.counterpart_name) || "Someone";
              return (
                <PersonRow
                  key={`out:${index}`}
                  name={name}
                  photoUrl={null}
                  detail={shareClause(row)}
                />
              );
            })}
          </ul>
        </div>
      ) : null}
      {incoming.length > 0 ? (
        <div>
          <p className="text-[12px] font-semibold text-[color:var(--app-section-label)]">
            Sharing with you
          </p>
          <ul
            className="mt-1 flex flex-col gap-0.5"
            aria-label="Sharing with you"
          >
            {incoming.slice(0, 6).map((row, index) => {
              const name = text(row.counterpart_name) || "Someone";
              return (
                <PersonRow
                  key={`in:${index}`}
                  name={name}
                  photoUrl={null}
                  detail={shareClause(row)}
                />
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function LinksDetail({ result }: { result: ToolResultPublic }) {
  const list = rows(result.links);
  const singleUrl = text(result.url);
  const links =
    list.length > 0
      ? list
      : singleUrl
        ? [{ url: singleUrl, status: "active", expires_at: result.expires_at }]
        : [];
  if (links.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-col gap-0.5" aria-label="Links">
      {links.slice(0, 6).map((row, index) => {
        const status = text(row.status) || "active";
        const url = text(row.url);
        const remaining =
          status === "active" ? remainingLabel(row.expires_at) : null;
        const label =
          status === "active"
            ? (remaining ?? "Live")
            : status === "revoked"
              ? "Revoked"
              : "Ended";
        return (
          <li
            key={`link:${index}`}
            className="flex min-h-8 items-center justify-between gap-3"
          >
            <span className="min-w-0 flex-1 truncate text-[13px] text-[color:var(--app-label)]">
              {url ?? "Public link"}
            </span>
            <span
              className={cn(
                "shrink-0 text-[12px] font-medium",
                status === "active"
                  ? roleClasses("success").glyph
                  : "text-[color:var(--app-secondary-label)]",
              )}
            >
              {label}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export type LocationStatusRows = {
  devicePermission: { value: string; tone: "neutral" | "success" | "warning" };
  appSharing: { value: string; tone: "neutral" | "success" | "warning" };
  precision: { value: string; tone: "neutral" } | null;
};

/**
 * Three distinct rows. "On" is written only when the persisted state is on
 * AND the device permission is granted; anything else names what is missing.
 */
export function locationStatusRows(
  result: ToolResultPublic,
): LocationStatusRows | null {
  const sharingState = text(result.sharing_state);
  const osPermission = text(result.os_permission_reported);
  const precision = text(result.precision);
  if (!sharingState && !osPermission && !precision) return null;
  const granted = osPermission === "granted";
  const devicePermission: LocationStatusRows["devicePermission"] =
    osPermission === "granted"
      ? { value: "Granted", tone: "success" }
      : osPermission === "denied"
        ? { value: "Denied", tone: "warning" }
        : osPermission === "prompt"
          ? { value: "Not asked yet", tone: "neutral" }
          : { value: "Unknown", tone: "neutral" };
  const appSharing: LocationStatusRows["appSharing"] =
    sharingState === "on"
      ? granted
        ? { value: "On", tone: "success" }
        : { value: "Waiting on device permission", tone: "warning" }
      : sharingState === "off"
        ? { value: "Off", tone: "neutral" }
        : sharingState === "unset"
          ? { value: "Not set up", tone: "neutral" }
          : { value: "Unknown", tone: "neutral" };
  const precisionRow: LocationStatusRows["precision"] =
    precision === "precise"
      ? { value: "Precise", tone: "neutral" }
      : precision === "approximate"
        ? { value: "Approximate", tone: "neutral" }
        : null;
  return { devicePermission, appSharing, precision: precisionRow };
}

function StatusDetail({ result }: { result: ToolResultPublic }) {
  const statusRows = locationStatusRows(result);
  if (!statusRows) return null;
  return (
    <ul
      className="mt-2 flex flex-col divide-y divide-[color:var(--app-separator)]"
      aria-label="Location status"
    >
      <FactRow
        label="Device permission"
        value={statusRows.devicePermission.value}
        tone={statusRows.devicePermission.tone}
      />
      <FactRow
        label="Sharing with people"
        value={statusRows.appSharing.value}
        tone={statusRows.appSharing.tone}
      />
      {statusRows.precision ? (
        <FactRow label="Precision" value={statusRows.precision.value} />
      ) : null}
    </ul>
  );
}

function names(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const name =
      typeof item === "string"
        ? text(item)
        : item && typeof item === "object"
          ? text((item as Row).display_name)
          : null;
    if (name) out.push(name);
  }
  return out;
}

function NameGroup({
  label,
  people,
  detail,
  tone = "neutral",
}: {
  label: string;
  people: string[];
  detail?: string | null;
  tone?: "neutral" | "success" | "warning";
}) {
  if (people.length === 0) return null;
  return (
    <div>
      <p
        className={cn(
          "text-[12px] font-semibold",
          tone === "success"
            ? roleClasses("success").glyph
            : tone === "warning"
              ? roleClasses("warning").glyph
              : "text-[color:var(--app-section-label)]",
        )}
      >
        {label}
      </p>
      <ul className="mt-1 flex flex-col gap-0.5" aria-label={label}>
        {people.slice(0, 8).map((name, index) => (
          <PersonRow
            key={`${label}:${index}`}
            name={name}
            photoUrl={null}
            detail={detail}
          />
        ))}
      </ul>
    </div>
  );
}

/**
 * Save My Soul, by name and never by id. Armed contacts while the position is
 * still on its way; who was reached and who was not once the server has
 * verified the stored envelopes; who was stopped and who may still be live.
 */
function SosDetail({ result }: { result: ToolResultPublic }) {
  const status = String(result.status || "").trim();
  const reason = sosReasonLine(text(result.reason_code));
  const blocks: ReactNode[] = [];
  if (status === SOS_GRANTS_CREATED) {
    const leftOut = [
      ...names(result.skipped_no_key),
      ...names(result.skipped_not_phone_verified),
      ...names(result.failed),
    ];
    blocks.push(
      <NameGroup
        key="armed"
        label="Alerting"
        people={names(result.armed)}
        detail="position on its way"
      />,
      <NameGroup
        key="left-out"
        label="Couldn't include"
        people={leftOut}
        tone="warning"
      />,
    );
  } else if (
    status === "sos_sent" ||
    status === "sos_partial" ||
    status === "sos_not_sent" ||
    status === "sos_unverified"
  ) {
    // Ended shares arrive as grant ids only; the count is shown, never an id.
    const ended = Array.isArray(result.ended_grant_ids)
      ? result.ended_grant_ids.length
      : 0;
    blocks.push(
      <NameGroup
        key="reached"
        label="Reached"
        people={names(result.delivered)}
        tone="success"
      />,
      <NameGroup
        key="not-reached"
        label="Not reached"
        people={names(result.not_alerted)}
        detail="share armed, nothing sent"
        tone="warning"
      />,
    );
    if (ended > 0)
      blocks.push(
        <ul key="ended" className="flex flex-col" aria-label="Ended shares">
          <FactRow
            label="Ended before a position was sent"
            value={`${ended} ${ended === 1 ? "share" : "shares"}`}
          />
        </ul>,
      );
    if (status !== "sos_sent" && result.alert_active === true)
      blocks.push(
        <p
          key="active"
          className="text-[13px] text-[color:var(--app-secondary-label)]"
        >
          The alert is still armed. You can try sending again or stop Save My
          Soul.
        </p>,
      );
  } else if (status === "sos_stopped" || status === "sos_partially_stopped") {
    blocks.push(
      <NameGroup
        key="stopped"
        label="Stopped"
        people={names(result.stopped)}
        tone="success"
      />,
      <NameGroup
        key="unresolved"
        label="May still be live"
        people={names(result.unresolved)}
        detail="check Save My Soul"
        tone="warning"
      />,
    );
  }
  if (reason)
    blocks.push(
      <p key="reason" className="text-[13px] text-[color:var(--app-secondary-label)]">
        {reason}
      </p>,
    );
  const rendered = blocks.filter(Boolean);
  if (rendered.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-2" data-testid="one-voice-sos-detail">
      {rendered}
    </div>
  );
}

function Detail({
  family,
  result,
}: {
  family: ToolResultFamily;
  result: ToolResultPublic;
}) {
  switch (family) {
    case "sos":
      return <SosDetail result={result} />;
    case "people":
      return <PeopleDetail result={result} />;
    case "circles":
      return <CirclesDetail result={result} />;
    case "shares":
      return <SharesDetail result={result} />;
    case "links":
      return <LinksDetail result={result} />;
    case "status":
      return <StatusDetail result={result} />;
    default:
      return null;
  }
}

// --- card -------------------------------------------------------------------------

export function ToolResultCard({
  result,
  tool,
  ok,
  className,
}: ToolResultCardProps) {
  const tone = toneForResult(result, ok);
  const family = toolResultFamily(tool, result.status);
  const facts = Array.isArray(result.spoken_facts)
    ? result.spoken_facts.filter(
        (fact): fact is string =>
          typeof fact === "string" && fact.trim().length > 0,
      )
    : [];
  const Icon =
    tone === "success"
      ? Check
      : tone === "failure"
        ? AlertCircle
        : tone === "pending"
          ? Loader2
          : Info;
  const palette =
    tone === "success"
      ? roleClasses("success")
      : tone === "failure"
        ? roleClasses("danger")
        : tone === "pending"
          ? roleClasses("action")
          : roleClasses("neutral");
  const genericHeadline =
    tone === "success"
      ? "Done"
      : tone === "failure"
        ? "That didn't go through"
        : tone === "pending"
          ? "In progress"
          : null;
  const headline =
    family === "sos"
      ? (sosHeadline(result.status, tone) ?? genericHeadline)
      : genericHeadline;

  return (
    <div
      data-testid="one-voice-tool-result"
      data-tool={tool}
      data-tone={tone}
      role={tone === "failure" ? "alert" : "status"}
      className={cn(
        "rounded-[var(--app-card-radius-standard,24px)] border border-[color:var(--app-separator)] bg-[color:var(--app-card-surface-default-solid)] p-4 shadow-[var(--app-card-shadow-standard)] dark:shadow-none",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
            palette.tile,
            palette.glyph,
          )}
          aria-hidden
        >
          <Icon
            className={cn(
              "h-4 w-4",
              tone === "pending" && "animate-spin motion-reduce:animate-none",
            )}
            aria-hidden
          />
        </span>
        <div className="min-w-0 flex-1">
          {headline ? (
            <p
              data-testid="one-voice-tool-result-headline"
              className={cn("text-[13px] font-semibold", palette.glyph)}
            >
              {headline}
            </p>
          ) : null}
          {facts.length > 0 ? (
            <div
              data-testid="one-voice-tool-result-facts"
              className="flex flex-col gap-0.5"
            >
              {facts.map((fact, index) => (
                <p
                  key={`${index}:${fact.slice(0, 24)}`}
                  className="text-[15px] leading-5 text-[color:var(--app-label)]"
                >
                  {fact}
                </p>
              ))}
            </div>
          ) : tone === "failure" ? (
            <p className="text-[15px] leading-5 text-[color:var(--app-label)]">
              Nothing was changed.
            </p>
          ) : null}
          <Detail family={family} result={result} />
        </div>
      </div>
    </div>
  );
}
