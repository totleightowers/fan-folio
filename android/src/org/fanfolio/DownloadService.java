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
    public static final String ACTION_STOP = "org.fanfolio.WORK_STOP";
    public static final String EXTRA_TEXT = "text";

    private static final String CHANNEL = "downloads";
    private static final int NOTE_ID = 1;

    private PowerManager.WakeLock awake;

    @Override
    public IBinder onBind(Intent intent) { return null; }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? ACTION_START : String.valueOf(intent.getAction());

        if (ACTION_STOP.equals(action)) {
            /* The reader pressed Stop on the notification. Tell the page, which
               owns the queue, and stand down. */
            MainActivity.pauseFromNotification();
            release();
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }

        String text = intent == null ? null : intent.getStringExtra(EXTRA_TEXT);
        if (text == null || text.isEmpty()) text = "Downloading from the archive";
        startForegroundWith(text);
        hold();
        return START_STICKY;
    }

    private void startForegroundWith(String text) {
        NotificationManager manager =
                (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && manager != null
                && manager.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL, "Downloads", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Shown while works are being fetched from the archive.");
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
        }

        int immutable = Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0;

        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(
                this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | immutable);

        Intent stop = new Intent(this, DownloadService.class).setAction(ACTION_STOP);
        PendingIntent stopping = PendingIntent.getService(
                this, 1, stop, PendingIntent.FLAG_UPDATE_CURRENT | immutable);

        Notification.Builder note = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL)
                : new Notification.Builder(this);
        note.setContentTitle("Fan Folio")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setOngoing(true)
            .setContentIntent(tap)
            .addAction(new Notification.Action.Builder(null, "Pause", stopping).build());
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
        release();
        super.onDestroy();
    }
}
