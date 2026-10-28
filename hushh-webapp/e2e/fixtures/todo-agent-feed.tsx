import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { TodoListPage } from "../../components/todos/todo-list-page";
import { OneTodoPreview } from "../../components/agent/one-todo-preview";
import { useAuth } from "../../hooks/use-auth";
import { useVault } from "../../lib/vault/vault-context";
import { change, useFixture } from "./todo-agent-feed-boundaries";

function Fixture() {
  const state = useFixture();
  const [mount, setMount] = useState(0);
  const [preview, setPreview] = useState(false);
  const { user, userId } = useAuth();
  const vault = useVault();
  return (
    <>
      <nav aria-label="Test controls">
        <button onClick={() => change({ unlocked: !state.unlocked })}>
          Toggle lock
        </button>
        <button onClick={() => change({ error: true })}>
          Simulate refresh failure
        </button>
        <button onClick={() => change({ failSave: !state.failSave })}>
          Toggle save failure
        </button>
        <button onClick={() => change({ hideAgent: !state.hideAgent })}>
          Toggle agent task
        </button>
        <button onClick={() => setMount((value) => value + 1)}>
          Reopen list
        </button>
        <button onClick={() => { change({ preview: true }); setPreview(true); }}>Open agent Todo</button>
      </nav>
      {state.message ? <p role="alert">{state.message}</p> : null}
      {state.href ? (
        <section aria-label="Agent workspace">Request review workspace</section>
      ) : preview && user && userId ? (
        <aside data-app-side-pane className="mx-auto w-full max-w-[430px] p-4">
          <OneTodoPreview user={user} ownerId={userId} {...vault} />
        </aside>
      ) : (
        <TodoListPage key={mount} />
      )}
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
