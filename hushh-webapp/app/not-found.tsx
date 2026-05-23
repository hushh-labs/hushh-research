import { redirect } from "next/navigation";

export default function AppNotFoundPage() {
  redirect("/");
}