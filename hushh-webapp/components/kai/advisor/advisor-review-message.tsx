"use client";

import Link from "next/link";
import { useState } from "react";
import { useFinanceShareContext } from "@/lib/finance-sharing/use-finance-share-context";
import { advisorWorkspaceHref } from "@/lib/advisor-review/contract";
import { AdvisorWorkspace } from "./advisor-workspace";

export function AdvisorReviewMessage({ id }: { id: string }) {
  const { capture, session } = useFinanceShareContext();
  const [opened, setOpened] = useState<string | null>(null);
  const context = opened === session ? capture() : null;
  return (
    <>
      <button
        type="button"
        className="min-h-11 rounded-xl border border-border bg-card px-4 py-3 text-left"
        onClick={() => setOpened(session)}
      >
        <strong className="block ui-text-row-label">
          Advisor introduction
        </strong>
        <span className="block ui-text-helper-text">
          Open your approved Finance review workspace
        </span>
      </button>
      {context ? (
        <AdvisorWorkspace
          key={session}
          context={context}
          id={id}
          onClose={() => setOpened(null)}
        />
      ) : opened ? (
        <Link href={advisorWorkspaceHref(id)}>
          Unlock One to open this request
        </Link>
      ) : null}
    </>
  );
}
