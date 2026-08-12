package com.gallery.mobilequeue;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

/** Keeps the durable queue visible to the user while links are still pending. */
public final class QueueNotification {
    public static final String CHANNEL_ID = "gallery_queue";
    private static final int NOTIFICATION_ID = 34001;
    private static final int REQUEST_COPY = 34003;
    private static final int REQUEST_RETRY = 34004;

    private QueueNotification() {}

    public static boolean needsPermission(Context context) {
        return Build.VERSION.SDK_INT >= 33
            && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED;
    }

    public static void refresh(Context context) {
        Context app = context.getApplicationContext();
        int pending = PendingQueueStore.size(app);
        NotificationManager manager =
            (NotificationManager) app.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) {
            return;
        }

        if (pending <= 0) {
            manager.cancel(NOTIFICATION_ID);
            return;
        }

        if (needsPermission(app)) {
            return;
        }

        ensureChannel(manager);

        String title = "Sending to Gallery, " + pending + " queued";
        String lastError = PendingQueueStore.getLastUploadError(app);

        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
            ? new Notification.Builder(app, CHANNEL_ID)
            : new Notification.Builder(app);

        builder
            .setSmallIcon(R.drawable.ic_gallery_upload)
            .setContentTitle(title)
            .setOngoing(true)
            .setAutoCancel(false)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setCategory(Notification.CATEGORY_PROGRESS)
            .addAction(0, "Copy", actionIntent(app, QueueActionReceiver.ACTION_COPY, REQUEST_COPY))
            .addAction(0, "Retry", actionIntent(app, QueueActionReceiver.ACTION_RETRY, REQUEST_RETRY));

        if (lastError != null) {
            builder.setContentText(shorten(lastError));
        } else if (PendingQueueStore.isUploadRunningRecently(app, 30000L)) {
            builder.setContentText("Sending now…");
        } else {
            builder.setContentText("Queued; waiting for network worker");
        }

        if (Build.VERSION.SDK_INT < 26) {
            builder.setPriority(Notification.PRIORITY_LOW);
        }

        manager.notify(NOTIFICATION_ID, builder.build());
    }

    private static PendingIntent actionIntent(Context context, String action, int requestCode) {
        Intent intent = new Intent(context, QueueActionReceiver.class).setAction(action);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getBroadcast(context, requestCode, intent, flags);
    }

    private static String shorten(String text) {
        String compact = text == null ? "Upload failed" : text.replaceAll("\\s+", " ").trim();
        if (compact.length() > 120) {
            return compact.substring(0, 117) + "…";
        }
        return compact;
    }

    private static void ensureChannel(NotificationManager manager) {
        if (Build.VERSION.SDK_INT < 26) {
            return;
        }
        NotificationChannel channel = manager.getNotificationChannel(CHANNEL_ID);
        if (channel == null) {
            channel = new NotificationChannel(
                CHANNEL_ID,
                "Gallery queue",
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Shows how many links are waiting to be sent to Gallery");
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
        }
    }
}
