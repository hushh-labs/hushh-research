// The Hussh One Privacy Policy and Terms of Use.
//
// This file is the single source for both documents. The public /privacy and
// /terms pages (linked from sign-in) and Profile's Legal section all render it
// through components/legal/legal-reader.tsx, so the text a person agrees to at
// sign-in is the text they read in the app.
//
// Every statement about how information is handled must be true of the code
// on this branch. Change the code and this text together. When the text
// changes, bump `version` and `lastUpdated`.

export type LegalDocumentType = "privacy" | "terms";

export type LegalInline = string | { text: string; href: string };

export type LegalBlock =
  | { kind: "p"; text: LegalInline[] }
  | { kind: "h"; text: string }
  | { kind: "list"; items: LegalInline[][] };

export type LegalSection = {
  id: string;
  title: string;
  blocks: LegalBlock[];
};

export type LegalDocument = {
  type: LegalDocumentType;
  title: string;
  route: "/privacy" | "/terms";
  version: string;
  /** ISO date, YYYY-MM-DD. */
  lastUpdated: string;
  lastUpdatedLabel: string;
  summary: string;
  sections: LegalSection[];
};

export const LEGAL_CONTACT_EMAIL = "support@hushh.ai";
export const LEGAL_PRIVACY_EMAIL = "privacy@hushh.ai";
export const LEGAL_POSTAL_ADDRESS =
  "HushOne, Inc., 1021 5th St W, Kirkland, WA 98033, USA";

const LIMITED_USE_POLICY_URL =
  "https://developers.google.com/terms/api-services-user-data-policy";
const GOOGLE_PERMISSIONS_URL = "https://myaccount.google.com/permissions";

const LAST_UPDATED = "2026-09-27";
const LAST_UPDATED_LABEL = "September 27, 2026";
const VERSION = "2.1";
const PRIVACY_LAST_UPDATED = "2026-09-30";
const PRIVACY_LAST_UPDATED_LABEL = "September 30, 2026";
const PRIVACY_VERSION = "2.2";

const p = (...text: LegalInline[]): LegalBlock => ({ kind: "p", text });
const h = (text: string): LegalBlock => ({ kind: "h", text });
const list = (...items: (string | LegalInline[])[]): LegalBlock => ({
  kind: "list",
  items: items.map((item) => (typeof item === "string" ? [item] : item)),
});
const mail = { text: LEGAL_CONTACT_EMAIL, href: `mailto:${LEGAL_CONTACT_EMAIL}` };
const privacyMail = {
  text: LEGAL_PRIVACY_EMAIL,
  href: `mailto:${LEGAL_PRIVACY_EMAIL}`,
};
const deleteAccountLink = {
  text: "one.hushh.ai/delete-account",
  href: "/delete-account",
};

