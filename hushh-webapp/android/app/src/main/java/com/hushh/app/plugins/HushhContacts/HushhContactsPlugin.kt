package com.hushh.app.plugins.HushhContacts

import android.Manifest
import android.content.pm.PackageManager
import android.provider.ContactsContract
import androidx.core.content.ContextCompat
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

/**
 * Read-only contact lookup for Connect matching.
 *
 * Contacts are returned to the web layer for in-memory hashing only. The web
 * layer sends hashes to the backend and does not persist raw contact records.
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

    @PluginMethod
    fun getPermissionState(call: PluginCall) {
        call.resolve(permissionPayload())
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
    private fun contactsPermissionCallback(call: PluginCall) {
        if (getPermissionState("contacts") != PermissionState.GRANTED) {
            call.reject("Contacts permission was not granted.")
            return
        }
        resolveContacts(call)
    }

    private fun permissionPayload(): JSObject {
        val state = when {
            ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CONTACTS) ==
                PackageManager.PERMISSION_GRANTED -> "granted"
            else -> "prompt"
        }
        return JSObject().put("state", state)
    }

    private fun resolveContacts(call: PluginCall) {
        val limit = (call.getInt("limit", 500) ?: 500).coerceIn(1, 1000)
        val contactsById = LinkedHashMap<String, ContactAccumulator>()
        val projection = arrayOf(
            ContactsContract.CommonDataKinds.Phone.CONTACT_ID,
            ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
            ContactsContract.CommonDataKinds.Phone.NUMBER
        )

        try {
            context.contentResolver.query(
                ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                projection,
                null,
                null,
                ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " ASC"
            )?.use { cursor ->
                val idIndex = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.CONTACT_ID)
                val nameIndex = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME)
                val phoneIndex = cursor.getColumnIndex(ContactsContract.CommonDataKinds.Phone.NUMBER)
                while (cursor.moveToNext() && contactsById.size < limit) {
                    val id = cursor.getString(idIndex) ?: continue
                    val number = cursor.getString(phoneIndex)?.trim().orEmpty()
                    if (number.isEmpty()) continue
                    val name = cursor.getString(nameIndex)?.trim().orEmpty()
                    val entry = contactsById.getOrPut(id) { ContactAccumulator(id, name) }
                    if (!entry.phoneNumbers.contains(number)) {
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
            call.resolve(
                JSObject()
                    .put("contacts", contacts)
                    .put("sourcePlatform", "android")
            )
        } catch (error: Exception) {
            call.reject("Contacts could not be read: ${error.message}")
        }
    }

    private data class ContactAccumulator(
        val id: String,
        val displayName: String,
        val phoneNumbers: MutableList<String> = mutableListOf()
    )
}
