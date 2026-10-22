"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { NativeShellBack } from "@/components/app-ui/native-shell-back";
import { ROUTES } from "@/lib/navigation/routes";
import { navigateTopShellBack } from "@/lib/navigation/top-shell-back";

export function MessagesBackButton({ owner, active }: { owner: string | null; active: boolean }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  if (!active) return null;

  return (
    <NativeShellBack
      label="Go back"
      owner={owner}
      context={`${ROUTES.ONE_MESSAGES}?${searchParams.toString()}`}
      eligible={Boolean(owner)}
      onBack={() => navigateTopShellBack({
        pathname: ROUTES.ONE_MESSAGES,
        searchParams,
        navigate: (action) => router[action.mode](action.href, { scroll: false }),
      })}
    />
  );
}
