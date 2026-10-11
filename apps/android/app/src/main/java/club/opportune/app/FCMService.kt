package club.opportune.app

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
 * heads-up notification with up to three action buttons. Tapping the body opens the shell at #nudges;
 * the buttons POST { nudgeResponse } natively (NotificationActionReceiver). If the shell is in the
 * foreground it also gets the nudge via ACTION_NUDGE_RECEIVED → window.onNativeNudge.
 */
class FCMService : FirebaseMessagingService() {

    companion object {
        private const val TAG = "FCMService"
        const val NUDGE_CHANNEL_ID = "nudges"
        /** A nudge just arrived; extras: nudgeId, text, actions (JSON string). */
        const val ACTION_NUDGE_RECEIVED = "club.opportune.app.NUDGE_RECEIVED"
        /** A nudge was answered natively (notification button); the web app should refresh. */
        const val ACTION_NUDGES_CHANGED = "club.opportune.app.NUDGES_CHANGED"
        const val EXTRA_OPEN_NUDGES = "openNudges"
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
                Intent(context, MainActivity::class.java).apply {
                    flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
                    putExtra(EXTRA_OPEN_NUDGES, true); putExtra("nudgeId", nudge.id)
                },
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
        // Signed out but the node still has our old token on file: nothing to answer with, show nothing.
        if (!Prefs.isConfigured(this)) { Log.w(TAG, "push while signed out; ignored"); return }
        val d = msg.data
        val nudgeId = d["nudgeId"] ?: run { Log.w(TAG, "message without nudgeId: $d"); return }
        val text = d["text"] ?: msg.notification?.body ?: return
        val nudge = Prefs.Nudge(id = nudgeId, text = text, actions = Prefs.Nudge.parseActions(d["actions"]), at = System.currentTimeMillis(), response = null)
        Prefs.addNudge(this, nudge)
        show(this, nudge)
        sendBroadcast(Intent(ACTION_NUDGE_RECEIVED).setPackage(packageName).apply {
            putExtra("nudgeId", nudgeId); putExtra("text", text); putExtra("actions", nudge.actionsJson().toString())
        })
        Log.d(TAG, "nudge $nudgeId shown with ${nudge.actions.size} action(s)")
    }

    override fun onNewToken(token: String) {
        Log.d(TAG, "new FCM token")
        if (!Prefs.isConfigured(this)) return   // registered on the next setIngestUrl instead
        scope.launch { ApiClient.registerToken(this@FCMService, token) }
    }

    override fun onDestroy() { scope.cancel(); super.onDestroy() }
}
