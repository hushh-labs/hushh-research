// Provider and encrypted persistence boundaries for the production workspace.
import type {
  FollowupMailbox,
  MailFollowup,
} from "@/lib/mail/mail-followup-model";
import { dispatchLocalPkmDomainChanged } from "@/lib/pkm/pkm-domain-change-events";
import type { TodoItem } from "@/lib/todos/todo-list-model";
const fixture = document.documentElement.dataset;
let accounts = ["a", "b", "c"].map((id) => ({
  accountId: id,
  credentialId: "slot-" + id,
  email: id + "@example.test",
  isDefault: id === "a",
  provider: "google",
  status: "connected",
  capabilities: { read: true },
}));
export const PRIVATE_MAIL_GRANTS_CHANGED = "one:private-mail-grants-changed";
export const privateMailAccounts = async () => accounts;
export const disconnectPrivateMailAccount = async (
  account: string,
  connection: string,
) => {
  accounts = accounts.filter(
    (row) => row.accountId !== account || row.credentialId !== connection,
  );
  window.dispatchEvent(new Event(PRIVATE_MAIL_GRANTS_CHANGED));
  return { disconnected: true };
};
export const connectGoogleConnector = async () => ({ ok: false });
export const connectRefusalMessage = () => "Fixture";
function finding(account: string): MailFollowup {
  return {
    account,
    connection: "slot-" + account,
    source_kind: "mail_thread",
    source: "source-" + account,
    thread: "thread-" + account,
    key: account.repeat(64),
    title: "Get the signed document for " + account,
    participant: "Lab contact " + account,
    debtor: "lab-" + account + "@example.test",
    waiting_on: "participant",
    quote: "I will send the signed document.",
    fulfilment: "Waiting for the signed agreement.",
    document: "Signed agreement",
    promised_wording: null,
  };
}
function row(item: MailFollowup): TodoItem {
  return {
    id: item.key,
    title: item.title,
    type: "automatic",
    sourceAgent: "gmail",
    status: "pending",
    revision: 1,
    date: null,
    time: null,
    sourceId: item.key,
    link: null,
    notes: null,
    createdAt: "",
    updatedAt: "",
    completedAt: null,
    deletedAt: null,
    mailFollowup: item,
  };
}
let tasks = (fixture.journey === "accounts" ? ["a", "b", "c"] : []).map((id) =>
  row(finding(id)),
);
if (fixture.journey === "board") {
  const people = [
    "Lab contact",
    "Maya Rao",
    "Artwork team",
    "Design team",
    "Lake House",
    "Riya Patel",
    "Priya Shah",
  ];
  const titles = [
    "Get the signed document",
    "Get the final brand assets",
    "Review the project brief",
    "Confirm delivery",
    "Get the hotel receipt",
    "Get the vendor setup confirmation",
    "Pricing sheet sent to Priya",
  ];
  tasks = people.map((participant, index) => {
    const item = {
      ...finding(["a", "b", "c"][index % 3]!),
      key: index.toString().repeat(64),
      title: titles[index]!,
      participant,
      thread: "fixture-thread-" + index,
      waiting_on: index < 4 ? ("owner" as const) : ("participant" as const),
      document:
        [
          "Signed copy",
          "Brand assets",
          "Project brief",
          null,
          null,
          null,
          null,
        ][index] ?? null,
      reason: [
        "The lab promised the signed copy by 20 November.",
        "Maya promised the logo and banners.",
        "The team asked you to review their brief.",
        "The designer needs your delivery date.",
        "You asked the hotel for a receipt.",
        "Fieldwork is reviewing your documents.",
        "The approved pricing sheet was attached.",
      ][index],
    };
    return { ...row(item), status: index === 6 ? "done" : "pending" };
  });
}
export const TODO_LIST_PKM_DOMAIN = "one_todos";
export const TodoListPkmService = {
  load: async () => ({ tasks }),
  trackMail: async (_: unknown, item: MailFollowup) => {
    if (!tasks.some((r) => r.id === item.key)) tasks = [...tasks, row(item)];
    return { success: true };
  },
  updateMail: async (
    session: { userId: string },
    item: TodoItem,
    change: Partial<MailFollowup>,
  ) => {
    tasks = tasks.map((t) =>
      t.id === item.id
        ? {
            ...t,
            status: change.received ? "done" : t.status,
            mailFollowup: {
              ...t.mailFollowup!,
              ...change,
              ...(change.received ? { watching: false } : {}),
            },
          }
        : t,
    );
    dispatchLocalPkmDomainChanged({ userId: session.userId, domain: TODO_LIST_PKM_DOMAIN, dataVersion: null, updatedAt: null, operation: "stored" });
    return { success: true };
  },
};
function verify(box: FollowupMailbox, source: string) {
  if (
    box.connection !== "slot-" + box.account ||
    ![finding(box.account).source, "received-" + box.account].includes(source)
  )
    throw Error("Wrong mailbox");
}
let first = true;
export const MailFollowupsService = {
  account: async (account: string, connection: string) => {
    if (fixture.journey === "accounts" && account === "a" && first) {
      first = false;
      await new Promise((resolve) => window.setTimeout(resolve, 5000));
    }
    return { account, connection, address: account + "@example.test" };
  },
  brief: async () => ({ attention: [], updates: [], topics: [] }),
  recent: async () => ({ items: [] }),
  searchOverview: async () => ({ items: [] }),
  thread: async () => ({ truncated: false, items: [] }),
  search: async (box: FollowupMailbox) => ({
    items: [
      {
        source: finding(box.account).source,
        subject: "Signed agreement",
        sender: "Lab contact",
      },
    ],
  }),
  track: async (box: FollowupMailbox, source: string) => {
    verify(box, source);
    return finding(box.account);
  },
  open: async (box: FollowupMailbox, source: string) => {
    verify(box, source);
    return {
      subject: "Evidence for " + box.address,
      sender: "Lab contact",
      body: "The signed agreement.",
      body_truncated: false,
      files: [],
    };
  },
  check: async (box: FollowupMailbox, item: MailFollowup) => {
    verify(box, item.source);
    fixture.checks = String(Number(fixture.checks || 0) + 1);
    return fixture.reply === "signed"
      ? { source: "received-" + box.account, filename: "signed.pdf" }
      : { source: null, filename: null };
  },
  document: async (box: FollowupMailbox, source: string) => {
    verify(box, source);
    return { content: btoa("fixture document") };
  },
  draft: async (box: FollowupMailbox, source: string) => {
    verify(box, source);
    return {
      to: finding(box.account).debtor,
      subject: "Re: Agreement",
      body: "Draft for " + box.address,
    };
  },
};


export const privateTopicsSchema = { parse: (value: unknown[]) => value };

// Tests of the Follow-ups board must not dispatch Mail replies.
export const PrivateMailReplyService = {
  prepare: async () => { throw new Error("No reply in this fixture."); },
  send: async () => { throw new Error("No reply in this fixture."); },
  status: async () => { throw new Error("No reply in this fixture."); },
};