const PRIVACY_SECTIONS: LegalSection[] = [
  {
    id: "introduction",
    title: "Introduction",
    blocks: [
      p(
        "Hussh One is your private agent. It answers you, remembers what you choose to save, works with the services you connect, and shares your information with other people only when you approve. This Privacy Policy explains what information One collects, how it is protected, how it is used, who it is shared with, and the choices you have.",
      ),
      p(
        "It applies to the Hussh One apps for iPhone and Android and to one.hushh.ai, including Kai, the investing feature inside One. It is provided by HushOne, Inc. (“Hussh”, “we”, “us”). The hushh.ai website has its own privacy policy.",
      ),
      p(
        "We have tried to describe what One actually does, including its limits. Where information is readable by our systems, we say so. Some features described here are not available to everyone yet; where that is the case, we say “where available”.",
      ),
    ],
  },
  {
    id: "short-version",
    title: "The short version",
    blocks: [
      list(
        "Your vault and the memories you save are encrypted on your device with a key only you hold before they are stored. We never receive that key.",
        "To answer you, One sends the information a request needs, which can include your memories, to our servers and to the AI model for that request. It is readable there while the request runs.",
        "Your chat history is stored encrypted with a key derived from your vault key, which your device sends only while One is working on your request.",
        "Services you connect, such as Gmail, Google Calendar, Google Drive, and your bank through Plaid, are used only to do what you ask. Google information is handled under Google’s Limited Use requirements.",
        "You decide what to share with other people and businesses, for how long, and you can revoke access at any time.",
        "We do not sell your information, and we do not show you ads.",
        "You can delete your account in the app at any time.",
      ),
    ],
  },
  {
    id: "information-we-collect",
    title: "Information we collect",
    blocks: [
      h("Account information"),
      p(
        "You sign in with Apple, Google, or a phone number, through Google Firebase Authentication. Phone sign-in sends a code by text message through Firebase and may use Google reCAPTCHA to prevent abuse. We store your name, email address, profile photo, and phone number, and whether the email and phone number are verified.",
      ),
      h("What you tell One and choose to save"),
      p(
        "Your conversations with One, and the memories, notes, and records you save to your vault. How these are protected is described in the next section.",
      ),
      h("Information from services you connect"),
      p(
        "If you connect Gmail, Google Calendar, Google Drive, Google Contacts, a bank or brokerage through Plaid, or tools you add yourself, or import a brokerage statement, One receives the information those services or files contain for your requests. Each is described below.",
      ),
      h("Location"),
      p(
        "Approximate location with a chat request, if your device already allows it, and live location you choose to share with people, including in an emergency alert. See “Location” below.",
      ),
      h("Contacts"),
      p(
        "If you choose to check your contacts, One reads phone numbers from your device’s address book or, if you allow it, from Google Contacts. Google Contacts is read directly by the app on your device with a token our servers never receive. On your device, numbers are standardized and turned into hashed codes, and only those codes and the last four digits are checked for matches. Because phone numbers are predictable, these codes protect the numbers but are not anonymous. One never stores your contacts’ names or numbers, and nobody is contacted for you. When a contact is on One and can be found, the two of you are connected; this gives neither of you access to the other’s location or information.",
      ),
      h("Messages to One’s mailbox"),
      p(
        "If you turn on One’s mailbox and you, or someone asking you for information, emails One at one@hushh.ai, One reads the message to recognize the request and prepares a reply for you to review. We store the sender’s name and email address, the other participants, the subject, and a short snippet, and the subject and up to the first 4,000 characters of the message are given to the AI model. Nothing is sent from that mailbox on your behalf without your approval.",
      ),
      h("Device and usage information"),
      p(
        "A notification token for your device, basic device and app details, and product analytics described in “Analytics and cookies” below. Our servers also keep operational logs, such as request times, routes, and error codes, to run and secure One. Our agent telemetry does not record the content of your messages.",
      ),
    ],
  },
  {
    id: "vault-and-chats",
    title: "How your vault and chats are protected",
    blocks: [
      h("Your vault and memories"),
      p(
        "Your vault key is a random AES-256-GCM key created on your device. It is protected by your passphrase, a passkey, your device’s biometric unlock, or your recovery key, and we never receive it. Memories are encrypted with it on your device before they are stored, so what we store for them is encrypted.",
      ),
      p("There are important limits to this, and we want you to know them:"),
      list(
        "To answer a request, your device sends the relevant memories to our servers, and One gives them to the AI model for that request. They are held in memory for that request and are not written to our database in readable form.",
        "When you save a new memory, the note is sent to our servers and an AI model to organize it before it is encrypted, and is held in memory briefly while that happens.",
        "Some descriptive details about your memories are stored readable so One can organize them, such as the names and counts of categories, timestamps, and a short summary. For investing, this includes a risk profile and asset-allocation percentages.",
      ),
      h("Your chat history"),
      p(
        "Chat titles, messages, and One’s working session are encrypted with AES-256-GCM using a key your device derives from your vault key. Your device sends that chat key with each request. Our servers use it only while One is working on your request, and if you leave the app while One is still answering, keep it in memory for up to five minutes so the answer can be saved; it is never written to our database. Our servers see the text of a conversation while answering it.",
      ),
      p(
        "Some details about chats are stored readable, such as conversation and message identifiers, timestamps, status, and which model answered. Chats saved before we moved to your chat key were sealed with a key we hold and may still exist; they are deleted when you delete your account.",
      ),
      h("Information protected with keys we hold"),
      p(
        "Some information has to be usable by our servers when you are not in the app, so it is encrypted with keys Hussh manages rather than your vault key. This includes sign-in tokens for Google services, credentials for connectors we offer in the app, files you add from Google Drive, and nearby check-ins and place visits.",
      ),
    ],
  },
  {
    id: "ai-models",
    title: "How One uses AI models",
    blocks: [
      p(
        "One answers you with Google Gemini, running on Google Cloud Vertex AI. For each request, the model receives what that request needs: your message, relevant parts of your conversation, and, when relevant or when you ask, your memories and information from connected services or from people who shared with you. That can include sensitive information you asked One to use.",
      ),
      list(
        "Google processes these requests as our service provider under Google Cloud’s terms. Requests may be processed in any Google Cloud location, including the United States and the European Union.",
        "When One searches the web for you, it uses Google Search through Vertex AI. The search can include your approximate location if you shared it with that request.",
        "In Settings you can instead connect One to Gemini with your own key or your own Google Cloud project. Requests then go to Google under your own account, in the location you choose. Your key is stored in your vault.",
        "Where voice mode is available, your speech is streamed to Google’s Gemini Live model on Google Cloud Vertex AI in the United States, which transcribes it to understand and answer you. We do not store your audio or a transcript; we keep a short-lived session record, without your words, for up to two hours.",
        "If you use Siri to ask One something or to send an alert, Apple processes that request under Apple’s own terms before handing it to One.",
        "Hussh does not use your information, your memories, or your connected services’ information to train AI models.",
      ),
    ],
  },
  {
    id: "kai",
    title: "Investing with Kai",
    blocks: [
      p(
        "Kai is the investing feature inside One. It is optional, and it is one of many things One does.",
      ),
      list(
        "Statement import. You can import a brokerage statement as a PDF or CSV file of up to 25 MB. The file’s contents are given to Gemini on Google Cloud Vertex AI to find your holdings. The file is processed in memory and is not stored. You review the holdings, and when you confirm, they are encrypted on your device and saved to your vault.",
        "Analysis. To analyze a stock or your portfolio, One gives the AI model the details the analysis needs, which can include up to 30 of your holdings, their total value, your cash, your income, and your risk profile.",
        "Market information. To gather prices, filings, and news, One asks market-information providers, such as Finnhub, Financial Modeling Prep, NewsAPI, Google News, Yahoo Finance, and SEC EDGAR, about the company or ticker only. They do not receive your account identifier or your holdings.",
        "What is stored readable. The summary details described above, analysis decisions you choose to save (the ticker, the recommendation, its confidence, and the time), and the status of a running import or analysis for up to six hours.",
      ),
    ],
  },
  {
    id: "location",
    title: "Location",
    blocks: [
      h("Approximate location with a request"),
      p(
        "If your device already allows One to use your location, One includes an approximate position, rounded on your device to about one kilometre, with a chat request so it can answer questions like “what’s the weather here”. One does not show a permission prompt for this; if location is off, it may tell you how to turn it on. Our servers keep it in memory for a few minutes to finish that request, and it is not written to our database or to our logs as a location. The AI model receives the rounded position, and if One uses it to answer, that answer is saved in your encrypted chat history like any other reply.",
      ),
      h("Live location sharing"),
      p(
        "You can share your live location with people you choose, either for a set time of up to 24 hours or, with people you trust, until you stop. Each update is encrypted on your device to the recipient’s device key, so we cannot read it in storage. We can see who is sharing with whom and when. To show the recipient an address or travel time, their app sends the position they received to our servers, which look it up with Google Maps Platform without storing it. Updates from a share that has ended are removed by a scheduled cleanup, and all of them are deleted when you delete your account.",
      ),
      p(
        "If you join a circle, you are connected with its other members, and members can invite people they are connected to.",
      ),
      h("Emergency alerts"),
      p(
        "If you send a Save My Soul alert, from the app or with Siri, One shares your live location with the emergency contacts you chose, who must be One users, for eight hours, and notifies them. It also emails them: your device sends your precise position to our servers, which send an email containing your coordinates, a map link, and any note you added. Our servers do not store or log that position, but the email stays in your contacts’ inboxes, and deleting your account cannot recall it.",
      ),
      h("Public location links"),
      p(
        "If you create a public location link, the position shown on that link is stored readable so anyone with the link can see it. A link lasts up to two hours, and its record is removed within about half a day after it expires or you stop it. People who open your link can leave you their name, phone number, and a message. We store the phone number as a hashed code with its last four digits and may use it to recognize a One account, along with a hashed code of their device and network to prevent abuse.",
      ),
      h("Nearby"),
      p(
        "Where available, you can check in at a place. Picking a place sends your position to Google Maps Platform. While you are checked in, other people checked in within about 500 metres can see your display name and the place, and can ask to connect with you. Check-ins are removed within about half a day after they end, and the encrypted record of the visit is deleted after seven days. A rating you give is stored with your account and the place and, once enough people have rated it, counts toward an anonymous public average that never shows who rated.",
      ),
    ],
  },
  {
    id: "google-services",
    title: "Gmail, Google Calendar, Google Drive, and Google Contacts",
    blocks: [
      p(
        "Connecting a Google service is optional. Google shows you the exact permissions before you agree. Depending on what you turn on, One asks for:",
      ),
      list(
        "Gmail: read your mail and send mail you approve. If you turn them on, also create drafts, and organize your mailbox (archive, label, mark read or unread, and move to trash).",
        "Google Calendar: read your events and free or busy times, and, if you allow it, create and change events.",
        "Google Drive, where available: access to files you pick, read-only access, or, if you turn on full access, your whole Drive.",
        "Google Contacts: read-only access to your contacts, used only on your device to find people you know on One, as described in “Contacts” above.",
      ),
      h("How One uses it"),
      list(
        "One reads Gmail, Calendar, and Drive to do what you ask, such as find a message, summarize your day, or answer a question from a file.",
        "If you turn on request detection for Gmail, One checks new mail in the background with the AI model to find requests for your information, and keeps details of the requests it finds for 30 days.",
        "Sending an email, creating a draft, changing your mailbox, changing your calendar, and sharing or trashing a Drive file always wait for you to review and approve the exact action. One never permanently deletes email.",
        "Creating, copying, moving, renaming, and commenting on Drive files can happen when One does them for you as part of a request.",
      ),
      h("What we store"),
      list(
        "Your Google sign-in tokens, encrypted at rest with keys Hussh holds.",
        "For purchase receipts found in Gmail: the subject, a short preview, the sender, and the merchant, amount, and order number. A receipt’s subject and preview may be given to the AI model to recognize it.",
        "For Drive files you add to One: the file text, split into passages and indexed so One can search it, encrypted at rest with a key Hussh holds.",
        "Other mail, calendar events, Drive files, and contacts are read when needed and are not stored, except as described above.",
      ),
      h("Disconnecting"),
      p(
        "You can disconnect in Profile, Connectors. Disconnecting Gmail deletes its tokens and stored receipts and revokes One’s access at Google. Disconnecting a single Google service stops One using it; to revoke all of One’s Google access, disconnect your Google account in One or at ",
        { text: "myaccount.google.com/permissions", href: GOOGLE_PERMISSIONS_URL },
        ". If One shared a Drive file for you, deleting your account does not undo that sharing in Drive.",
      ),
      h("Google API Services User Data Policy: Limited Use"),
      p(
        "Hussh One’s use and transfer to any other app of information received from Google APIs will adhere to the ",
        { text: "Google API Services User Data Policy", href: LIMITED_USE_POLICY_URL },
        ", including the Limited Use requirements. In particular:",
      ),
      list(
        "We use information from Google APIs only to provide and improve the features you use in One that rely on it.",
        "We transfer it to others only to provide those features, as the law requires, for security, or as part of a merger or acquisition with your notice.",
        "We do not use it for advertising, including retargeting or personalized ads.",
        "We do not sell it, and we do not use it to determine creditworthiness or for lending.",
        "No person at Hussh reads it unless you ask us to for specific messages or files, it is needed for security or to investigate abuse, the law requires it, or it has been aggregated and anonymized for internal operations.",
        "We do not use information from Google Workspace APIs to develop, improve, or train generalized AI or machine learning models.",
      ),
    ],
  },
  {
    id: "your-connectors",
    title: "Other connectors and tools",
    blocks: [
      p(
        "You can add your own tools that use the Model Context Protocol (MCP). Their settings and access tokens are stored in your vault, and our servers receive them only for the request that uses them. We store the tool’s address and the name you give it so One can list it. Because these are your own tools, One can call them for you without asking you to approve each call, unless a tool changes after you added it. Only add tools you trust, and remember that the tool’s operator receives what One sends it.",
      ),
      p(
        "For connectors we offer in the app, your credential is stored on our servers, encrypted with a key Hussh holds, and One asks you to review its actions by default.",
      ),
    ],
  },
  {
    id: "banks-plaid",
    title: "Banks and brokerages (Plaid)",
    blocks: [
      p(
        "You can connect bank and brokerage accounts through Plaid. Plaid’s own privacy policy applies to the information you give Plaid. Depending on the account and what you approve, One receives transactions, investment holdings, and account and identity details from Plaid. To identify you to Plaid, we use a pseudonymous identifier rather than your name or email address.",
      ),
      p(
        "The Plaid access token and the accounts, holdings, and transactions One receives are sealed in your vault with your key. Our servers pass requests to Plaid without storing tokens or account details in our database.",
      ),
    ],
  },
  {
    id: "sharing-with-people",
    title: "Sharing with people and businesses you choose",
    blocks: [
      list(
        "Consent-based sharing. A person or business can ask to see specific categories of your information and say why. When you approve, your device encrypts those records to the recipient’s key, and our servers store only the encrypted copy. The recipient gets only the categories you approve, and never other categories. Access expires after the period shown when you approve (seven days by default for requests from people), and you can revoke it at any time.",
        "What the recipient’s One does with it. When the recipient asks their One about what you shared, it is decrypted for that request, held on our servers for up to ten minutes, and given to the AI model. One’s answer is saved in the recipient’s chat history and stays there after access ends. Revoking removes the stored copy, but cannot take back what the recipient already saw or One already told them.",
        "What we record about requests. We store who asked, the purpose they gave, the categories they asked for, and your decision, so both of you can see the request and so it can be audited.",
        "Businesses asking for your preferences. A business can ask for specific details, such as your privacy preferences, and gets only the fields you approve.",
        "Being found by your contacts. If your phone number is verified, people who have it in their contacts can find you and connect with you unless you turn this off in Profile.",
        "The people directory is opt-in. You appear in it only if you turn on Marketplace visibility in Profile. While it is on, other signed-in One users can find you by name or email and see your name, photo, and a partly hidden email address and phone number. Turn it off in Profile at any time to leave the directory.",
        "Live location and emergency alerts, as described above.",
      ),
    ],
  },
  {
    id: "notifications",
    title: "Notifications",
    blocks: [
      p(
        "If you allow notifications, we store a token for your device and send notifications through Google Firebase Cloud Messaging, which uses Apple’s push service for iPhones. Notifications can show who is asking and a short description, for example that a person asked to see your information and which business or person they are, that someone shared their location with you or sent an emergency alert, or that someone joined a circle. If you leave the app while One is still answering, you may get a notification that says only that One replied, without the reply. You can turn notifications off in your device settings.",
      ),
    ],
  },
  {
    id: "analytics-and-cookies",
    title: "Analytics and cookies",
    blocks: [
      p(
        "We measure how One is used with Google Analytics on the web and Firebase Analytics in the apps. Events are limited to an allowlist of fields about screens and features and do not include the content of your messages, memories, or connected services. Instead of your account identifier, analytics receives a one-way code derived from it. That code is pseudonymous rather than anonymous: someone who already knows your account identifier could link it to you.",
      ),
      p(
        "On the web we also load Google Tag Manager, which loads our analytics. One uses a secure session cookie to keep you signed in and a few cookies to remember interface settings, and Google Analytics sets its own cookies. We do not add advertising tags, and we do not use your information to personalize ads or track you across other companies’ apps or websites for advertising.",
      ),
    ],
  },
  {
    id: "how-we-share",
    title: "When we share information",
    blocks: [
      p(
        "We do not sell your information or share it for advertising. We share it only in these cases:",
      ),
      list(
        "Service providers that run One for us, under contracts that limit their use of it: Google Cloud (hosting, database, logging, and Vertex AI, including Gemini and Google Search), Google Firebase (sign-in, text-message codes, notifications, and app analytics), Google Analytics and Google Tag Manager, Google Maps Platform (places, addresses, and travel times), Apple (Sign in with Apple, notifications, Siri, and Apple Wallet cards you choose to add), and Plaid (bank connections you make). Email we send for you or to you, such as emergency alerts, goes through our own mail service using Google.",
        "Market-information providers, which receive only the company or ticker you ask Kai about, as described above.",
        "Providers you choose. When you connect a service, add your own tool, or use your own model key, information goes to that provider to do what you asked.",
        "People and businesses you approve, as described above.",
        "Legal reasons. If we reasonably believe disclosure is needed to comply with law, legal process, or an enforceable government request, to protect the safety or rights of any person, or to detect and prevent fraud or security problems. Information encrypted with your vault key cannot be read by us, so we cannot disclose it in readable form.",
        "Business transfers. If Hussh is involved in a merger, acquisition, or sale of assets, information may be transferred, and this policy will continue to apply to it. We will tell you before that happens.",
      ),
    ],
  },
  {
    id: "retention-and-deletion",
    title: "Keeping and deleting information",
    blocks: [
      p(
        "We keep your information while you have an account and use it only to provide One. Where this policy gives a shorter period for something, such as location records, request details, or the status of a running task, it is deleted on that schedule. You can delete memories, chats, and connections in the app, and disconnecting a service deletes what we stored from it as described above.",
      ),
      h("Deleting your account"),
      p(
        "Go to Profile, then Delete account, and unlock your vault to confirm, or follow the steps at ",
        deleteAccountLink,
        ". When you delete your account, we erase your profile, vault, memories, chat history, location sharing, emergency contacts, connections, connectors, and settings, try to revoke One’s access at Google and other providers, and delete your sign-in account. If resources for your account are still running outside our own systems, the app will say that deletion cannot finish yet; contact ",
        mail,
        " and we will help you remove them.",
      ),
      h("What we keep after deletion"),
      list(
        "Receipts of the preference subscriptions you granted to or revoked from businesses, including your account identifier, the business, the fields, and the purpose, because they form a tamper-evident ledger.",
        "A one-way code derived from your account identifier, so a deleted account cannot be silently recreated or restored.",
        "Database backups. Automated backups rotate on their configured schedule. Manually created backups may remain until an authorized operator deletes them. Deleted information can remain in those backups until they are removed.",
      ),
      p(
        "Deleting your account cannot recall what you already shared with others, such as information a recipient already saw, emails sent to your emergency contacts, or files One shared for you in Google Drive.",
      ),
    ],
  },
  {
    id: "your-rights",
    title: "Your choices and rights",
    blocks: [
      p(
        "You can see and change your profile, memories, connections, sharing, and notification choices in the app, and delete your account at any time. Depending on where you live, you may also have the right to ask for a copy of your information, to correct it, to delete it, to object to or restrict some uses, and to complain to a data protection authority. To make a request, email ",
        privacyMail,
        ". We will confirm the request comes from you before acting on it, and we will not treat you differently for making it. Because your vault is encrypted with your key, you can read its contents only in the app while it is unlocked; we cannot provide them in readable form.",
      ),
    ],
  },
  {
    id: "us-state-privacy",
    title: "US state privacy rights",
    blocks: [
      p(
        "If you live in California or another US state with a comprehensive privacy law, this section applies to you in addition to the rest of this policy.",
      ),
      h("What we collect, where it comes from, and why"),
      p(
        "The categories of personal information we collect are described in “Information we collect” and the sections after it: identifiers (such as your name, email address, phone number, and account identifier), financial information you connect or import, purchase details from receipts, internet and app activity, approximate and precise location, audio in voice mode, and the profile details One keeps, such as an investing risk profile. It comes from you, your devices, the services you connect, and people who share with you. We use it for the purposes in this policy and keep it for the periods described in “Keeping and deleting information”.",
      ),
      h("Sensitive personal information"),
      p(
        "Some of this is sensitive personal information under state law, such as your account sign-in, financial account details, precise location you share, and the contents of mail and messages you connect. We use and disclose it only to provide the features you ask for, to keep One secure, and for the other purposes state law permits without a right to limit.",
      ),
      h("Selling and sharing"),
      p(
        "We do not sell your personal information and do not share it for cross-context behavioral advertising, as those terms are defined in California law. We do not knowingly sell or share the personal information of anyone under 16.",
      ),
      h("Your rights"),
      list(
        "To know what personal information we have collected about you and how we use and disclose it, and to get a copy.",
        "To correct inaccurate personal information.",
        "To delete personal information, subject to the exceptions the law allows.",
        "Not to be treated differently for using these rights.",
      ),
      p(
        "To use these rights, email ",
        privacyMail,
        " or delete your account in the app. We will verify your request by confirming it comes from your account. You can use an authorized agent, and we may ask for proof that you gave them permission. If we deny your request, you can appeal by replying to our decision, and if you are not satisfied, contact your state attorney general.",
      ),
    ],
  },
  {
    id: "security",
    title: "Security",
    blocks: [
      p(
        "We protect information in transit with TLS, encrypt stored information at rest, keep service credentials in Google Cloud Secret Manager rather than in code, and design One so that your vault key never leaves your devices. No system is perfectly secure, and we cannot guarantee that information will never be accessed without authorization. We do not currently hold security certifications such as SOC 2 or FedRAMP authorization. If we learn of a breach that affects you, we will notify you as the law requires.",
      ),
    ],
  },
  {
    id: "children",
    title: "Children",
    blocks: [
      p(
        "One is meant for adults and is not directed to children. We do not knowingly collect information from children under 13, or under the minimum age where you live. If you believe a child has given us information, contact us at ",
        privacyMail,
        " and we will delete it.",
      ),
    ],
  },
  {
    id: "international",
    title: "Where information is processed",
    blocks: [
      p(
        "Hussh is based in the United States, and One runs on Google Cloud in the United States. AI requests may be processed in any Google Cloud location, including the United States and the European Union. If you use One from elsewhere, your information is transferred to and processed in those places, where privacy laws may differ from those where you live.",
      ),
    ],
  },
  {
    id: "changes",
    title: "Changes to this policy",
    blocks: [
      p(
        "We will update this policy when One changes. The version and effective date at the top show when it last changed. If a change materially affects how we use your information, we will tell you in the app or by email before it takes effect. We will not reduce your rights under this policy without your consent.",
      ),
    ],
  },
  {
    id: "contact",
    title: "Contact us",
    blocks: [
      p("Privacy questions and requests: ", privacyMail, "."),
      p("Account help: ", mail, "."),
      p("By post: ", LEGAL_POSTAL_ADDRESS, "."),
    ],
  },
];

