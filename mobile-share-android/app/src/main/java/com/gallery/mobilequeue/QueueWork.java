package com.gallery.mobilequeue;

import android.content.Context;

import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;

import java.util.concurrent.TimeUnit;

/** Central scheduler for draining the durable mobile queue. */
public final class QueueWork {
    public static final String QUEUE_NAME = "gallery-share-upload-queue";
    private static final long LIVE_WORKER_WINDOW_MS = 120000L;

    private QueueWork() {}

    /**
     * Normal shares never replace a worker. The running worker drains the
     * durable store and naturally sees links added while it is active.
     */
    public static void enqueueNow(Context context) {
        enqueue(context, ExistingWorkPolicy.KEEP);
    }

    /**
     * Manual retry has two modes:
     * - if a network attempt is alive, do NOT replace it; ask that worker to
     *   retry immediately after the current bounded attempt finishes;
     * - if no worker is alive (usually WorkManager backoff), REPLACE wakes the
     *   queue immediately and resets that backoff.
     */
    public static void forceRetry(Context context) {
        Context app = context.getApplicationContext();
        if (PendingQueueStore.size(app) <= 0) {
            return;
        }

        if (PendingQueueStore.isUploadRunningRecently(app, LIVE_WORKER_WINDOW_MS)) {
            PendingQueueStore.requestImmediateRetry(app);
            PendingQueueStore.setLastUploadError(app, "Retry requested; finishing the current attempt first");
            QueueNotification.refresh(app);
            return;
        }

        PendingQueueStore.clearImmediateRetry(app);
        PendingQueueStore.setLastUploadError(app, "Retrying now…");
        QueueNotification.refresh(app);
        enqueue(app, ExistingWorkPolicy.REPLACE);
    }

    private static void enqueue(Context context, ExistingWorkPolicy policy) {
        Context app = context.getApplicationContext();
        if (PendingQueueStore.size(app) <= 0) {
            return;
        }

        Constraints constraints = new Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build();

        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(QueueUploadWorker.class)
            .setConstraints(constraints)
            // Keep automatic recovery reasonably prompt. Immediate retries are
            // already handled inside the worker; this is the longer fallback.
            .setBackoffCriteria(BackoffPolicy.LINEAR, 10, TimeUnit.SECONDS)
            .addTag(QUEUE_NAME)
            .build();

        WorkManager.getInstance(app)
            .beginUniqueWork(QUEUE_NAME, policy, request)
            .enqueue();
    }
}
