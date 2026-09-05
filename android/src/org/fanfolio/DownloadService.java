package org.fanfolio;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

/**
 * Keeps a download running while the app is not being looked at.
 *
 * An author's catalogue is hours of paced requests, and until now all of it
 * stopped the moment the app went away — which the settings screen admitted
 * to rather than fixed. Android will keep a process alive and out of Doze if
 * it says what it is doing and shows that it is doing it, so that is what this
 * is: an ongoing notification for as long as there is work, and nothing when
 * there is not.
 *
 * The work itself still runs in the page. This does not reimplement the queue
 * — a second copy of the pacing and retry rules is exactly the kind of
 * duplication that has caused trouble here before. It holds the process open
 * and keeps the processor awake so the page's own timers keep firing.
 */
public class DownloadService extends Service {

    public static final String ACTION_START = "org.fanfolio.WORK_START";
    public static final String ACTION_PAUSE = "org.fanfolio.WORK_PAUSE";
    public static final String ACTION_RESUME = "org.fanfolio.WORK_RESUME";
    public static final String ACTION_STOP = "org.fanfolio.WORK_STOP";
    public static final String ACTION_DONE = "org.fanfolio.WORK_DONE";
    public static final String EXTRA_TEXT = "text";
    public static final String EXTRA_STATE = "state";
    public static final String EXTRA_ATTENTION = "attention";

    private static final String CHANNEL = "downloads";
    private static final String CHANNEL_DONE = "finished";
    private static final int NOTE_ID = 1;
    /* The record of a finished run is a different notification from the one
       that kept the process alive: it outlives the service, and it can be
       swiped away, which an ongoing one cannot. */
    private static final int DONE_ID = 2;

    private PowerManager.WakeLock awake;

    /* What the work was last doing, so Resume can put the line back rather
       than replacing it with something vaguer than what it interrupted. */
    private String lastText = "Downloading from the archive";

    /*
     * The clock the page cannot keep for itself once it is in the background.
     * Every few seconds while there is work, the page is told that time has
     * passed; it decides whether anything is owed.
     */
    private final android.os.Handler clock = new android.os.Handler(android.os.Looper.getMainLooper());
    private static final long TICK_MS = 5_000;
    private final Runnable keepingTime = new Runnable() {
        @Override public void run() {
            MainActivity.tick();
            clock.postDelayed(this, TICK_MS);
        }
    };

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_START : String.valueOf(intent.getAction());

        if (ACTION_PAUSE.equals(action)) {
            /*
             * Paused is a state, not the absence of one.
             *
             * This used to tell the page to pause and then take the whole
             * notification down, so the only sign the app had stopped halfway
             * through a catalogue was that something was missing — and the
             * only way to start it again was to go and find the Activity
             * screen. The notification stays and offers Resume. The wake lock
             * does not: nothing is waiting on a clock while it is paused.
             */
            MainActivity.pauseFromNotification();
            clock.removeCallbacks(keepingTime);
            release();
            startForegroundWith(lastText, true);
            return START_STICKY;
        }

        if (ACTION_RESUME.equals(action)) {
            MainActivity.resumeFromNotification();
            startForegroundWith(lastText, false);
            hold();
            clock.removeCallbacks(keepingTime);
            clock.postDelayed(keepingTime, TICK_MS);
            return START_STICKY;
        }

        if (ACTION_STOP.equals(action)) {
            /* Everything ends. The record of it does not: a stopped job stays
               on the Activity list with what it managed and what it never got,
               and can be asked for again — which is the only thing that makes
               this safe to offer from a lock screen. */
            MainActivity.stopFromNotification();
            standDown();
            return START_NOT_STICKY;
        }

        if (ACTION_DONE.equals(action)) {
            String said = intent == null ? null : intent.getStringExtra(EXTRA_TEXT);
            boolean attention = intent != null && intent.getBooleanExtra(EXTRA_ATTENTION, false);
            showFinished(said, attention);
            standDown();
            return START_NOT_STICKY;
        }

