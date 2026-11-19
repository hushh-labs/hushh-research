import { TodoListPage } from "@/components/todos/todo-list-page";
import { Suspense } from "react";

export default function TasksPage() {
  return <Suspense fallback={null}><TodoListPage /></Suspense>;
}
