package com.malcolmocean.opportune

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.provider.ContactsContract
import android.util.Log
import androidx.core.content.ContextCompat
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

/**
 * Opt-in: read names + emails + phones and POST { contacts: [...] } in batches of 200.
 * Runs when the web app's requestContacts() is granted and at most once a day after that (from the heartbeat or app open).
 */
object ContactsSync {
    private const val TAG = "ContactsSync"
    private const val BATCH = 200
    private const val DAY_MS = 24 * 3600 * 1000L

    fun hasPermission(c: Context) = ContextCompat.checkSelfPermission(c, Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED

    fun isDue(c: Context) = Prefs.shareContacts(c) && hasPermission(c) && System.currentTimeMillis() - Prefs.contactsSyncedAt(c) > DAY_MS

    suspend fun maybeSync(c: Context): Int? = if (isDue(c)) sync(c) else null

    /** Returns the number of contacts sent, or -1 if a batch failed. */
    suspend fun sync(c: Context): Int = withContext(Dispatchers.IO) {
        if (!hasPermission(c) || !Prefs.isConfigured(c)) return@withContext -1
        val contacts = read(c)
        var sent = 0
        for (chunk in contacts.chunked(BATCH)) {
            val arr = JSONArray(); chunk.forEach { arr.put(it) }
            if (!ApiClient.postContacts(c, arr)) { Log.w(TAG, "batch failed after $sent"); return@withContext -1 }
            sent += chunk.size
        }
        Prefs.markContactsSynced(c, sent)
        Log.d(TAG, "synced $sent contact(s)")
        sent
    }

    private class Entry(val name: String?) { val emails = LinkedHashSet<String>(); val phones = LinkedHashSet<String>() }

    private fun read(c: Context): List<JSONObject> {
        val byId = LinkedHashMap<Long, Entry>()
        val cr = c.contentResolver
        cr.query(ContactsContract.CommonDataKinds.Email.CONTENT_URI,
            arrayOf(ContactsContract.CommonDataKinds.Email.CONTACT_ID, ContactsContract.CommonDataKinds.Email.DISPLAY_NAME_PRIMARY, ContactsContract.CommonDataKinds.Email.ADDRESS),
            null, null, null)?.use { cur ->
            while (cur.moveToNext()) {
                val id = cur.getLong(0); val addr = cur.getString(2)?.trim()
                if (addr.isNullOrBlank()) continue
                byId.getOrPut(id) { Entry(cur.getString(1)) }.emails.add(addr)
            }
        }
        cr.query(ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
            arrayOf(ContactsContract.CommonDataKinds.Phone.CONTACT_ID, ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME_PRIMARY, ContactsContract.CommonDataKinds.Phone.NUMBER),
            null, null, null)?.use { cur ->
            while (cur.moveToNext()) {
                val id = cur.getLong(0); val num = cur.getString(2)?.trim()
                if (num.isNullOrBlank()) continue
                byId.getOrPut(id) { Entry(cur.getString(1)) }.phones.add(num)
            }
        }
        return byId.values.map { e ->
            JSONObject().apply {
                put("name", e.name ?: JSONObject.NULL)
                put("emails", JSONArray().apply { e.emails.forEach { put(it) } })
                put("phones", JSONArray().apply { e.phones.forEach { put(it) } })
            }
        }
    }
}
