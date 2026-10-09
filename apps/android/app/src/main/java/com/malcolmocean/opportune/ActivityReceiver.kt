package com.malcolmocean.opportune

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.google.android.gms.location.ActivityRecognitionResult
import com.google.android.gms.location.DetectedActivity

/** Receives ActivityRecognition updates and keeps the latest motion state for LocationService to attach. */
class ActivityReceiver : BroadcastReceiver() {
    companion object {
        private const val TAG = "ActivityReceiver"
        const val ACTION = "com.malcolmocean.opportune.ACTIVITY"
        private const val STALE_MS = 20 * 60 * 1000L

        @Volatile private var state: String? = null
        @Volatile private var at: Long = 0L

        /** 'still' | 'walking' | 'driving' | null (unknown, or too old to trust). */
        fun current(): String? = if (System.currentTimeMillis() - at < STALE_MS) state else null

        fun map(a: DetectedActivity): String? = when (a.type) {
            DetectedActivity.IN_VEHICLE -> "driving"
            DetectedActivity.ON_FOOT, DetectedActivity.WALKING, DetectedActivity.RUNNING -> "walking"
            DetectedActivity.STILL -> "still"
            else -> null
        }
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (!ActivityRecognitionResult.hasResult(intent)) return
        val result = ActivityRecognitionResult.extractResult(intent) ?: return
        val best = result.mostProbableActivity
        val mapped = map(best)
        if (best.confidence >= 50 && mapped != null) {
            state = mapped; at = System.currentTimeMillis()
            Log.d(TAG, "motion=$mapped (${best.confidence}%)")
        }
    }
}
