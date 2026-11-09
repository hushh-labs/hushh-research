import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Capawesome 8.2.0 binds these iOS methods to the default app. Pin both
// sides of the edit so a dependency update cannot silently restore that.
const sharedApp = 'FirebaseApp.app(name: "hushh-shared-identity")';
const patches = [
  {
    file: "authentication/ios/Plugin/FirebaseAuthentication.swift",
    original: "0f604ab25d42523fb65e36b837b4f163b4e3fa8e68c2b9fa24f820f5c1b8ed7b",
    patched: "933c657f5ea3cf0ed85dc76c1e39cfe5b237f615b76ae6d7765b050915ab9ab0",
    replacements: [
      ["Auth.auth()", "hushhFirebaseAuth()"],
      ["public typealias AuthStateChangedObserver", `func hushhFirebaseAuth() -> Auth {
    ${sharedApp}.map { Auth.auth(app: $0) } ?? Auth.auth()
}

public typealias AuthStateChangedObserver`],
    ],
  },
  {
    file: "authentication/ios/Plugin/Handlers/PhoneAuthProviderHandler.swift",
    original: "5c0fd0cdda81a917e2ffc494921527b7cc65defc278610152087496c92bb4bfe",
    patched: "33e011b37f4c18f38e83ab704b38a36eec88018db655097e7ff9edf136b41e0c",
    replacements: [["PhoneAuthProvider.provider()", "PhoneAuthProvider.provider(auth: hushhFirebaseAuth())"]],
  },
  {
    file: "authentication/ios/Plugin/Handlers/OAuthProviderHandler.swift",
    original: "2411dbf3ba3de1a202368e465b0142b9b7c5d54b0abc99232ac5b176c8a23215",
    patched: "8e0e4438809128718b223d321a7adffcb6438ebf49da9336b48771b4178b7e28",
    replacements: [["OAuthProvider(providerID: providerId)", "OAuthProvider(providerID: providerId, auth: hushhFirebaseAuth())"]],
  },
  {
    file: "authentication/ios/Plugin/Handlers/GoogleAuthProviderHandler.swift",
    original: "cf6ccc2a55590e107ea187ca14896edaf41678cfe56377841a82ac6613ca7936",
    patched: "41d36ecba01843120467f5b86975ddcb9df96d26926fdaba1afdc3d7dd15cea6",
    replacements: [["FirebaseApp.app()?.options.clientID", `(${sharedApp} ?? FirebaseApp.app())?.options.clientID`]],
  },
  {
    file: "messaging/ios/Plugin/FirebaseMessaging.swift",
    original: "0430ff9d550aa83c2e86f2b0142c125b02d66c4294abf52717b22ee5df0fe3b8",
    patched: "5d5c22b8a2ca1b34e6487e39aff272720d86cd9823c2f3135c7758ac1e032113",
    replacements: [
      ["        Messaging.messaging().isAutoInitEnabled = true", `        if let shared = ${sharedApp} {
            let messaging = Messaging.messaging()
            guard messaging.apnsToken != nil else {
                completion(nil, NSError(domain: "HushhSharedPush", code: 1))
                return
            }
            messaging.retrieveFCMToken(forSenderID: shared.options.gcmSenderID, completion: completion)
            return
        }
        Messaging.messaging().isAutoInitEnabled = true`],
      ["        Messaging.messaging().deleteToken(completion:", `        if let shared = ${sharedApp} {
            Messaging.messaging().deleteFCMToken(forSenderID: shared.options.gcmSenderID, completion: completion)
            return
        }
        Messaging.messaging().deleteToken(completion:`],
      ["        self.plugin.handleTokenReceived(token: fcmToken)", `        // The delegate reports the default token. The app refreshes its
        // explicitly requested shared-sender token on startup and resume.
        guard ${sharedApp} == nil else { return }
        self.plugin.handleTokenReceived(token: fcmToken)`],
    ],
  },
];

const digest = (source) => createHash("sha256").update(source).digest("hex");

export function bindIosFirebaseBridges(appRoot) {
  const packageRoot = path.join(fs.realpathSync(appRoot), "node_modules", "@capacitor-firebase");
  const changes = patches.flatMap(({ file, original, patched, replacements }) => {
    const target = path.join(packageRoot, file);
    if (path.relative(target, fs.realpathSync(target))) {
      throw new Error("UAT iOS Firebase bridge requires a worktree-local dependency install.");
    }
    const source = fs.readFileSync(target, "utf8");
    const before = digest(source);
    if (before === patched) return [];
    if (before !== original) throw new Error(`Unexpected iOS Firebase bridge source: ${file}`);
    const updated = replacements.reduce((value, [from, to]) => value.replaceAll(from, to), source);
    if (digest(updated) !== patched) throw new Error(`iOS Firebase bridge binding changed: ${file}`);
    return [{ target, updated }];
  });
  for (const { target, updated } of changes) fs.writeFileSync(target, updated);
}
