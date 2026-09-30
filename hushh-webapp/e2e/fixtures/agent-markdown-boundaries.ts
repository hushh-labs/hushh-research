/**
 * The one Next.js boundary the chat answer renderer reaches: in-app links
 * route through `useRouter().push`. The fixture records the push instead of
 * navigating, so a spec can prove a same-origin link stayed in the app.
 */
export function useRouter() {
  return {
    push(href: string) {
      document.body.dataset.routerPush = href;
    },
  };
}
