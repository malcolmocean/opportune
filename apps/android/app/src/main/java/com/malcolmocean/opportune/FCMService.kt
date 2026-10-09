package com.malcolmocean.opportune

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Receives data messages { nudgeId, text, actions: JSON [{key,label}] } from channels/fcm and shows a
 * heads-up notification with up to three action buttons. The nudge is also kept locally for the main screen.
 */
class FCMService : FirebaseMessagingService() {

    companion object {
        private const val TAG = "FCMService"
        const val NUDGE_CHANNEL_ID = "nudges"
        const val ACTION_NUDGES_CHANGED = "com.malcolmocean.opportune.NUDGES_CHANGED"
        private const val MAX_BUTTONS = 3

        fun ensureChannel(context: Context) {
            val ch = NotificationChannel(NUDGE_CHANNEL_ID, context.getString(R.string.nudge_channel_name), NotificationManager.IMPORTANCE_HIGH).apply {
                description = context.getString(R.string.nudge_channel_description)
                enableVibration(true)
                enableLights(true)
            }
            context.getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
        }

        fun notificationId(nudgeId: String) = 1000 + (nudgeId.hashCode() and 0x7fffffff) % 100000

        fun show(context: Context, nudge: Prefs.Nudge) {
            ensureChannel(context)
            val nid = notificationId(nudge.id)
            val open = PendingIntent.getActivity(
                context, nid,
                Intent(context, MainActivity::class.java).apply { flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP; putExtra("nudgeId", nudge.id) },
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            val b = NotificationCompat.Builder(context, NUDGE_CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(context.getString(R.string.app_name))
                .setContentText(nudge.text)
                .setStyle(NotificationCompat.BigTextStyle().bigText(nudge.text))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_RECOMMENDATION)
                .setAutoCancel(true)
                .setContentIntent(open)
            nudge.actions.take(MAX_BUTTONS).forEachIndexed { i, (key, label) ->
                b.addAction(0, label, NotificationActionReceiver.intent(context, nudge.id, key, nid, requestCode = nid * 10 + i))
            }
            context.getSystemService(NotificationManager::class.java).notify(nudge.id, nid, b.build())
        }
    }

    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    override fun onMessageReceived(msg: RemoteMessage) {
        val d = msg.data
        val nudgeId = d["nudgeId"] ?: run { Log.w(TAG, "message without nudgeId: $d"); return }
        val text = d["text"] ?: msg.notification?.body ?: return
        val nudge = Prefs.Nudge(id = nudgeId, text = text, actions = Prefs.Nudge.parseActions(d["actions"]), at = System.currentTimeMillis(), response = null)
        Prefs.addNudge(this, nudge)
        show(this, nudge)
        sendBroadcast(Intent(ACTION_NUDGES_CHANGED).setPackage(packageName))
        Log.d(TAG, "nudge $nudgeId shown with ${nudge.actions.size} action(s)")
    }

    override fun onNewToken(token: String) {
        Log.d(TAG, "new FCM token")
        scope.launch { ApiClient.registerToken(this@FCMService, token) }
    }

    override fun onDestroy() { scope.cancel(); super.onDestroy() }
}
