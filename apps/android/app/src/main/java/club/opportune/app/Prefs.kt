package club.opportune.app

import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject

/**
 * Everything the shell remembers, in one SharedPreferences file. The ingest URL is the whole config:
 * it names the node and carries the per-person source token, so it doubles as auth for every POST.
 * The node URL (where the web app is loaded from) defaults to opportune.club, is derived from the
 * ingest URL once there is one, and can be overridden from the offline fallback screen.
 */
object Prefs {
    const val DEFAULT_NODE_URL = "https://opportune.club"

    private const val FILE = "opportune"
    private const val KEY_URL = "ingestUrl"
    private const val KEY_NODE_URL = "nodeUrl"
    private const val KEY_CONTACTS = "shareContacts"
    private const val KEY_CONTACTS_SYNC = "contactsSyncedAt"
    private const val KEY_CONTACTS_COUNT = "contactsCount"
    private const val KEY_NUDGES = "nudges"
    private const val KEY_LAST_POST = "lastPostAt"
    private const val KEY_LAST_POST_OK = "lastPostOk"
    private const val KEY_FCM_REGISTERED = "fcmRegisteredToken"
    private const val KEY_PORCHLIGHT = "porchlight"
    private const val MAX_NUDGES = 50

    private fun sp(c: Context): SharedPreferences = c.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun ingestUrl(c: Context): String? = sp(c).getString(KEY_URL, null)?.takeIf { it.isNotBlank() }
    fun setIngestUrl(c: Context, url: String?) {
        sp(c).edit().putString(KEY_URL, url?.trim()).remove(KEY_FCM_REGISTERED).apply()
    }
    fun isConfigured(c: Context) = parseIngestUrl(ingestUrl(c)) != null
    fun token(c: Context): String? = parseIngestUrl(ingestUrl(c))?.token

    /**
     * Forget everything that ties this install to a person: the ingest URL (the credential), the FCM
     * registration memory, the contacts switch and its sync markers, the post markers and the cached
     * nudges and the widget's porchlight. The node override survives, it's config, not identity. Use Session.signOut, which also
     * stops the services; this only wipes storage.
     */
    fun clearSession(c: Context) {
        sp(c).edit()
            .remove(KEY_URL).remove(KEY_FCM_REGISTERED)
            .remove(KEY_CONTACTS).remove(KEY_CONTACTS_SYNC).remove(KEY_CONTACTS_COUNT)
            .remove(KEY_LAST_POST).remove(KEY_LAST_POST_OK)
            .remove(KEY_NUDGES).remove(KEY_PORCHLIGHT)
            .apply()
    }

    /** Explicit override (fallback screen) > base of the ingest URL > DEFAULT_NODE_URL. No trailing slash. */
    fun nodeUrl(c: Context): String {
        val override = sp(c).getString(KEY_NODE_URL, null)?.takeIf { it.isNotBlank() }
        return normalizeNodeUrl(override) ?: parseIngestUrl(ingestUrl(c))?.baseUrl ?: DEFAULT_NODE_URL
    }
    fun setNodeUrl(c: Context, url: String?) {
        val n = normalizeNodeUrl(url)
        sp(c).edit().apply { if (n == null) remove(KEY_NODE_URL) else putString(KEY_NODE_URL, n) }.apply()
    }

    /** "opportune.club", "https://opportune.club/", "http://192.168.1.10:3400" → scheme://host[:port]; junk → null. */
    fun normalizeNodeUrl(raw: String?): String? {
        var s = raw?.trim() ?: return null
        if (s.isBlank()) return null
        if (!s.contains("://")) s = "https://$s"
        val u = Uri.parse(s)
        if (u.scheme != "http" && u.scheme != "https" || u.host.isNullOrBlank()) return null
        val port = if (u.port > 0) ":${u.port}" else ""
        return "${u.scheme}://${u.host}$port"
    }

    data class Node(val baseUrl: String, val sourceId: String, val token: String)

    /** http(s)://node[:port]/ingest/<sourceId>/<token> → Node; anything else → null. */
    fun parseIngestUrl(url: String?): Node? {
        if (url.isNullOrBlank()) return null
        val u = Uri.parse(url.trim())
        if (u.scheme != "http" && u.scheme != "https" || u.host.isNullOrBlank()) return null
        val segs = u.pathSegments
        if (segs.size != 3 || segs[0] != "ingest" || segs[2].isBlank()) return null
        val port = if (u.port > 0) ":${u.port}" else ""
        return Node("${u.scheme}://${u.host}$port", segs[1], segs[2])
    }

