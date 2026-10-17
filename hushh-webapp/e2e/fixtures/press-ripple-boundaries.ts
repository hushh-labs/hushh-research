// Make the real email entry button available without sending any auth requests.
export const ApiService = {
  emailAuthRequest: async (operation: string) => {
    if (operation === "capabilities") return { enabled: true };
    throw new Error("Layout fixture cannot send email auth requests");
  },
};
