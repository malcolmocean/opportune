package com.malcolmocean.opportune

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.format.DateUtils
import android.util.Log
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * One screen: setup (paste the ingest URL), porchlight, review link, contacts opt-in, recent nudges.
 * Saving a URL kicks off the permission chain (notifications → location → background → motion) and
 * then starts LocationService and registers the FCM token.
 */
class MainActivity : AppCompatActivity() {

    companion object { private const val TAG = "MainActivity" }

    private lateinit var urlInput: EditText
    private lateinit var statusText: TextView
    private lateinit var porchlightState: TextView
    private lateinit var contactsSwitch: Switch
    private lateinit var contactsState: TextView
    private lateinit var nudgesContainer: LinearLayout

    private val nudgesChanged = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) { renderNudges() }
    }

    // ---- permission chain ----
    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { requestLocation() }

    private val locationPermission = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        val ok = granted[Manifest.permission.ACCESS_FINE_LOCATION] == true || granted[Manifest.permission.ACCESS_COARSE_LOCATION] == true
        if (ok) requestBackgroundLocation() else {
            AlertDialog.Builder(this).setTitle("Location")
                .setMessage("opportune only works if it knows roughly where you are. Allow location in Settings.")
                .setPositiveButton("Settings") { _, _ -> openAppSettings() }.setNegativeButton("Later", null).show()
            renderStatus()
        }
    }

    private val backgroundPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { finishSetup() }

    private val contactsPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) { Prefs.setShareContacts(this, true); syncContactsNow() }
        else { Prefs.setShareContacts(this, false); contactsSwitch.isChecked = false; contactsState.text = "Permission denied." }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        FCMService.ensureChannel(this)

        urlInput = findViewById(R.id.urlInput)
        statusText = findViewById(R.id.statusText)
        porchlightState = findViewById(R.id.porchlightState)
        contactsSwitch = findViewById(R.id.contactsSwitch)
        contactsState = findViewById(R.id.contactsState)
        nudgesContainer = findViewById(R.id.nudgesContainer)

        urlInput.setText(Prefs.ingestUrl(this) ?: "")
        findViewById<Button>(R.id.saveButton).setOnClickListener { saveUrl() }

        findViewById<Button>(R.id.plOpen).setOnClickListener { setPorchlight("open") }
        findViewById<Button>(R.id.plAsk).setOnClickListener { setPorchlight("ask") }
        findViewById<Button>(R.id.plClosed).setOnClickListener { setPorchlight("closed") }

        findViewById<Button>(R.id.reviewButton).setOnClickListener {
            val node = Prefs.parseIngestUrl(Prefs.ingestUrl(this)) ?: return@setOnClickListener toast("Paste your URL first.")
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(node.reviewUrl)))
        }

        contactsSwitch.isChecked = Prefs.shareContacts(this)
        contactsSwitch.setOnCheckedChangeListener { _, on ->
            if (!on) { Prefs.setShareContacts(this, false); renderContacts(); return@setOnCheckedChangeListener }
            if (!Prefs.isConfigured(this)) { contactsSwitch.isChecked = false; return@setOnCheckedChangeListener toast("Paste your URL first.") }
            if (ContactsSync.hasPermission(this)) { Prefs.setShareContacts(this, true); syncContactsNow() }
            else contactsPermission.launch(Manifest.permission.READ_CONTACTS)
        }

        if (Prefs.isConfigured(this)) {
            LocationService.start(this)
            registerFcmToken()
        }
        intent?.getStringExtra("nudgeId")?.let { openNudge(it) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        intent.getStringExtra("nudgeId")?.let { openNudge(it) }
    }

    override fun onResume() {
        super.onResume()
        ContextCompat.registerReceiver(this, nudgesChanged, IntentFilter(FCMService.ACTION_NUDGES_CHANGED), ContextCompat.RECEIVER_NOT_EXPORTED)
        renderAll()
        lifecycleScope.launch(Dispatchers.IO) { ContactsSync.maybeSync(this@MainActivity)?.let { withContext(Dispatchers.Main) { renderContacts() } } }
    }

    override fun onPause() {
        super.onPause()
        try { unregisterReceiver(nudgesChanged) } catch (e: IllegalArgumentException) {}
    }

    // ---- setup ----
    private fun saveUrl() {
        val raw = urlInput.text.toString().trim()
        val node = Prefs.parseIngestUrl(raw)
        if (node == null) {
            statusText.text = "That doesn't look like an ingest URL. Expected …/ingest/opportuneApp/<token>."
            return
        }
        statusText.text = "Checking…"
        lifecycleScope.launch {
            val code = withContext(Dispatchers.IO) { ApiClient.probe(raw) }
            when {
                code == 200 -> {
                    Prefs.setIngestUrl(this@MainActivity, raw)
                    statusText.text = "Connected to ${node.baseUrl}."
                    requestNotifications()
                }
                code == 401 || code == 404 -> statusText.text = "The node rejected that token ($code). Ask the bot for a fresh URL (/sources)."
                code == -1 -> {
                    // offline, or a local node not reachable from here: keep it anyway so location queues up
                    Prefs.setIngestUrl(this@MainActivity, raw)
                    statusText.text = "Saved, but couldn't reach ${node.baseUrl} right now."
                    requestNotifications()
                }
                else -> statusText.text = "Unexpected response $code from ${node.baseUrl}."
            }
        }
    }

    private fun requestNotifications() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else requestLocation()
    }

    private fun requestLocation() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) requestBackgroundLocation()
        else {
            val perms = mutableListOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) perms.add(Manifest.permission.ACTIVITY_RECOGNITION)
            locationPermission.launch(perms.toTypedArray())
        }
    }

    private fun requestBackgroundLocation() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_BACKGROUND_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            AlertDialog.Builder(this).setTitle("Location in the background")
                .setMessage("Pick \"Allow all the time\" on the next screen so opportune can notice when you're near your people while the app is closed.")
                .setPositiveButton("OK") { _, _ -> backgroundPermission.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION) }
                .setNegativeButton("Skip") { _, _ -> finishSetup() }
                .show()
        } else finishSetup()
    }

    private fun finishSetup() {
        LocationService.start(this)
        registerFcmToken()
        renderAll()
    }

    private fun registerFcmToken() {
        if (FirebaseApp.getApps(this).isEmpty()) { Log.w(TAG, "Firebase not configured (no google-services.json); push off"); return }
        FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
            if (!task.isSuccessful) { Log.w(TAG, "FCM token unavailable", task.exception); return@addOnCompleteListener }
            val token = task.result ?: return@addOnCompleteListener
            if (Prefs.fcmRegisteredToken(this) == token) return@addOnCompleteListener
            lifecycleScope.launch(Dispatchers.IO) {
                val ok = ApiClient.registerToken(this@MainActivity, token)
                withContext(Dispatchers.Main) { renderStatus() }
                Log.d(TAG, "token registered: $ok")
            }
        }
    }

    // ---- porchlight ----
    private fun setPorchlight(status: String) {
        if (!Prefs.isConfigured(this)) return toast("Paste your URL first.")
        Prefs.setPorchlight(this, status)
        renderPorchlight()
        lifecycleScope.launch(Dispatchers.IO) {
            val ok = ApiClient.setPorchlight(this@MainActivity, status)
            withContext(Dispatchers.Main) { if (!ok) toast("Couldn't reach your node; try again.") }
        }
    }

    // ---- contacts ----
    private fun syncContactsNow() {
        contactsState.text = "Syncing…"
        lifecycleScope.launch {
            val n = withContext(Dispatchers.IO) { ContactsSync.sync(this@MainActivity) }
            if (n < 0) contactsState.text = "Sync failed; will retry later." else renderContacts()
        }
    }

    // ---- rendering ----
    private fun renderAll() { renderStatus(); renderPorchlight(); renderContacts(); renderNudges() }

    private fun renderStatus() {
        val node = Prefs.parseIngestUrl(Prefs.ingestUrl(this))
        if (node == null) { statusText.text = "Not set up yet. In Telegram: /sources → opportune Android app."; return }
        val parts = mutableListOf("Node: ${node.baseUrl}")
        val (at, ok) = Prefs.lastPost(this)
        if (at > 0) parts.add("Last post ${DateUtils.getRelativeTimeSpanString(at)}${if (ok) "" else " (failed)"}")
        parts.add(when {
            FirebaseApp.getApps(this).isEmpty() -> "Push: off (no google-services.json in this build)"
            Prefs.fcmRegisteredToken(this) != null -> "Push: registered"
            else -> "Push: registering…"
        })
        val loc = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        if (!loc) parts.add("Location permission missing")
        statusText.text = parts.joinToString("\n")
    }

    private fun renderPorchlight() {
        val pl = Prefs.porchlight(this)
        porchlightState.text = if (pl == null) "Not set from this phone yet." else {
            val expired = System.currentTimeMillis() - pl.second > 6 * 3600 * 1000L
            if (expired) "Last set to \"${pl.first}\" ${DateUtils.getRelativeTimeSpanString(pl.second)} (expired)."
            else "Currently: ${pl.first}, set ${DateUtils.getRelativeTimeSpanString(pl.second)}."
        }
    }

    private fun renderContacts() {
        contactsState.text = when {
            !Prefs.shareContacts(this) -> "Off."
            Prefs.contactsSyncedAt(this) == 0L -> "On, not synced yet."
            else -> "${Prefs.contactsCount(this)} contacts, synced ${DateUtils.getRelativeTimeSpanString(Prefs.contactsSyncedAt(this))}. Re-syncs daily."
        }
    }

    private fun renderNudges() {
        nudgesContainer.removeAllViews()
        val list = Prefs.nudges(this)
        if (list.isEmpty()) {
            nudgesContainer.addView(TextView(this).apply { text = getString(R.string.no_nudges); setTextColor(statusText.currentTextColor) })
            return
        }
        for (n in list) {
            val row = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(0, 12, 0, 12) }
            row.addView(TextView(this).apply { text = n.text; textSize = 15f })
            val meta = if (n.response != null) "${DateUtils.getRelativeTimeSpanString(n.at)} · you said: ${n.actions.firstOrNull { it.first == n.response }?.second ?: n.response}"
                       else DateUtils.getRelativeTimeSpanString(n.at).toString()
            row.addView(TextView(this).apply { text = meta; textSize = 12f; setTextColor(statusText.currentTextColor) })
            if (n.response == null && n.actions.isNotEmpty()) {
                val buttons = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
                for ((key, label) in n.actions) {
                    buttons.addView(Button(this, null, android.R.attr.buttonBarButtonStyle).apply {
                        text = label; isAllCaps = false
                        setOnClickListener { NotificationActionReceiver.respond(this@MainActivity, n.id, key); renderNudges() }
                    })
                }
                row.addView(buttons)
            }
            row.setOnClickListener { openNudge(n.id) }
            nudgesContainer.addView(row)
            nudgesContainer.addView(View(this).apply { layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 1); setBackgroundColor(0x22888888) })
        }
    }

    /** Tapping a notification body (or a list row) shows the full text with every action, not just three. */
    private fun openNudge(id: String) {
        val n = Prefs.nudges(this).firstOrNull { it.id == id } ?: return
        if (n.response != null || n.actions.isEmpty()) { AlertDialog.Builder(this).setMessage(n.text).setPositiveButton("OK", null).show(); return }
        val labels = n.actions.map { it.second }.toTypedArray()
        AlertDialog.Builder(this).setMessage(n.text)
            .setItems(labels) { _, i -> NotificationActionReceiver.respond(this, n.id, n.actions[i].first); renderNudges() }
            .setNegativeButton("Later", null).show()
    }

    private fun openAppSettings() = startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()
}
