package com.gallery.mobilequeue;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public class QueueUploadWorker extends Worker {
    public static final String INPUT_URL = "shared_url";

    public QueueUploadWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        String link = getInputData().getString(INPUT_URL);
        if (link == null || link.trim().isEmpty()) {
            return Result.failure();
        }

        HttpURLConnection connection = null;
        try {
            JSONObject body = new JSONObject()
                .put("action", "append")
                .put("token", QueueConfig.TOKEN)
                .put("url", link);

            connection = (HttpURLConnection) new URL(QueueConfig.ENDPOINT).openConnection();
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);
            connection.setConnectTimeout(12000);
            connection.setReadTimeout(12000);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");

            try (OutputStream out = connection.getOutputStream()) {
                out.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }

            int status = connection.getResponseCode();
            if (status >= 200 && status < 300) {
                return Result.success();
            }

            // Retry temporary server/network failures. Permanent client errors are
            // failed so they do not block every later item in the serial chain.
            if (status == 408 || status == 429 || status >= 500) {
                return Result.retry();
            }
            return Result.failure();
        } catch (Exception error) {
            return Result.retry();
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }
}
