package com.gallery.mobilequeue;

import android.content.BroadcastReceiver;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.widget.Toast;

import java.util.List;

/** Handles the Copy and Retry buttons shown on the persistent queue notification. */
public class QueueActionReceiver extends BroadcastReceiver {
    public static final String ACTION_COPY = "com.gallery.mobilequeue.action.COPY_PENDING";
    public static final String ACTION_RETRY = "com.gallery.mobilequeue.action.RETRY_PENDING";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) {
            return;
        }

        String action = intent.getAction();
        if (ACTION_COPY.equals(action)) {
            copyPending(context);
            return;
        }

        if (ACTION_RETRY.equals(action)) {
            retryPending(context);
        }
    }

    private static void copyPending(Context context) {
        List<String> urls = PendingQueueStore.getAll(context);
        if (urls.isEmpty()) {
            Toast.makeText(context, "Gallery queue is empty", Toast.LENGTH_SHORT).show();
            QueueNotification.refresh(context);
            return;
        }

        ClipboardManager clipboard =
            (ClipboardManager) context.getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard == null) {
            Toast.makeText(context, "Could not access clipboard", Toast.LENGTH_SHORT).show();
            return;
        }

        String text = joinLines(urls);
        clipboard.setPrimaryClip(ClipData.newPlainText("Gallery queued links", text));
        Toast.makeText(
            context,
            "Copied " + urls.size() + (urls.size() == 1 ? " queued link" : " queued links"),
            Toast.LENGTH_SHORT
        ).show();
    }

    private static void retryPending(Context context) {
        int count = PendingQueueStore.size(context);
        if (count <= 0) {
            Toast.makeText(context, "Gallery queue is empty", Toast.LENGTH_SHORT).show();
            QueueNotification.refresh(context);
            return;
        }

        // QueueWork decides whether to wake a backoff worker immediately or
        // signal an already-running bounded network attempt. It deliberately
        // does not replace a live socket.
        QueueWork.forceRetry(context);
        Toast.makeText(
            context,
            "Retrying " + count + (count == 1 ? " queued link" : " queued links"),
            Toast.LENGTH_SHORT
        ).show();
    }

    private static String joinLines(List<String> urls) {
        StringBuilder result = new StringBuilder();
        for (int i = 0; i < urls.size(); i++) {
            if (i > 0) {
                result.append('\n');
            }
            result.append(urls.get(i));
        }
        return result.toString();
    }
}
