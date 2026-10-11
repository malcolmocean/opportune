package com.malcolmocean.opportune

import android.app.NotificationManager
import android.content.Context
import android.util.Log
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging

/**
 * The one way out. The web app calls opportuneNative.signOut() (docs/APP-BRIDGE.md) and LocationService
 * calls this itself when the node answers 401/404 (token revoked, source removed). Afterwards nothing
 * identifies the person and nothing runs: no ingest URL, no location service, no activity-recognition
 * registration, no queued points, no FCM token the node could still push to, no stale notifications.
 * The web app clears its own localStorage; the shell doesn't touch WebView storage.
 */
object Session {
    private const val TAG = "Session"

    fun signOut(context: Context, reason: String) {
        Log.i(TAG, "signing out: $reason")
        // Storage first, so a flush already in flight in the service finds no URL and drops its batch.
        Prefs.clearSession(context)
        // Foreground service: onDestroy removes location + activity updates and cancels the queue's scope.
        LocationService.stop(context)
        // Nudge notifications would otherwise keep buttons that POST to nothing.
        context.getSystemService(NotificationManager::class.java)?.cancelAll()
        // Invalidate the push token so a node that still has it on file can't reach this phone. A fresh
        // one is minted (and registered) on the next sign-in; KEY_FCM_REGISTERED is gone, so it will post.
        if (FirebaseApp.getApps(context).isNotEmpty()) {
            try { FirebaseMessaging.getInstance().deleteToken() } catch (e: Exception) { Log.w(TAG, "deleteToken: ${e.message}") }
        }
    }
}
