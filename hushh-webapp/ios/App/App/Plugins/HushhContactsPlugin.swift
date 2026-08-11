import Foundation
import Capacitor
import Contacts
import UIKit

/**
 * HushhContactsPlugin - read-only contact lookup for Connect matching.
 *
 * Contacts are returned to the web layer for in-memory hashing only. The web
 * layer sends hashes to the backend and does not persist raw contact records.
 *
 * Enumeration always runs on a background queue. CNContactStore walks the
 * store synchronously, so a few thousand contacts freeze the UI if that work
 * lands on the main thread.
 */
@objc(HushhContactsPlugin)
public class HushhContactsPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "HushhContactsPlugin"
    public let jsName = "HushhContacts"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getPermissionState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openAppSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readContacts", returnType: CAPPluginReturnPromise)
    ]

    private let store = CNContactStore()
    private let readQueue = DispatchQueue(
        label: "ai.hushh.contacts.read",
        qos: .userInitiated
    )

    private static let defaultLimit = 5000
    private static let maxLimit = 10000

    @objc func getPermissionState(_ call: CAPPluginCall) {
        call.resolve(["state": permissionState()])
    }

    @objc func requestPermission(_ call: CAPPluginCall) {
        let status = CNContactStore.authorizationStatus(for: .contacts)
        guard status == .notDetermined else {
            call.resolve(["state": permissionState()])
            return
        }
        store.requestAccess(for: .contacts) { [weak self] _, _ in
            call.resolve(["state": self?.permissionState() ?? "unavailable"])
        }
    }

    @objc func openAppSettings(_ call: CAPPluginCall) {
        guard let url = URL(string: UIApplication.openSettingsURLString) else {
            call.resolve(["opened": false])
            return
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { opened in
                call.resolve(["opened": opened])
            }
        }
    }

    @objc func readContacts(_ call: CAPPluginCall) {
        let limit = max(1, min(call.getInt("limit") ?? Self.defaultLimit, Self.maxLimit))
        let status = CNContactStore.authorizationStatus(for: .contacts)

        if status == .notDetermined {
            store.requestAccess(for: .contacts) { [weak self] granted, error in
                guard let self else { return }
                if let error = error {
                    call.reject("Contacts permission failed: \(error.localizedDescription)")
                    return
                }
                guard granted else {
                    call.reject("Contacts permission was not granted.")
                    return
                }
                // Stay off the main thread: this is the enumeration path.
                self.readQueue.async { self.resolveContacts(call, limit: limit) }
            }
            return
        }

        guard isReadableStatus(status) else {
            call.reject("Contacts permission was not granted.")
            return
        }
        readQueue.async { [weak self] in
            self?.resolveContacts(call, limit: limit)
        }
    }

    /// iOS 18 added partial access, where the read succeeds but only returns a
    /// user-picked subset. It is readable, but callers must not treat an empty
    /// result as "nobody matched".
    private func isLimitedStatus(_ status: CNAuthorizationStatus) -> Bool {
        if #available(iOS 18.0, *) {
            return status == .limited
        }
        return false
    }

    private func isReadableStatus(_ status: CNAuthorizationStatus) -> Bool {
        return status == .authorized || isLimitedStatus(status)
    }

    private func permissionState() -> String {
        let status = CNContactStore.authorizationStatus(for: .contacts)
        if isLimitedStatus(status) {
            return "limited"
        }
        switch status {
        case .authorized:
            return "granted"
        case .notDetermined:
            return "prompt"
        case .denied:
            return "denied"
        case .restricted:
            return "restricted"
        @unknown default:
            return "unavailable"
        }
    }

    /// Region used to read bare national numbers such as `9876543210`.
    private func deviceRegion() -> String? {
        let region: String?
        if #available(iOS 16.0, *) {
            region = Locale.current.region?.identifier
        } else {
            region = Locale.current.regionCode
        }
        guard let region, region.count == 2 else { return nil }
        return region.uppercased()
    }

    private func resolveContacts(_ call: CAPPluginCall, limit: Int) {
        let keys: [CNKeyDescriptor] = [
            CNContactIdentifierKey as CNKeyDescriptor,
            CNContactGivenNameKey as CNKeyDescriptor,
            CNContactFamilyNameKey as CNKeyDescriptor,
            CNContactOrganizationNameKey as CNKeyDescriptor,
            CNContactPhoneNumbersKey as CNKeyDescriptor
        ]
        let request = CNContactFetchRequest(keysToFetch: keys)
        // Unified contacts already merge linked cards; sorting is pure overhead
        // for a hash-matching pass.
        request.unifyResults = true
        request.sortOrder = .none

        var contacts: [[String: Any]] = []
        var totalAvailable = 0

        do {
            try store.enumerateContacts(with: request) { contact, _ in
                let phoneNumbers = contact.phoneNumbers
                    .map { $0.value.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) }
                    .filter { !$0.isEmpty }
                if phoneNumbers.isEmpty {
                    return
                }
                totalAvailable += 1
                // Keep walking past the limit so `totalAvailable` stays honest
                // and the web layer can tell the user their book was cut short.
                guard contacts.count < limit else { return }

                let nameParts = [
                    contact.givenName.trimmingCharacters(in: .whitespacesAndNewlines),
                    contact.familyName.trimmingCharacters(in: .whitespacesAndNewlines)
                ].filter { !$0.isEmpty }
                let displayName = nameParts.joined(separator: " ")
                contacts.append([
                    "id": contact.identifier,
                    "displayName": displayName.isEmpty ? contact.organizationName : displayName,
                    "phoneNumbers": phoneNumbers
                ])
            }

            var payload: [String: Any] = [
                "contacts": contacts,
                "sourcePlatform": "ios",
                "limited": isLimitedStatus(CNContactStore.authorizationStatus(for: .contacts)),
                "truncated": totalAvailable > contacts.count,
                "totalAvailable": totalAvailable
            ]
            if let region = deviceRegion() {
                payload["defaultRegion"] = region
            }
            call.resolve(payload)
        } catch {
            call.reject("Contacts could not be read: \(error.localizedDescription)")
        }
    }
}
