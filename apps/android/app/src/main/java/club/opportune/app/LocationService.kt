package club.opportune.app

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.os.BatteryManager
import android.os.Build
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.google.android.gms.location.ActivityRecognition
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.tasks.await
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.format.DateTimeFormatter

/**
 * Foreground service: significant-displacement location (100 m / 5 min), a 15-minute heartbeat, and
 * batched POSTs of [{lat,lng,acc,speed,at,battery,motion}] to the ingest URL. Points that fail to
 * send stay queued and go with the next batch.
 */
class LocationService : Service() {

    companion object {
        private const val TAG = "LocationService"
        const val CHANNEL_ID = "location_channel"
        private const val NOTIFICATION_ID = 1
        private const val DISPLACEMENT_METERS = 100f
        private const val INTERVAL_MS = 5 * 60 * 1000L
        private const val HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000L
        private const val ACTIVITY_INTERVAL_MS = 2 * 60 * 1000L
        private const val MAX_QUEUE = 500

        fun start(context: Context) {
            if (!Prefs.isConfigured(context)) return
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED &&
                ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                Log.w(TAG, "No location permission; not starting"); return
            }
            try { ContextCompat.startForegroundService(context, Intent(context, LocationService::class.java)) }
            catch (e: Exception) { Log.e(TAG, "Could not start foreground service", e) }
        }