const TERMS_SECTIONS: LegalSection[] = [
  {
    id: "agreement",
    title: "Agreement to these terms",
    blocks: [
      p(
        "These Terms of Use are an agreement between you and HushOne, Inc. (“Hussh”, “we”, “us”). They govern your use of Hussh One, your private agent, in the iPhone and Android apps and at one.hushh.ai, including Kai, the investing feature inside One (together, “One”).",
      ),
      p(
        "By creating an account or using One, you agree to these terms and to our ",
        { text: "Privacy Policy", href: "/privacy" },
        ", which explains how we handle your information. If you do not agree, do not use One.",
      ),
    ],
  },
  {
    id: "eligibility",
    title: "Who can use One",
    blocks: [
      p(
        "You must be at least 18 years old, or the age of majority where you live if that is higher, and able to form a binding contract. One is not directed to children.",
      ),
      p(
        "One is not available everywhere, and some features are limited to certain countries. We may limit or decline access where the law requires it.",
      ),
    ],
  },
  {
    id: "your-account",
    title: "Your account and your keys",
    blocks: [
      p(
        "You sign in with Apple, Google, or a phone number. Keep your sign-in method and devices secure, and tell us promptly at ",
        mail,
        " if you think someone else is using your account. You are responsible for activity under your account that results from not keeping it secure.",
      ),
      p(
        "Your vault is encrypted with a key that is created on your device and unlocked with your passphrase, passkey, device biometrics, or recovery key. We never see that key. That is what keeps your vault private, and it also means we cannot reset your passphrase or recover your recovery key. If you lose every way to unlock your vault, the information encrypted with it cannot be recovered by you or by us.",
      ),
      p(
        "Do not use anyone else’s account without their permission.",
      ),
    ],
  },
  {
    id: "your-private-agent",
    title: "What your private agent does",
    blocks: [
      p(
        "One is an AI agent that works for you. It answers questions, keeps the memories you choose to save, and, with your permission, works with services you connect, such as Gmail, Google Calendar, Google Drive where available, your bank through Plaid, and tools you add yourself, and shares information with people only when you approve.",
      ),
      list(
        "AI can be wrong. One can misunderstand you, miss information, or produce answers that are inaccurate or out of date. Check anything important before you rely on it.",
        "You stay in charge of important actions. Before One sends an email, creates a draft, changes your mailbox or calendar, shares or trashes a Drive file, or shares your information with another person, it asks you to review and approve it. Some lower-risk actions, such as creating or organizing Drive files, and calls to tools you add yourself, can run without a separate approval. You are responsible for actions you approve and for the tools you connect.",
        "Connected services have their own terms. When you connect Google, Plaid, or another provider, their terms and privacy policies also apply to your use of them. You can disconnect them at any time.",
      ),
    ],
  },
  {
    id: "not-professional-advice",
    title: "Not financial, legal, tax, or medical advice",
    blocks: [
      p(
        "One and Kai, the investing feature inside One, are educational and informational tools. They do not provide investment, legal, tax, or medical advice, and they are not a substitute for a licensed professional.",
      ),
      list(
        "Hussh is not a registered investment adviser or broker-dealer with the SEC or any state securities regulator.",
        "Kai does not manage portfolios or execute trades for you. You decide what to do with your money.",
        "One and Kai are not part of the investment services of Hushh Technologies Fund A or any other fund, and do not solicit for any fund or investment product.",
      ),
    ],
  },
  {
    id: "sharing-with-people",
    title: "Sharing with other people",
    blocks: [
      p(
        "One lets you share specific information, such as a scoped set of records or your live location, with people you choose. You decide what to share, with whom, and for how long, and you can stop sharing at any time. Once someone has seen information you shared, or their One has answered them using it, stopping sharing does not undo that, so share thoughtfully. Anyone who has a public location link you create can see your location until it expires or you stop it.",
      ),
      p(
        "Only share information about other people when you have the right to do so.",
      ),
    ],
  },
  {
    id: "emergency-alerts",
    title: "Emergency alerts are not an emergency service",
    blocks: [
      p(
        "Save My Soul alerts share your location with, and notify, the emergency contacts you chose. They are not a substitute for emergency services. In an emergency, call your local emergency number, such as 911 in the United States.",
      ),
      p(
        "Alerts depend on your device, its location and network connection, our servers, and your contacts’ devices and notification settings, and they can be delayed or fail. An alert you start with Siri is sent without a further confirmation step. Hussh does not monitor alerts and does not contact anyone other than the people you chose.",
      ),
    ],
  },
  {
    id: "acceptable-use",
    title: "Acceptable use",
    blocks: [
      p("You agree not to:"),
      list(
        "use One for anything unlawful, or to harass, stalk, defraud, or harm anyone, including by tracking someone’s location without their knowledge;",
        "try to gain unauthorized access to One, other people’s accounts or information, or the systems and networks behind One;",
        "probe, scan, or test the vulnerability of One, or bypass its security or authentication, except through a responsible disclosure made to us;",
        "scrape, crawl, or use automated means to access One other than through interfaces we provide for that purpose;",
        "overload or interfere with One or with anyone else’s use of it;",
        "use One to create or send spam, malware, or content that infringes other people’s rights.",
      ),
      p(
        "We may suspend or end access for anyone who breaks these rules, and we may report unlawful activity to the authorities.",
      ),
    ],
  },
  {
    id: "your-information",
    title: "Your information stays yours",
    blocks: [
      p(
        "You own the information you put into One and the information One gathers for you from services you connect. You give us permission to store, process, and transmit it only as needed to run One for you, as described in the Privacy Policy. We do not sell your information.",
      ),
    ],
  },
  {
    id: "our-content",
    title: "Our content and software",
    blocks: [
      p(
        "One’s design, text, graphics, logos, and software are owned by or licensed to Hussh and are protected by intellectual property laws. As long as you follow these terms, we give you a personal, non-exclusive, non-transferable, revocable right to use One.",
      ),
      p(
        "Parts of One are published as open source software. Those parts are licensed to you under their own open source licenses, and nothing in these terms limits your rights under those licenses.",
      ),
      p(
        "If you send us feedback or ideas, we may use them without any obligation to you.",
      ),
    ],
  },
  {
    id: "fees",
    title: "Fees",
    blocks: [
      p(
        "One is currently offered without charge. If we introduce paid features, we will show you the price and terms before you pay, and nothing will be charged without your agreement. Connected services, your mobile carrier, and any model provider you choose to use with your own key may charge you under their own terms.",
      ),
    ],
  },
  {
    id: "ending",
    title: "Ending your use of One",
    blocks: [
      p(
        "You can stop using One at any time, and you can delete your account from Profile or by following the steps at ",
        { text: "one.hushh.ai/delete-account", href: "/delete-account" },
        ". We may suspend or end your access if you break these terms, if the law requires it, or if we stop offering One. Where we reasonably can, we will tell you in advance and give you a chance to export your information.",
      ),
    ],
  },
  {
    id: "changes",
    title: "Changes to One and to these terms",
    blocks: [
      p(
        "One changes over time. We may add, change, or remove features, and we may update these terms. The version and date at the top of this page show when they last changed. If a change materially affects your rights, we will tell you in the app or by email before it takes effect. If you keep using One after a change takes effect, the updated terms apply. If you do not agree, stop using One and delete your account.",
      ),
    ],
  },
  {
    id: "disclaimers",
    title: "Disclaimers",
    blocks: [
      p(
        "ONE IS PROVIDED “AS IS” AND “AS AVAILABLE”. TO THE FULLEST EXTENT THE LAW ALLOWS, HUSSH DISCLAIMS ALL WARRANTIES, EXPRESS OR IMPLIED, INCLUDING WARRANTIES OF ACCURACY, NON-INFRINGEMENT, MERCHANTABILITY, AND FITNESS FOR A PARTICULAR PURPOSE. WE DO NOT PROMISE THAT ONE WILL BE UNINTERRUPTED OR ERROR-FREE, THAT DEFECTS WILL BE CORRECTED, OR THAT AI OUTPUT WILL BE ACCURATE OR COMPLETE.",
      ),
      p(
        "Hussh is not responsible for the acts or omissions of third-party services you connect to One, or for their content.",
      ),
    ],
  },
  {
    id: "limitation-of-liability",
    title: "Limitation of liability",
    blocks: [
      p(
        "Except where the law does not allow it, Hussh will not be liable for any indirect, consequential, exemplary, incidental, or punitive damages, including lost profits, even if we were told they were possible.",
      ),
      p(
        "If Hussh is found liable to you for any loss connected with One, our total liability will not exceed the greater of (1) the fees you paid us for One in the six months before your claim, or (2) US$100. Some jurisdictions do not allow these limits, so they may not apply to you.",
      ),
    ],
  },
  {
    id: "indemnity",
    title: "Indemnity",
    blocks: [
      p(
        "To the extent the law allows, you agree to indemnify and hold harmless Hussh and its officers, directors, employees, and agents from third-party claims, losses, and expenses, including reasonable attorneys’ fees, that arise from your breach of these terms or your misuse of One.",
      ),
    ],
  },
  {
    id: "governing-law",
    title: "Governing law and disputes",
    blocks: [
      p(
        "These terms are governed by the laws of the State of Washington and applicable United States federal law, without regard to conflict of laws rules. You and Hussh agree to the personal jurisdiction of, and venue in, the state and federal courts in King County, Washington.",
      ),
      p(
        "Before filing a claim, each of us agrees to try in good faith to resolve the dispute informally for at least 30 days, starting when one of us notifies the other in writing. If we cannot resolve it, either of us may propose mediation, and if that fails, either of us may pursue any remedy available under applicable law. Nothing in this section limits rights you have under the consumer protection laws of the place where you live.",
      ),
    ],
  },
  {
    id: "general",
    title: "General",
    blocks: [
      list(
        "You may not use or export One in violation of applicable laws, including United States export control and sanctions laws.",
        "If any part of these terms is found unenforceable, it will be limited to the minimum extent necessary, and the rest stays in effect.",
        "Our failure to enforce any part of these terms is not a waiver.",
        "These terms, together with the Privacy Policy and any feature-specific terms we show you, are the entire agreement between you and Hussh about One.",
        "You may not transfer these terms without our consent. We may transfer them as part of a merger, acquisition, or sale of assets, and we will tell you if that happens.",
      ),
    ],
  },
  {
    id: "contact",
    title: "Contact us",
    blocks: [
      p("Questions about these terms: ", mail, "."),
      p("By post: ", LEGAL_POSTAL_ADDRESS, "."),
    ],
  },
];

export const LEGAL_DOCUMENTS: Record<LegalDocumentType, LegalDocument> = {
  privacy: {
    type: "privacy",
    title: "Privacy Policy",
    route: "/privacy",
    version: PRIVACY_VERSION,
    lastUpdated: PRIVACY_LAST_UPDATED,
    lastUpdatedLabel: PRIVACY_LAST_UPDATED_LABEL,
    summary:
      "How Hussh One, your private agent, collects, protects, uses, and shares your information, and the choices you have.",
    sections: PRIVACY_SECTIONS,
  },
  terms: {
    type: "terms",
    title: "Terms of Use",
    route: "/terms",
    version: VERSION,
    lastUpdated: LAST_UPDATED,
    lastUpdatedLabel: LAST_UPDATED_LABEL,
    summary:
      "The agreement between you and Hussh for using Hussh One, your private agent.",
    sections: TERMS_SECTIONS,
  },
};
