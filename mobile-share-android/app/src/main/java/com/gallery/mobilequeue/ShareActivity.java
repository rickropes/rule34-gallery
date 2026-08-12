package com.gallery.mobilequeue;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.widget.Toast;

import androidx.annotation.NonNull;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class ShareActivity extends Activity {
    private static final Pattern URL_PATTERN = Pattern.compile("https?://[^\\s]+", Pattern.CASE_INSENSITIVE);
    private static final int REQUEST_NOTIFICATIONS = 34002;

    @Override
    public void onCreate(Bundle state) {
        super.onCreate(state);

        String text = Intent.ACTION_SEND.equals(getIntent().getAction())
            ? getIntent().getStringExtra(Intent.EXTRA_TEXT)
            : null;
        Matcher matcher = URL_PATTERN.matcher(text == null ? "" : text);
        if (!matcher.find()) {
            Toast.makeText(this, "No link found", Toast.LENGTH_SHORT).show();
            finishAndRemoveTask();
            return;
        }

        String link = matcher.group();
        if (!PendingQueueStore.add(getApplicationContext(), link)) {
            Toast.makeText(this, "Could not save link to Gallery queue", Toast.LENGTH_LONG).show();
            finishAndRemoveTask();
            return;
        }

        // The URL is durable before network work starts. The ongoing notification
        // reflects the durable store, so it remains visible across upload retries.
        QueueNotification.refresh(getApplicationContext());
        QueueWork.enqueueNow(getApplicationContext());

        int pending = PendingQueueStore.size(getApplicationContext());
        String message = pending == 1
            ? "Saved to Gallery queue"
            : "Saved to Gallery queue (" + pending + " pending)";
        String lastError = PendingQueueStore.getLastUploadError(getApplicationContext());
        if (lastError != null) {
            message += "\nLast upload failed: " + lastError;
        }
        Toast.makeText(this, message, lastError == null ? Toast.LENGTH_SHORT : Toast.LENGTH_LONG).show();

        if (Build.VERSION.SDK_INT >= 33 && QueueNotification.needsPermission(this)) {
            requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, REQUEST_NOTIFICATIONS);
        } else {
            finishAndRemoveTask();
        }
    }

    @Override
    public void onRequestPermissionsResult(
        int requestCode,
        @NonNull String[] permissions,
        @NonNull int[] grantResults
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQUEST_NOTIFICATIONS) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                QueueNotification.refresh(getApplicationContext());
            } else {
                Toast.makeText(
                    this,
                    "Gallery queue notification disabled; links will still retry",
                    Toast.LENGTH_LONG
                ).show();
            }
            finishAndRemoveTask();
        }
    }


}
