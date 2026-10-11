package club.opportune.app

import android.content.Context
import android.os.Build
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * Every request is a JSON POST to the one ingest URL. The server-side source (sources/opportuneApp)
 * dispatches on shape: a location array, { fcmToken }, { nudgeResponse }, { contacts }. (Porchlight/status
 * is set by the web app itself, not by the shell.)
 */
object ApiClient {
    private const val TAG = "ApiClient"
    private const val TIMEOUT_MS = 15_000

    /** Returns the HTTP status, or -1 if the request could not be made (no URL, no network). */
    fun post(context: Context, body: String): Int {
        val url = Prefs.ingestUrl(context) ?: run { Log.w(TAG, "No ingest URL configured"); return -1 }
        return postTo(url, body).also { Prefs.markPost(context, it in 200..299) }
    }

    fun postTo(url: String, body: String): Int {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = TIMEOUT_MS
                readTimeout = TIMEOUT_MS
                doOutput = true
                setRequestProperty("Content-Type", "application/json; charset=utf-8")
                setRequestProperty("User-Agent", "opportune-android/${BuildConfig.VERSION_NAME}")
            }
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val code = conn.responseCode
            if (code !in 200..299) {
                val err = try { conn.errorStream?.bufferedReader()?.readText() } catch (e: Exception) { null }
                Log.w(TAG, "POST $code: ${err?.take(200)}")
            }
            code
        } catch (e: IOException) {
            Log.w(TAG, "POST failed: ${e.message}")
            -1
        } finally { conn?.disconnect() }
    }

    /** GET the ingest URL: the server answers { ok: true } for a valid token, 401 otherwise. */
    fun probe(url: String): Int {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(url).openConnection() as HttpURLConnection).apply { connectTimeout = TIMEOUT_MS; readTimeout = TIMEOUT_MS }
            conn.responseCode
        } catch (e: IOException) { -1 } finally { conn?.disconnect() }
    }

    fun deviceJson(): JSONObject = JSONObject()
        .put("model", Build.MODEL).put("manufacturer", Build.MANUFACTURER)
        .put("android", Build.VERSION.SDK_INT).put("app", BuildConfig.VERSION_NAME)

    fun postLocations(context: Context, points: JSONArray): Int = post(context, points.toString())

    fun registerToken(context: Context, token: String): Boolean {
        val ok = post(context, JSONObject().put("fcmToken", token).put("device", deviceJson()).toString()) in 200..299
        if (ok) Prefs.setFcmRegisteredToken(context, token)
        return ok
    }

    fun respond(context: Context, nudgeId: String, key: String): Boolean =
        post(context, JSONObject().put("nudgeResponse", JSONObject().put("nudgeId", nudgeId).put("key", key)).toString()) in 200..299

    fun postContacts(context: Context, contacts: JSONArray): Boolean =
        post(context, JSONObject().put("contacts", contacts).toString()) in 200..299
}