    fun shareContacts(c: Context) = sp(c).getBoolean(KEY_CONTACTS, false)
    fun setShareContacts(c: Context, on: Boolean) = sp(c).edit().putBoolean(KEY_CONTACTS, on).apply()
    fun contactsSyncedAt(c: Context) = sp(c).getLong(KEY_CONTACTS_SYNC, 0L)
    fun contactsCount(c: Context) = sp(c).getInt(KEY_CONTACTS_COUNT, 0)
    fun markContactsSynced(c: Context, count: Int) =
        sp(c).edit().putLong(KEY_CONTACTS_SYNC, System.currentTimeMillis()).putInt(KEY_CONTACTS_COUNT, count).apply()

    fun markPost(c: Context, ok: Boolean) =
        sp(c).edit().putLong(KEY_LAST_POST, System.currentTimeMillis()).putBoolean(KEY_LAST_POST_OK, ok).apply()
    fun lastPost(c: Context): Pair<Long, Boolean> = sp(c).getLong(KEY_LAST_POST, 0L) to sp(c).getBoolean(KEY_LAST_POST_OK, false)

    /** The last me.porchlight from /api/app/state, so the widget can redraw without waiting on the network. */
    fun porchlight(c: Context): JSONObject? = sp(c).getString(KEY_PORCHLIGHT, null)?.let { try { JSONObject(it) } catch (e: Exception) { null } }
    fun setPorchlight(c: Context, pl: JSONObject?) = sp(c).edit().putString(KEY_PORCHLIGHT, pl?.toString()).apply()

    fun fcmRegisteredToken(c: Context): String? = sp(c).getString(KEY_FCM_REGISTERED, null)
    fun setFcmRegisteredToken(c: Context, t: String?) = sp(c).edit().putString(KEY_FCM_REGISTERED, t).apply()

    // ---- recent nudges, newest first, kept locally from FCM payloads (for notification bookkeeping) ----
    data class Nudge(val id: String, val text: String, val actions: List<Pair<String, String>>, val at: Long, val response: String?) {
        fun toJson(): JSONObject = JSONObject().apply {
            put("id", id); put("text", text); put("at", at); put("response", response ?: JSONObject.NULL)
            put("actions", actionsJson())
        }
        fun actionsJson(): JSONArray = JSONArray().apply { actions.forEach { (k, l) -> put(JSONObject().put("key", k).put("label", l)) } }
        companion object {
            fun fromJson(o: JSONObject): Nudge {
                val acts = o.optJSONArray("actions") ?: JSONArray()
                return Nudge(
                    id = o.getString("id"), text = o.optString("text"), at = o.optLong("at"),
                    response = if (o.isNull("response")) null else o.optString("response"),
                    actions = (0 until acts.length()).map { acts.getJSONObject(it) }.map { it.optString("key") to it.optString("label") },
                )
            }
            fun parseActions(json: String?): List<Pair<String, String>> {
                if (json.isNullOrBlank()) return emptyList()
                return try {
                    val arr = JSONArray(json)
                    (0 until arr.length()).map { arr.getJSONObject(it) }
                        .map { it.optString("key") to it.optString("label", it.optString("key")) }
                        .filter { it.first.isNotBlank() }
                } catch (e: Exception) { emptyList() }
            }
        }
    }

    fun nudges(c: Context): List<Nudge> {
        val raw = sp(c).getString(KEY_NUDGES, null) ?: return emptyList()
        return try {
            val arr = JSONArray(raw)
            (0 until arr.length()).map { Nudge.fromJson(arr.getJSONObject(it)) }
        } catch (e: Exception) { emptyList() }
    }
    private fun saveNudges(c: Context, list: List<Nudge>) {
        val arr = JSONArray(); list.take(MAX_NUDGES).forEach { arr.put(it.toJson()) }
        sp(c).edit().putString(KEY_NUDGES, arr.toString()).apply()
    }
    fun addNudge(c: Context, n: Nudge) = saveNudges(c, listOf(n) + nudges(c).filter { it.id != n.id })
    fun markResponded(c: Context, id: String, key: String) =
        saveNudges(c, nudges(c).map { if (it.id == id) it.copy(response = key) else it })
}
