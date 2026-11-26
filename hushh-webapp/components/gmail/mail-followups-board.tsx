"use client";

import { FileText } from "@/components/icons";
import type { TodoItem } from "@/lib/todos/todo-list-model";
import { mailboxTasks, type FollowupMailbox, type MailFollowup } from "@/lib/mail/mail-followup-model";
import styles from "./mail-followups-board.module.css";

const columns = ["To Do", "In Progress", "Done"] as const;
export function MailFollowupsBoard({ tasks, mailboxes, onTrack, onEvidence, onAction, actionLabel }: {
  tasks: readonly TodoItem[];
  mailboxes: readonly FollowupMailbox[];
  onTrack: () => void;
  onEvidence: (item: MailFollowup) => void;
  onAction: (task: TodoItem) => void;
  actionLabel: (task: TodoItem) => string;
}) {
  const cards = mailboxTasks(tasks, mailboxes);
  const conversations = new Set(cards.map(({ item }) => JSON.stringify([item.connection, item.thread]))).size;
  const people = [...new Set(cards.map(({ item }) => item.participant))];
  const documents = cards.filter(({ item }) => item.document);
  const count = (column: string) => cards.filter(card => card.column === column).length;
  return <section className={styles.board} aria-label="Follow-ups">
    <header className={styles.head}>
      <div><div className={styles.title}><h2>Follow-ups</h2><span>{conversations} {conversations === 1 ? "conversation" : "conversations"}</span></div>
        <p>{count("To Do")} need you · {count("In Progress")} waiting</p></div>
      <div className={styles.tools}><div className={styles.people}>{people.slice(0, 3).map(person =>
        <span key={person} title={person} aria-label={person}>{person.slice(0, 1).toLocaleUpperCase()}</span>)}
        {people.length > 3 && <span>+{people.length - 3}</span>}</div>
        <button className={styles.primary} onClick={onTrack}>Track a conversation</button></div>
    </header>
    {documents.length > 0 && <div className={styles.documents}>{documents.map(({ item, task }) =>
      <button key={task.id} onClick={() => onEvidence(item)}><FileText aria-hidden="true" size={18}/>{item.document}</button>)}</div>}
    <div className={styles.columns}>{columns.map(column =>
      <section key={column} aria-label={column}><h3>{column} <span>{count(column)}</span></h3>
        <div className={styles.stack}>{cards.filter(card => card.column === column).map(({ task, item }) =>
          <article key={task.id}><small>{column === "Done" ? item.participant :
            item.waiting_on === "owner" ? `Waiting on you · ${item.participant}` : `Waiting on ${item.participant}`}</small>
            <h4>{task.title}</h4><p>{item.fulfilment}</p>
            {item.promised_wording && <small>Promised {item.promised_wording}</small>}
            <footer><button onClick={() => onAction(task)}>{actionLabel(task)}</button>
              <button onClick={() => onEvidence(item)}>Why this?</button></footer>
          </article>)}
          {!count(column) && <p className={styles.empty}>{column === "To Do" ? "Nothing needs you here." : column === "Done" ? "No completed follow-ups yet." : "No conversations waiting for a reply."}</p>}
        </div></section>)}</div>
  </section>;
}
