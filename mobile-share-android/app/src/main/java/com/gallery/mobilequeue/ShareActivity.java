package com.gallery.mobilequeue;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.widget.Toast;

import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class ShareActivity extends Activity {
    private static final Pattern URL_PATTERN = Pattern.compile("https?://[^\\s]+", Pattern.CASE_INSENSITIVE);
    private static final String QUEUE_NAME = "gallery-share-upload-queue";

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

        enqueue(matcher.group());
        Toast.makeText(this, "Queued for Gallery", Toast.LENGTH_SHORT).show();
        finishAndRemoveTask();
    }

    private void enqueue(String link) {
        Data input = new Data.Builder()
            .putString(QueueUploadWorker.INPUT_URL, link)
            .build();

        Constraints constraints = new Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build();

        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(QueueUploadWorker.class)
            .setInputData(input)
            .setConstraints(constraints)
            .addTag(QUEUE_NAME)
            .build();

        // APPEND_OR_REPLACE creates a persistent, serial queue. A second or third
        // share can be accepted immediately while earlier uploads are still running.
        WorkManager.getInstance(getApplicationContext())
            .beginUniqueWork(QUEUE_NAME, ExistingWorkPolicy.APPEND_OR_REPLACE, request)
            .enqueue();
    }
}
