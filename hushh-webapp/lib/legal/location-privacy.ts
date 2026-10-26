import type { LegalSection } from "./legal-documents";

/** Location privacy copy shared by public and signed-in legal readers. */
export const LOCATION_PRIVACY_SECTION: LegalSection = {
  "id": "location",
  "title": "Location",
  "blocks": [
    {
      "kind": "h",
      "text": "Approximate location with a request"
    },
    {
      "kind": "p",
      "text": [
        "If your device already allows One to use your location, One includes an approximate position, rounded on your device to about one kilometre, with a chat request so it can answer questions like “what’s the weather here”. One does not show a permission prompt for this; if location is off, it may tell you how to turn it on. Our servers keep it in memory for a few minutes to finish that request, and it is not written to our database or to our logs as a location. The AI model receives the rounded position, and if One uses it to answer, that answer is saved in your encrypted chat history like any other reply."
      ]
    },
    {
      "kind": "h",
      "text": "Live location sharing"
    },
    {
      "kind": "p",
      "text": [
        "You can share your live location with people you choose, either for a set time of up to 24 hours or, with people you trust, until you stop. Each update is encrypted on your device to the recipient’s device key, so we cannot read it in storage. We can see who is sharing with whom and when. To show the recipient an address or travel time, their app sends the position they received to our servers, which look it up with Google Maps Platform without storing it. Updates from a share that has ended are removed by a scheduled cleanup, and all of them are deleted when you delete your account."
      ]
    },
    {
      "kind": "p",
      "text": [
        "If you join a circle, you are connected with its other members, and members can invite people they are connected to."
      ]
    },
    {
      "kind": "h",
      "text": "Background location sharing"
    },
    {
      "kind": "p",
      "text": [
        "In the iOS and Android apps, you can choose “Keep sharing in the background” when confirming a private live share or in Location Settings. Hussh One then collects location while you use another app or lock your screen, to update active shares and Save My Soul alerts for the people you choose. Before requesting background access, the app explains this use and asks you to continue. Updates are encrypted on your device for each recipient. Approximate sharing rounds the position on your device to about one kilometre; emergency shares remain precise. You can turn this option off, pause location updates, stop a share, or revoke access in your device settings. Android also provides a Stop sharing control in its ongoing notification. Reopening the app after it closes requires fresh background-sharing acceptance. Background sharing does not create a new recipient or public location link, and is not used for advertising."
      ]
    },
    {
      "kind": "h",
      "text": "Emergency alerts"
    },
    {
      "kind": "p",
      "text": [
        "If you send a Save My Soul alert, from the app or with Siri, One shares your live location with the emergency contacts you chose, who must be One users, for eight hours, and notifies them. It also emails them: your device sends your precise position to our servers, which send an email containing your coordinates, a map link, and any note you added. Our servers do not store or log that position, but the email stays in your contacts’ inboxes, and deleting your account cannot recall it."
      ]
    },
    {
      "kind": "h",
      "text": "Public location links"
    },
    {
      "kind": "p",
      "text": [
        "If you create a public location link, the position shown on that link is stored readable so anyone with the link can see it. A link lasts up to two hours, and its record is removed within about half a day after it expires or you stop it. People who open your link can leave you their name, phone number, and a message. We store the phone number as a hashed code with its last four digits and may use it to recognize a One account, along with a hashed code of their device and network to prevent abuse."
      ]
    },
    {
      "kind": "h",
      "text": "Nearby"
    },
    {
      "kind": "p",
      "text": [
        "Where available, you can check in at a place. Picking a place sends your position to Google Maps Platform. While you are checked in, other people checked in within about 500 metres can see your display name and the place, and can ask to connect with you. Check-ins are removed within about half a day after they end, and the encrypted record of the visit is deleted after seven days. A rating you give is stored with your account and the place and, once enough people have rated it, counts toward an anonymous public average that never shows who rated."
      ]
    }
  ]
};
