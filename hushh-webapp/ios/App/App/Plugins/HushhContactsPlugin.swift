import Foundation
import Capacitor
import Contacts

/**
 * HushhContactsPlugin - read-only contact lookup for Connect matching.
 *
 * Contacts are returned to the web layer for in-memory hashing only. The web
 * layer sends hashes to the backend and does not persist raw contact records.
 */
@objc(HushhContactsPlugin)
public class HushhContactsPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "HushhContactsPlugin"
    public let jsName = "HushhContacts"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getPermissionState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readContacts", returnType: CAPPluginReturnPromise)
    ]

    private let store = CNContactStore()

    @objc func getPermissionState(_ call: CAPPluginCall) {
        call.resolve(["state": permissionState()])
    }

    @objc func readContacts(_ call: CAPPluginCall) {
        let limit = max(1, min(call.getInt("limit") ?? 500, 1000))
        let status = CNContactStore.authorizationStatus(for: .contacts)

        switch status {
        case .authorized, .limited:
            resolveContacts(call, limit: limit)
        case .notDetermined:
            store.requestAccess(for: .contacts) { [weak self] granted, error in
                DispatchQueue.main.async {
                    if let error = error {
                        call.reject("Contacts permission failed: \(error.localizedDescription)")
                        return
                    }
                    guard granted else {
                        call.reject("Contacts permission was not granted.")
                        return
                    }
                    self?.resolveContacts(call, limit: limit)
                }
            }
        case .denied, .restricted:
            call.reject("Contacts permission was not granted.")
        @unknown default:
            call.reject("Contacts permission state is unavailable.")
        }
    }

    private func permissionState() -> String {
        switch CNContactStore.authorizationStatus(for: .contacts) {
        case .authorized, .limited:
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

    private func resolveContacts(_ call: CAPPluginCall, limit: Int) {
        let keys: [CNKeyDescriptor] = [
            CNContactIdentifierKey as CNKeyDescriptor,
            CNContactGivenNameKey as CNKeyDescriptor,
            CNContactFamilyNameKey as CNKeyDescriptor,
            CNContactOrganizationNameKey as CNKeyDescriptor,
            CNContactPhoneNumbersKey as CNKeyDescriptor
        ]
        let request = CNContactFetchRequest(keysToFetch: keys)
        var contacts: [[String: Any]] = []

        do {
            try store.enumerateContacts(with: request) { contact, stop in
                let phoneNumbers = contact.phoneNumbers
                    .map { $0.value.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) }
                    .filter { !$0.isEmpty }
                if phoneNumbers.isEmpty {
                    return
                }

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
                if contacts.count >= limit {
                    stop.pointee = true
                }
            }
            call.resolve([
                "contacts": contacts,
                "sourcePlatform": "ios"
            ])
        } catch {
            call.reject("Contacts could not be read: \(error.localizedDescription)")
        }
    }
}