        /** No-op if it isn't running. onDestroy drops the queue and the location/activity registrations. */
        fun stop(context: Context) {
            try { context.stopService(Intent(context, LocationService::class.java)) }
            catch (e: Exception) { Log.w(TAG, "Could not stop service: ${e.message}") }
        }
    }

    private lateinit var fused: FusedLocationProviderClient
    private lateinit var callback: LocationCallback
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var heartbeat: Job? = null
    private val queue = ArrayList<JSONObject>()
    private val flushLock = Mutex()
    private var activityIntent: PendingIntent? = null

    override fun onCreate() {
        super.onCreate()
        fused = LocationServices.getFusedLocationProviderClient(this)
        createChannel()
        callback = object : LocationCallback() {
            override fun onLocationResult(result: LocationResult) {
                result.lastLocation?.let { enqueue(it) }
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val n = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        else startForeground(NOTIFICATION_ID, n)
        // start() already checks, but START_STICKY can revive us (intent == null) after a sign-out or a
        // process kill with no URL left. Never run without somewhere to post to.
        if (!Prefs.isConfigured(this)) {
            Log.w(TAG, "no ingest URL; stopping")
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        startLocationUpdates()
        startActivityUpdates()
        startHeartbeat()
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        heartbeat?.cancel()
        fused.removeLocationUpdates(callback)
        activityIntent?.let { try { ActivityRecognition.getClient(this).removeActivityUpdates(it) } catch (e: SecurityException) {} }
        scope.cancel()
        super.onDestroy()
    }

    private fun createChannel() {
        val ch = NotificationChannel(CHANNEL_ID, getString(R.string.location_channel_name), NotificationManager.IMPORTANCE_LOW)
            .apply { description = getString(R.string.location_channel_description) }
        getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
    }

    private fun buildNotification(): Notification {
        val pi = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.location_notification_title))
            .setContentText(getString(R.string.location_notification_text))
            .setSmallIcon(R.drawable.ic_location)
            .setContentIntent(pi)
            .setOngoing(true)
            .setSilent(true)
            .build()
    }

    private fun startLocationUpdates() {
        val req = LocationRequest.Builder(Priority.PRIORITY_BALANCED_POWER_ACCURACY, INTERVAL_MS)
            .setMinUpdateDistanceMeters(DISPLACEMENT_METERS)
            .setWaitForAccurateLocation(false)
            .build()
        try {
            fused.requestLocationUpdates(req, callback, Looper.getMainLooper())
            // one point right away so the node knows where we are without waiting for movement
            fused.lastLocation.addOnSuccessListener { it?.let { l -> enqueue(l) } }
        } catch (e: SecurityException) { Log.e(TAG, "Location permission missing", e) }
    }

    /** Motion state is a bonus: silently skipped if the permission wasn't granted. */
    private fun startActivityUpdates() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACTIVITY_RECOGNITION) != PackageManager.PERMISSION_GRANTED) return
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
        val pi = PendingIntent.getBroadcast(this, 7, Intent(this, ActivityReceiver::class.java).setAction(ActivityReceiver.ACTION), flags)
        try {
            ActivityRecognition.getClient(this).requestActivityUpdates(ACTIVITY_INTERVAL_MS, pi)
            activityIntent = pi
        } catch (e: SecurityException) { Log.w(TAG, "Activity recognition unavailable: ${e.message}") }
    }

    private fun startHeartbeat() {
        heartbeat?.cancel()
        heartbeat = scope.launch {
            while (isActive) {
                delay(HEARTBEAT_INTERVAL_MS)
                try {
                    val l = try { fused.lastLocation.await() } catch (e: SecurityException) { null }
                    if (l != null) enqueue(l, force = true) else flush()
                } catch (e: Exception) { Log.w(TAG, "heartbeat: ${e.message}") }
                ContactsSync.maybeSync(this@LocationService)
            }
        }
    }

    private fun batteryFraction(): Double? {
        val bm = getSystemService(BatteryManager::class.java) ?: return null
        val pct = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        return if (pct in 0..100) pct / 100.0 else null
    }

    private fun toJson(l: Location, at: Long): JSONObject = JSONObject().apply {
        put("lat", l.latitude); put("lng", l.longitude)
        if (l.hasAccuracy()) put("acc", l.accuracy.toDouble())
        if (l.hasSpeed()) put("speed", l.speed.toDouble())
        put("at", DateTimeFormatter.ISO_INSTANT.format(Instant.ofEpochMilli(at)))
        batteryFraction()?.let { put("battery", it) }
        ActivityReceiver.current()?.let { put("motion", it) }
    }

    /** Heartbeats re-send the last known fix stamped now, so the node sees "still here" even without movement. */
    private fun enqueue(l: Location, force: Boolean = false) {
        val at = if (force) System.currentTimeMillis() else l.time
        synchronized(queue) {
            queue.add(toJson(l, at))
            while (queue.size > MAX_QUEUE) queue.removeAt(0)
        }
        scope.launch { flush() }
    }

    /**
     * Transient failures (no network, 5xx, timeouts) keep the batch for the next try. 401 (token revoked)
     * and 404 (source removed) are final: the node will never take these points, so the whole session
     * goes, service included. The web app notices the same thing on its next request and signs out too.
     */
    private suspend fun flush() = flushLock.withLock {
        if (!Prefs.isConfigured(this)) {
            // signed out while points were queued (or while a post was in flight): nothing to post to
            val n = synchronized(queue) { queue.size.also { queue.clear() } }
            if (n > 0) Log.w(TAG, "no ingest URL; dropped $n queued point(s)")
            stopSelf()
            return@withLock
        }
        val batch = synchronized(queue) { ArrayList(queue) }
        if (batch.isEmpty()) return@withLock
        val arr = JSONArray(); batch.forEach { arr.put(it) }
        val code = ApiClient.postLocations(this, arr)
        if (code in 200..299) {
            synchronized(queue) { queue.removeAll(batch.toSet()) }
            Log.d(TAG, "posted ${batch.size} point(s)")
        } else if (code == 401 || code == 404) {
            synchronized(queue) { queue.clear() }
            Log.w(TAG, "ingest URL rejected ($code); dropping ${batch.size} point(s) and signing out")
            Session.signOut(this, "node answered $code")
        } else {
            Log.w(TAG, "keeping ${batch.size} point(s) queued (code $code)")
        }
    }
}
