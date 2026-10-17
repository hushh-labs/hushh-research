/** One real operator-issued Firebase token per exact owner/main-frame context. */
export async function installOperatorReviewerTokenBinding(page, { appOrigin, reviewerUid, issueToken }) {
  const origin = new URL(appOrigin);
  if (origin.protocol !== "https:" || origin.origin !== appOrigin || !reviewerUid || typeof issueToken !== "function") {
    throw new Error("Explicit HTTPS operator reviewer authority is required.");
  }
  let issued = false;
  await page.exposeBinding("__hushhIssueOperatorReviewerToken", async (source, requestedUid) => {
    if (source.page !== page || source.frame !== page.mainFrame() ||
        new URL(source.frame.url()).origin !== appOrigin || requestedUid !== reviewerUid || issued) {
      throw new Error("Operator reviewer token authority refused.");
    }
    issued = true;
    const token = await issueToken(reviewerUid);
    if (typeof token !== "string" || !token) throw new Error("Operator reviewer token unavailable.");
    return token;
  });
}
