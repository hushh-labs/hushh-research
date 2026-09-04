package com.hussh.app.plugins.HushhContacts

import android.Manifest
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.ContactsContract
import android.provider.Settings
import android.telephony.TelephonyManager
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.util.Locale

/**
 * Read-only contact lookup for Connect matching.
 *
 * Contacts are returned to the web layer for in-memory hashing only. The web
 * layer sends hashes to the backend and does not persist raw contact records.
 *
 * The content-resolver scan runs off the main thread: a contact book of a few
 * thousand rows blocks long enough to trip an ANR if queried inline.
 */
@CapacitorPlugin(
    name = "HushhContacts",
    permissions = [
        Permission(
            alias = "contacts",
            strings = [Manifest.permission.READ_CONTACTS]
        )
    ]
)
class HushhContactsPlugin : Plugin() {

    private companion object {
        const val DEFAULT_LIMIT = 5000
        const val MAX_LIMIT = 10000
    }

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    override fun handleOnDestroy() {
        scope.cancel()
        super.handleOnDestroy()
    }

    @PluginMethod
    fun getPermissionState(call: PluginCall) {
        call.resolve(permissionPayload())
    }

    @PluginMethod
    fun requestPermission(call: PluginCall) {
        if (getPermissionState("contacts") == PermissionState.GRANTED) {
            call.resolve(permissionPayload())
            return
        }
        requestPermissionForAlias("contacts", call, "contactsPermissionStateCallback")
    }

    @PluginMethod
    fun openAppSettings(call: PluginCall) {
        try {
            val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                data = Uri.parse("package:${context.packageName}")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            call.resolve(JSObject().put("opened", true))
        } catch (error: Exception) {
            call.reject("Could not open app settings: ${error.message}")
        }
    }

    @PluginMethod
    fun readContacts(call: PluginCall) {
        if (getPermissionState("contacts") != PermissionState.GRANTED) {
            requestPermissionForAlias("contacts", call, "contactsPermissionCallback")
            return
        }
        resolveContacts(call)
    }

    @PermissionCallback
    private fun contactsPermissionStateCallback(call: PluginCall) {
        call.resolve(permissionPayload())
    }

    @PermissionCallback
    private fun contactsPermissionCallback(call: PluginCall) {
        if (getPermissionState("contacts") != PermissionState.GRANTED) {
            call.reject("Contacts permission was not granted.")
            return
        }
        resolveContacts(call)
    }

    private fun permissionPayload(): JSObject {
        // Capacitor tracks whether the OS will still prompt, which
        // checkSelfPermission cannot distinguish. Without that split the web
        // layer cannot tell "never asked" from "denied for good", and offers
        // a prompt that silently never appears.
        val state = when (getPermissionState("contacts")) {
            PermissionState.GRANTED -> "granted"
            PermissionState.DENIED -> "denied"
            else -> "prompt"
        }
        return JSObject()
            .put("state", state)
            .put("sourcePlatform", "android")
    }

    /** Home number-plan region for bare national numbers. */
    private fun deviceRegion(): String? {
        val telephony = runCatching {
            context.getSystemService(Context.TELEPHONY_SERVICE) as? TelephonyManager
        }.getOrNull()
        // Return only home number-plan evidence here. The shared web layer ranks an
        // Android `defaultRegion` above the signed-in account's verified phone,
        // so falling back to the UI locale here would silently reinterpret an
        // Indian national number as US (or vice versa) on Wi-Fi-only devices.
        // A serving-network country is also unsafe while roaming. When the SIM
        // provides no region, return null and let
        // the shared resolver use the verified account phone before locale.
        val candidates = listOf(runCatching { telephony?.simCountryIso }.getOrNull())
        return candidates
            .firstOrNull { !it.isNullOrBlank() && it.length == 2 }
            ?.uppercase(Locale.US)
    }

    private fun resolveContacts(call: PluginCall) {
        val limit = (call.getInt("limit", DEFAULT_LIMIT) ?: DEFAULT_LIMIT)
            .coerceIn(1, MAX_LIMIT)

        scope.launch {
            try {
                val payload = queryContacts(limit)
                call.resolve(payload)
            } catch (error: Exception) {
                call.reject("Contacts could not be read: ${error.message}")
            }
        }
    }

    private fun queryContacts(limit: Int): JSObject {
        val contactsById = LinkedHashMap<String, ContactAccumulator>()
        // The cursor yields one row per phone number, so a contact with three
        // numbers appears three times. Counting rows would inflate the total
        // for every contact past the limit; count distinct contacts instead.
        val seenContactIds = HashSet<String>()
        val projection = arrayOf(
            ContactsContract.CommonDataKinds.Phone.CONTACT_ID,
            ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
            ContactsContract.CommonDataKinds.Phone.NUMBER,
            ContactsContract.CommonDataKinds.Phone.NORMALIZED_NUMBER
        )

        context.contentResolver.query(
            ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
            projection,
            null,
            null,
            // Ordering by contact id uses the primary index; DISPLAY_NAME forces
            // a full sort and makes truncation alphabetical, which silently hid
            // everyone past the letter the cut landed on.
            ContactsContract.CommonDataKinds.Phone.CONTACT_ID + " ASC"
        )?.use { cursor ->
            val idIndex = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.CONTACT_ID)
            val nameIndex = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME)
            val phoneIndex = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.NUMBER)
            val normalizedIndex =
                cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.NORMALIZED_NUMBER)

            while (cursor.moveToNext()) {
                val id = cursor.getString(idIndex) ?: continue
                val number = cursor.getString(phoneIndex)?.trim().orEmpty()
                val normalized = if (normalizedIndex >= 0) {
                    cursor.getString(normalizedIndex)?.trim().orEmpty()
                } else {
                    ""
                }
                if (number.isEmpty() && normalized.isEmpty()) continue

                seenContactIds.add(id)
                if (!contactsById.containsKey(id) && contactsById.size >= limit) {
                    continue
                }

                val name = cursor.getString(nameIndex)?.trim().orEmpty()
                val entry = contactsById.getOrPut(id) { ContactAccumulator(id, name) }
                // Android keeps its own E.164 rendering of each number when it
                // can derive one. It is strictly better than re-deriving from
                // the display string, so it goes first.
                if (normalized.isNotEmpty() && !entry.phoneNumbers.contains(normalized)) {
                    entry.phoneNumbers.add(0, normalized)
                }
                if (number.isNotEmpty() && !entry.phoneNumbers.contains(number)) {
                    entry.phoneNumbers.add(number)
                }
            }
        }

        val contacts = JSArray()
        contactsById.values.forEach { entry ->
            val phoneNumbers = JSArray()
            entry.phoneNumbers.forEach { phoneNumbers.put(it) }
            contacts.put(
                JSObject()
                    .put("id", entry.id)
                    .put("displayName", entry.displayName)
                    .put("phoneNumbers", phoneNumbers)
            )
        }

        return JSObject()
            .put("contacts", contacts)
            .put("sourcePlatform", "android")
            .put("defaultRegion", deviceRegion())
            // Android has no partial-contact mode; access is all or nothing.
            .put("limited", false)
            .put("truncated", seenContactIds.size > contactsById.size)
            .put("totalAvailable", seenContactIds.size)
    }

    private data class ContactAccumulator(
        val id: String,
        val displayName: String,
        val phoneNumbers: MutableList<String> = mutableListOf()
    )
}