        String text = intent == null ? null : intent.getStringExtra(EXTRA_TEXT);
        if (text == null || text.isEmpty()) text = "Downloading from the archive";
        lastText = text;
        boolean nowPaused = intent != null && "paused".equals(intent.getStringExtra(EXTRA_STATE));
        startForegroundWith(text, nowPaused);
        if (nowPaused) {
            clock.removeCallbacks(keepingTime);
            release();
        } else {
            hold();
            clock.removeCallbacks(keepingTime);
            clock.postDelayed(keepingTime, TICK_MS);
        }
        return START_STICKY;
    }

    private void standDown() {
        clock.removeCallbacks(keepingTime);
        release();
        stopForeground(true);
        stopSelf();
    }

    /** The channel a notification belongs to, made once. */
    private void ensureChannel(String id, String name, String description) {
        NotificationManager manager =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT < 26 || manager == null) return;
        if (manager.getNotificationChannel(id) != null) return;
        NotificationChannel channel = new NotificationChannel(
                id, name, NotificationManager.IMPORTANCE_LOW);
        channel.setDescription(description);
        channel.setShowBadge(false);
        manager.createNotificationChannel(channel);
    }

    private int immutableFlag() {
        return Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0;
    }

    /* A notification about a download has one sensible destination, and it is
       not wherever the app happened to be left. */
    private PendingIntent openActivity(int request, String where) {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        open.putExtra("open", where);
        return PendingIntent.getActivity(
                this, request, open, PendingIntent.FLAG_UPDATE_CURRENT | immutableFlag());
    }

    private PendingIntent serviceAction(int request, String action) {
        Intent go = new Intent(this, DownloadService.class).setAction(action);
        return PendingIntent.getService(
                this, request, go, PendingIntent.FLAG_UPDATE_CURRENT | immutableFlag());
    }

    private void startForegroundWith(String text, boolean isPaused) {
        ensureChannel(CHANNEL, "Downloads",
                "Shown while works are being fetched from the archive.");

        Notification.Builder note = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL)
                : new Notification.Builder(this);
        note.setContentTitle("Fan Folio")
            .setContentText(text)
            .setSmallIcon(isPaused
                    ? android.R.drawable.ic_media_pause
                    : android.R.drawable.stat_sys_download)
            .setOngoing(true)
            .setContentIntent(openActivity(0, "activity"));

        /*
         * What it offers depends on what it is doing. Work in progress can be
         * paused; work that has been paused is the only state where Resume
         * means anything, and it is the state that most needs a way out —
         * before this, pausing took the notification away and left no way
         * back except opening the app and finding the Activity screen.
         */
        if (isPaused) {
            note.addAction(new Notification.Action.Builder(
                    null, "Resume", serviceAction(2, ACTION_RESUME)).build());
            note.addAction(new Notification.Action.Builder(
                    null, "Stop", serviceAction(3, ACTION_STOP)).build());
        } else {
            note.addAction(new Notification.Action.Builder(
                    null, "Pause", serviceAction(1, ACTION_PAUSE)).build());
        }
        if (Build.VERSION.SDK_INT >= 26) note.setChannelId(CHANNEL);

        Notification built = note.build();
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTE_ID, built,
                    android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTE_ID, built);
        }
    }

    /**
     * What the run came to, once it is over.
     *
     * An hour of downloading that ends in silence is indistinguishable from an
     * hour of downloading that was killed. This one is not ongoing — it can be
     * swiped away — and it outlives the service, because the moment somebody
     * would think to ask for the missing works again is the moment they are
     * told there are any.
     */
    private void showFinished(String text, boolean attention) {
        if (text == null || text.isEmpty()) return;
        ensureChannel(CHANNEL_DONE, "Finished",
                "Shown once when a download has ended.");

        Notification.Builder note = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_DONE)
                : new Notification.Builder(this);
        note.setContentTitle(attention ? "Some works never arrived" : "Fan Folio")
            .setContentText(text)
            .setSmallIcon(attention
                    ? android.R.drawable.stat_notify_error
                    : android.R.drawable.stat_sys_download_done)
            .setAutoCancel(true)
            .setOngoing(false)
            .setContentIntent(openActivity(4, "activity"));
        if (Build.VERSION.SDK_INT >= 26) note.setChannelId(CHANNEL_DONE);

        NotificationManager manager =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(DONE_ID, note.build());
    }

    /**
     * The processor stays awake, which is what actually keeps the page's timers
     * firing. The screen does not: this is not a reason to keep somebody's
     * display on for an hour.
     */
    private void hold() {
        if (awake != null && awake.isHeld()) return;
        PowerManager power = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (power == null) return;
        awake = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "fanfolio:downloads");
        awake.setReferenceCounted(false);
        awake.acquire();
    }

    private void release() {
        if (awake != null && awake.isHeld()) awake.release();
        awake = null;
    }

    @Override
    public void onDestroy() {
        clock.removeCallbacks(keepingTime);
        release();
        super.onDestroy();
    }
}
