package com.gallery.mobilequeue;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Durable on-device queue for links shared to the app.
 *
 * WorkManager is responsible for retry scheduling, but this store is the source
 * of truth for pending links. A link is removed only after the remote queue
 * explicitly confirms it was accepted.
 */
public final class PendingQueueStore {
    private static final String PREFS_NAME = "gallery_mobile_queue";
    private static final String KEY_PENDING_URLS = "pending_urls";
    private static final String KEY_LAST_UPLOAD_ERROR = "last_upload_error";
    private static final String KEY_UPLOAD_RUNNING_AT = "upload_running_at";
    private static final String KEY_RETRY_REQUESTED = "retry_requested";
    private static final String KEY_APPEND_RECEIPT_V2_CONFIRMED = "append_receipt_v2_confirmed";
    private static final Object LOCK = new Object();

    private PendingQueueStore() {}

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext()
            .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    public static boolean add(Context context, String url) {
        synchronized (LOCK) {
            Set<String> pending = new HashSet<>(
                prefs(context).getStringSet(KEY_PENDING_URLS, new HashSet<>())
            );
            if (pending.contains(url)) {
                return true;
            }
            pending.add(url);
            // commit() is deliberate: the share target should not report success
            // until the URL is actually persisted to disk.
            return prefs(context).edit().putStringSet(KEY_PENDING_URLS, pending).commit();
        }
    }

    public static String peek(Context context) {
        synchronized (LOCK) {
            Set<String> pending = prefs(context).getStringSet(KEY_PENDING_URLS, null);
            if (pending == null || pending.isEmpty()) {
                return null;
            }
            return pending.iterator().next();
        }
    }

    public static boolean remove(Context context, String url) {
        synchronized (LOCK) {
            Set<String> stored = prefs(context).getStringSet(KEY_PENDING_URLS, null);
            if (stored == null || !stored.contains(url)) {
                return true;
            }
            Set<String> pending = new HashSet<>(stored);
            pending.remove(url);
            return prefs(context).edit().putStringSet(KEY_PENDING_URLS, pending).commit();
        }
    }

    public static int size(Context context) {
        synchronized (LOCK) {
            Set<String> pending = prefs(context).getStringSet(KEY_PENDING_URLS, null);
            return pending == null ? 0 : pending.size();
        }
    }

    /** Returns a stable copy suitable for the notification Copy action. */
    public static List<String> getAll(Context context) {
        synchronized (LOCK) {
            Set<String> pending = prefs(context).getStringSet(KEY_PENDING_URLS, null);
            if (pending == null || pending.isEmpty()) {
                return new ArrayList<>();
            }
            List<String> result = new ArrayList<>(pending);
            Collections.sort(result);
            return result;
        }
    }

    /** Heartbeat used so the Retry action can avoid replacing a live socket. */
    public static void markUploadRunning(Context context) {
        prefs(context).edit().putLong(KEY_UPLOAD_RUNNING_AT, System.currentTimeMillis()).apply();
    }

    public static void clearUploadRunning(Context context) {
        prefs(context).edit().remove(KEY_UPLOAD_RUNNING_AT).apply();
    }

    public static boolean isUploadRunningRecently(Context context, long maxAgeMs) {
        long started = prefs(context).getLong(KEY_UPLOAD_RUNNING_AT, 0L);
        if (started <= 0L) {
            return false;
        }
        long age = Math.max(0L, System.currentTimeMillis() - started);
        return age <= maxAgeMs;
    }

    public static void requestImmediateRetry(Context context) {
        prefs(context).edit().putBoolean(KEY_RETRY_REQUESTED, true).apply();
    }

    public static boolean consumeImmediateRetry(Context context) {
        synchronized (LOCK) {
            SharedPreferences preferences = prefs(context);
            boolean requested = preferences.getBoolean(KEY_RETRY_REQUESTED, false);
            if (requested) {
                preferences.edit().remove(KEY_RETRY_REQUESTED).commit();
            }
            return requested;
        }
    }

    public static void clearImmediateRetry(Context context) {
        prefs(context).edit().remove(KEY_RETRY_REQUESTED).apply();
    }


    /**
     * True after this install has successfully read the server capabilities and
     * confirmed append-receipt protocol v2. This prevents a new client from
     * treating an old server's ContentService error redirect as append success.
     */
    public static boolean isAppendReceiptV2Confirmed(Context context) {
        return prefs(context).getBoolean(KEY_APPEND_RECEIPT_V2_CONFIRMED, false);
    }

    public static void confirmAppendReceiptV2(Context context) {
        prefs(context).edit().putBoolean(KEY_APPEND_RECEIPT_V2_CONFIRMED, true).apply();
    }

    public static void setLastUploadError(Context context, String message) {
        String safe = message == null ? "Upload failed" : message.trim();
        if (safe.isEmpty()) {
            safe = "Upload failed";
        }
        prefs(context).edit().putString(KEY_LAST_UPLOAD_ERROR, safe).apply();
    }

    public static String getLastUploadError(Context context) {
        String value = prefs(context).getString(KEY_LAST_UPLOAD_ERROR, null);
        return value == null || value.trim().isEmpty() ? null : value.trim();
    }

    public static void clearLastUploadError(Context context) {
        prefs(context).edit().remove(KEY_LAST_UPLOAD_ERROR).apply();
    }
}
