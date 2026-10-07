"use client";

import { useState, type ReactNode } from "react";
import { escapeReviewText, serializeReviewArguments } from "@/lib/agent/mcp-review-display";

/**
 * A readable rendering of the exact arguments of a connector call under review.
 * Every key and value is shown as written by the call (keys are only re-spaced
 * for reading); nothing is summarised away, so it remains a faithful review. The
 * exact raw form stays available behind a collapsed disclosure.
 */

// Deeper than this is not a form a person can review row by row; it is shown
// compactly, and the raw disclosure still carries the exact data.
const MAX_DEPTH = 4;
const COMPACT_TEXT_LIMIT = 300;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Field names that services write as one lowercase word but a person reads as two.
const COMPOUND_WORDS: Record<string, string[]> = {
  firstname: ["first", "name"],
  lastname: ["last", "name"],
  fullname: ["full", "name"],
  jobtitle: ["job", "title"],
  phonenumber: ["phone", "number"],
  lifecyclestage: ["lifecycle", "stage"],
};

/** "createRequest" -> "Create request", "lastname" -> "Last name". */
export function humanizeKey(key: string): string {
  const safeKey = escapeReviewText(key);
  const words = safeKey
    .replace(/[_\-.]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean)
    .flatMap((word) => COMPOUND_WORDS[word] ?? [word]);
  if (words.length === 0) return safeKey;
  return words
    .map((word, index) => {
      const acronym = word.length > 1 && word === word.toUpperCase();
      const text = acronym ? word : word.toLowerCase();
      return index === 0 ? text.charAt(0).toUpperCase() + text.slice(1) : text;
    })
    .join(" ");
}

function isPrimitive(value: unknown): value is string | number | boolean | null {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function PrimitiveText({ value }: { value: string | number | boolean | null }) {
  if (value === null) return <span className="text-muted-foreground">None</span>;
  if (typeof value === "boolean") return <span>{value ? "Yes" : "No"}</span>;
  if (typeof value === "string" && value === "") {
    return <span className="text-muted-foreground">Empty</span>;
  }
  return <span className="whitespace-pre-wrap break-words">{escapeReviewText(String(value))}</span>;
}

function compact(value: unknown): string {
  const text = escapeReviewText(serializeReviewArguments(value) ?? "Details cannot be displayed safely.");
  return text.length > COMPACT_TEXT_LIMIT ? `${text.slice(0, COMPACT_TEXT_LIMIT)}…` : text;
}

function Rows({ value, depth }: { value: Record<string, unknown>; depth: number }) {
  const entries = Object.entries(value);
  return (
    <dl className={depth === 0 ? "" : "space-y-1 border-l border-border pl-3"}>
      {entries.map(([key, child]) => (
        <div
          key={key}
          className={
            depth === 0
              ? "grid gap-1 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] sm:gap-3"
              : "grid gap-0.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] sm:gap-3"
          }
        >
          <dt className="break-words text-sm text-muted-foreground">{humanizeKey(key)}</dt>
          <dd className="min-w-0 break-words text-sm">
            <ReviewValue value={child} depth={depth + 1} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function ReviewValue({ value, depth = 0 }: { value: unknown; depth?: number }): ReactNode {
  if (isPrimitive(value)) return <PrimitiveText value={value} />;
  if (depth >= MAX_DEPTH) return <code className="break-words text-xs">{compact(value)}</code>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-muted-foreground">None</span>;
    if (value.every(isPrimitive) && value.length <= 6 && value.every((item) => String(item).length <= 40)) {
      return <span className="break-words">{value.map((item) => (item === null ? "None" : escapeReviewText(String(item)))).join(", ")}</span>;
    }
    return (
      <ul className="space-y-2">
        {value.map((item, index) => (
          <li key={index} className="min-w-0">
            {value.length > 1 ? (
              <p className="mb-1 text-xs font-medium text-muted-foreground">Item {index + 1}</p>
            ) : null}
            <ReviewValue value={item} depth={depth + 1} />
          </li>
        ))}
      </ul>
    );
  }
  if (isPlainObject(value)) {
    if (Object.keys(value).length === 0) return <span className="text-muted-foreground">None</span>;
    return <Rows value={value} depth={depth} />;
  }
  return <code className="break-words text-xs">{compact(value)}</code>;
}

/** The whole set of arguments: labelled rows, plus the exact raw form, collapsed. */
export function ReviewArguments({ args }: { args: Record<string, unknown> }) {
  // The raw form is built only when opened, so a closed disclosure adds nothing
  // to the page (no duplicate copy of every value for readers or assistive tech).
  const [open, setOpen] = useState(false);
  if (serializeReviewArguments(args) === null) {
    return <p>These call details are too complex to review safely. Ask One to prepare a smaller call.</p>;
  }
  const raw = open ? escapeReviewText(serializeReviewArguments(args, true) ?? "") : "";
  return (
    <>
      <div
        role="group"
        aria-label="Call details"
        className="max-h-[40vh] divide-y overflow-y-auto overscroll-contain"
      >
        {Object.entries(args).map(([key, value]) => (
          <div key={key} className="grid gap-1 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] sm:gap-3">
            <p className="break-words text-sm text-muted-foreground">{humanizeKey(key)}</p>
            <div className="min-w-0 break-words text-sm">
              <ReviewValue value={value} />
            </div>
          </div>
        ))}
      </div>
      <details
        className="text-xs text-muted-foreground"
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary className="min-h-11 cursor-pointer py-3">Technical details</summary>
        {open && raw ? (
          <pre className="max-h-[30vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-foreground/5 p-2">
            {raw}
          </pre>
        ) : null}
      </details>
    </>
  );
}
