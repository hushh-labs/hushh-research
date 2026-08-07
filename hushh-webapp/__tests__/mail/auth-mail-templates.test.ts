import { describe, expect, it } from "vitest";

import { escapeHtml, FONT_STACK, safeUrl } from "@/lib/mail/email-shell";
import {
  buildPhoneConflictMail,
  buildWelcomeBackMail,
  buildWelcomeMail,
  firstNameOf,
  formatSignInMoment,
  maskEmail,
} from "@/lib/mail/auth-mail-templates";

const APP_URL = "https://one.hushh.ai";

describe("email shell primitives", () => {
  it("escapes markup so caller data cannot inject HTML", () => {
    expect(escapeHtml('<script>"x"&\'y\'</script>')).toBe(
      "&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;",
    );
  });

  it("drops any scheme that is not http, https or mailto", () => {
    expect(safeUrl("javascript:alert(1)")).toBe("");
    expect(safeUrl("data:text/html,<b>x</b>")).toBe("");
    expect(safeUrl("https://one.hushh.ai/login")).toBe("https://one.hushh.ai/login");
    expect(safeUrl("mailto:support@hushh.ai")).toBe("mailto:support@hushh.ai");
    expect(safeUrl("not a url", "https://fallback.test/")).toBe("https://fallback.test/");
  });

  it("uses the vendor font stack and never a webfont", () => {
    const { html } = buildWelcomeMail({ displayName: "Ankit" });
    expect(html).toContain(FONT_STACK);
    expect(html).not.toContain("fonts.googleapis.com");
    expect(html).not.toContain("@font-face");
    // Gmail strips <style> blocks and classes; everything must be inline.
    expect(html).not.toContain("<style");
    expect(html).not.toContain("class=");
  });
});

describe("masking", () => {
  it("keeps an email recognisable without disclosing it", () => {
    expect(maskEmail("ankit.singh@gmail.com")).toBe("an•••@gmail.com");
    expect(maskEmail("a@hushh.ai")).toBe("a•••@hushh.ai");
    expect(maskEmail("not-an-email")).toBe("");
    expect(maskEmail(null)).toBe("");
  });

  it("takes only a plausible first name from a display name", () => {
    expect(firstNameOf("Ankit Kumar Singh")).toBe("Ankit");
    expect(firstNameOf("ankit@hushh.ai")).toBe("");
    expect(firstNameOf("A")).toBe("");
    expect(firstNameOf(null)).toBe("");
  });

  it("stamps the sign-in moment in UTC so it is unambiguous", () => {
    expect(formatSignInMoment(new Date("2026-08-05T09:12:00Z"))).toBe(
      "5 August 2026 at 09:12 UTC",
    );
  });
});

describe("welcome mail", () => {
  it("greets by first name and offers one action", () => {
    const mail = buildWelcomeMail({ displayName: "Ankit Kumar Singh" });
    expect(mail.subject).toBe("Welcome to One");
    expect(mail.html).toContain("Ankit, you&#39;re in.");
    expect(mail.html).toContain(`href="${APP_URL}/"`);
    // One CTA, not two.
    expect(mail.html.match(/display:inline-block;padding:14px 32px/g)).toHaveLength(1);
  });

  it("falls back to a neutral greeting without a name", () => {
    const mail = buildWelcomeMail({ displayName: null });
    expect(mail.html).toContain("You&#39;re in.");
    expect(mail.text).toContain("You're in.");
  });
});

describe("welcome back mail", () => {
  it("states when the sign-in happened", () => {
    const mail = buildWelcomeBackMail({
      displayName: "Ankit",
      signedInAt: new Date("2026-08-05T09:12:00Z"),
    });
    expect(mail.subject).toBe("Welcome back to One");
    expect(mail.html).toContain("Welcome back, Ankit.");
    expect(mail.html).toContain("5 August 2026 at 09:12 UTC");
    expect(mail.text).toContain("Signed in: 5 August 2026 at 09:12 UTC");
  });
});

describe("phone conflict mail", () => {
  it("shows the number in full and the other account only masked", () => {
    const mail = buildPhoneConflictMail({
      displayName: "Ankit",
      attemptedPhoneNumber: "+919876543210",
      linkedAccountEmail: "ankit.old@gmail.com",
    });
    expect(mail.subject).toBe("That number is on another account");
    // The recipient typed this number a moment ago, so masking it would hide
    // nothing from them and only make the mail harder to act on.
    expect(mail.text).toContain("Number: +919876543210");
    expect(mail.html).toContain("+919876543210");
    // The other account is somebody else's, and stays a hint.
    expect(mail.text).toContain("Account: an•••@gmail.com");
    expect(mail.html).not.toContain("ankit.old@gmail.com");
    expect(mail.html).toContain(`href="${APP_URL}/login"`);
  });

  it("omits the account row for a phone-only owner with no address to show", () => {
    const mail = buildPhoneConflictMail({
      displayName: null,
      attemptedPhoneNumber: "+919876543210",
      linkedAccountEmail: null,
    });
    expect(mail.text).not.toContain("Account:");
    expect(mail.text).toContain("Number: +919876543210");
  });
});

describe("every link points at the product", () => {
  // The regression this guards: a UAT deploy mails real inboxes, and a link
  // built from the sending origin lands them on uat.one.hushh.ai.
  const mails = [
    buildWelcomeMail({ displayName: "Ankit" }),
    buildWelcomeBackMail({ displayName: "Ankit", signedInAt: new Date("2026-08-05T09:12:00Z") }),
    buildPhoneConflictMail({
      displayName: "Ankit",
      attemptedPhoneNumber: "+919876543210",
      linkedAccountEmail: "ankit.old@gmail.com",
    }),
  ];

  it.each(mails.map((mail, index) => [index, mail] as const))(
    "mail %i links only to one.hushh.ai",
    (_index, mail) => {
      const hrefs = [...mail.html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
      expect(hrefs.length).toBeGreaterThan(0);
      for (const href of hrefs) {
        expect(href.startsWith("https://one.hushh.ai") || href.startsWith("mailto:")).toBe(true);
      }
      expect(mail.html).not.toContain("uat.");
      expect(mail.text).not.toContain("uat.");
    },
  );

  it("loads the One app icon, not another product's logo", () => {
    expect(mails[0].html).toContain('src="https://one.hushh.ai/quiet-emoji-icon.png"');
    expect(mails[0].html).not.toContain("hushhtech.com");
  });
});
