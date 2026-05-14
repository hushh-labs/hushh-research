"use client";

import { toast } from "sonner";

export function ToastDemo() {
  return (
    <button
      onClick={() =>
        toast.success("Toast notification working!")
      }
      className="
        px-4
        py-2
        rounded-lg
        bg-black
        text-white
        dark:bg-white
        dark:text-black
        transition-all
        duration-300
      "
    >
      Show Toast
    </button>
  );
}