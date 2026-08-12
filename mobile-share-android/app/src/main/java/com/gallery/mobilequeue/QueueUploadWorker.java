package com.gallery.mobilequeue;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.SystemClock;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.SocketException;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.locks.ReentrantLock;

public class QueueUploadWorker extends Worker {
    public static final String INPUT_URL = "shared_url";

    private static final int CONNECT_TIMEOUT_MS = 6000;
    private static final int READ_TIMEOUT_MS = 15000;
    // Keep transient recovery inside the current Worker long enough to ride out
    // brief Android DNS/default-route failures instead of making the user press
    // Retry. There are 8 attempts total: initial, then the delays below.
    private static final long[] TRANSIENT_RETRY_DELAYS_MS = {
        3000L, 5000L, 8000L, 13000L, 21000L, 30000L, 30000L
    };
    private static final long BETWEEN_ITEMS_DELAY_MS = 900L;

    // WorkManager REPLACE/cancellation is not guaranteed to abort an already
    // blocking socket instantly. Keep the actual mobile queue drain single-flight
    // even if two Worker instances briefly coexist during a manual retry.
    private static final ReentrantLock DRAIN_LOCK = new ReentrantLock();

    private static final class UploadResult {
        final boolean ok;
        final String error;
        final boolean transientFailure;
        final boolean dnsFailure;

        UploadResult(boolean ok, String error, boolean transientFailure, boolean dnsFailure) {
            this.ok = ok;
            this.error = error;
            this.transientFailure = transientFailure;
            this.dnsFailure = dnsFailure;
        }

        static UploadResult success() {
            return new UploadResult(true, null, false, false);
        }

        static UploadResult failure(String error, boolean transientFailure) {
            return new UploadResult(false, error, transientFailure, false);
        }

        static UploadResult dnsFailure(String error) {
            return new UploadResult(false, error, true, true);
        }
    }

    public QueueUploadWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();

        // Migration safety: work scheduled by an older app version may still
        // carry the URL only in WorkManager input data. Persist it before doing
        // anything network-related.
        String inputLink = getInputData().getString(INPUT_URL);
        if (inputLink != null && !inputLink.trim().isEmpty()) {
            if (!PendingQueueStore.add(context, inputLink.trim())) {
                PendingQueueStore.setLastUploadError(context, "Could not persist the local queue");
                return Result.retry();
            }
        }

        boolean drainLockHeld = false;
        try {
            // Prevent overlapping mobile requests even during the brief window
            // where WorkManager is cancelling/replacing a Worker.
            DRAIN_LOCK.lockInterruptibly();
            drainLockHeld = true;

            PendingQueueStore.markUploadRunning(context);
            QueueNotification.refresh(context);

            while (!isStopped()) {
                String link = PendingQueueStore.peek(context);
                if (link == null) {
                    PendingQueueStore.clearLastUploadError(context);
                    QueueNotification.refresh(context);
                    return Result.success();
                }

                UploadResult upload = uploadWithImmediateRetries(context, link);
                if (!upload.ok) {
                    // If the user pressed Retry during a live bounded request,
                    // consume that signal here and start a fresh burst without
                    // replacing this Worker or creating a second live socket.
                    if (upload.transientFailure && PendingQueueStore.consumeImmediateRetry(context)) {
                        PendingQueueStore.setLastUploadError(context, "Retrying now after: " + upload.error);
                        QueueNotification.refresh(context);
                        continue;
                    }

                    // Never remove the URL on failure. WorkManager provides the
                    // longer backoff after our small burst of transient retries.
                    PendingQueueStore.setLastUploadError(context, upload.error);
                    QueueNotification.refresh(context);
                    return Result.retry();
                }

                // Remove only after the server explicitly returned {"ok": true}.
                // If local persistence fails here, keeping it causes a harmless
                // duplicate retry; the Apps Script deduplicates by URL.
                if (!PendingQueueStore.remove(context, link)) {
                    PendingQueueStore.setLastUploadError(context, "Server accepted the link, but local cleanup failed");
                    QueueNotification.refresh(context);
                    return Result.retry();
                }

                PendingQueueStore.clearImmediateRetry(context);
                PendingQueueStore.clearLastUploadError(context);
                QueueNotification.refresh(context);

                // Avoid hammering Apps Script/Drive with an immediate burst when
                // several links were shared at once. The previous request is done,
                // but a small pacing gap also gives Google-side services breathing
                // room and makes transient throttling less likely.
                if (!isStopped() && PendingQueueStore.size(context) > 0) {
                    SystemClock.sleep(BETWEEN_ITEMS_DELAY_MS);
                }
            }

            return Result.retry();
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            return Result.retry();
        } finally {
            PendingQueueStore.clearUploadRunning(context);
            QueueNotification.refresh(context);
            if (drainLockHeld) {
                DRAIN_LOCK.unlock();
            }
        }
    }

    private UploadResult uploadWithImmediateRetries(Context context, String link) {
        UploadResult last = performAttempt(context, link);
        if (last.ok || !last.transientFailure) {
            return last;
        }

        int totalAttempts = TRANSIENT_RETRY_DELAYS_MS.length + 1;
        for (int i = 0; i < TRANSIENT_RETRY_DELAYS_MS.length && !isStopped(); i++) {
            long delayMs = TRANSIENT_RETRY_DELAYS_MS[i];
            int nextAttempt = i + 2;
            String prefix = last.dnsFailure
                ? "DNS unavailable"
                : "Network/Google connection unavailable";
            PendingQueueStore.setLastUploadError(
                context,
                prefix + "; retrying automatically in " + formatDelay(delayMs)
                    + " (" + nextAttempt + "/" + totalAttempts + "): " + last.error
            );
            QueueNotification.refresh(context);

            waitForRetryDelay(context, delayMs);
            if (isStopped()) {
                break;
            }

            last = performAttempt(context, link);
            if (last.ok || !last.transientFailure) {
                return last;
            }
        }

        return UploadResult.failure(
            last.error + " (kept locally; automatic retry will continue)",
            true
        );
    }

    private UploadResult performAttempt(Context context, String link) {
        PendingQueueStore.markUploadRunning(context);
        if (getValidatedNetwork(context) == null) {
            return UploadResult.failure("Waiting for a validated internet connection", true);
        }

        // Do NOT pin the HTTP socket to the Network snapshot returned above.
        // URL.openConnection() uses Android's current default route, so a fresh
        // retry can follow Wi-Fi/mobile/VPN failover instead of remaining stuck
        // on a Network object that has just degraded or disconnected.
        return uploadOnce(link);
    }

    /**
     * Wait in short slices so the notification Retry button can wake the current
     * worker without REPLACE/cancelling a socket. The retry-request flag is
     * consumed here and simply short-circuits the remaining delay.
     */
    private void waitForRetryDelay(Context context, long delayMs) {
        long deadline = SystemClock.elapsedRealtime() + delayMs;
        Network startingNetwork = getActiveNetwork(context);
        boolean startingValidated = isValidatedNetwork(context, startingNetwork);

        while (!isStopped()) {
            // Keep the worker heartbeat fresh during long recovery delays so
            // the notification Retry action never mistakes a sleeping live
            // worker for WorkManager backoff and REPLACEs it.
            PendingQueueStore.markUploadRunning(context);

            if (PendingQueueStore.consumeImmediateRetry(context)) {
                PendingQueueStore.setLastUploadError(context, "Retry requested; trying now…");
                QueueNotification.refresh(context);
                return;
            }

            Network currentNetwork = getActiveNetwork(context);
            boolean currentValidated = isValidatedNetwork(context, currentNetwork);
            boolean networkChanged = !sameNetwork(startingNetwork, currentNetwork);
            boolean becameValidated = !startingValidated && currentValidated;
            if (networkChanged || becameValidated) {
                PendingQueueStore.setLastUploadError(context, "Network changed; retrying now…");
                QueueNotification.refresh(context);
                return;
            }

            long remaining = deadline - SystemClock.elapsedRealtime();
            if (remaining <= 0L) {
                return;
            }
            SystemClock.sleep(Math.min(250L, remaining));
        }
    }

    private static Network getActiveNetwork(Context context) {
        try {
            ConnectivityManager manager =
                (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
            return manager == null ? null : manager.getActiveNetwork();
        } catch (Exception ignored) {
            return null;
        }
    }

    private static boolean isValidatedNetwork(Context context, Network network) {
        if (network == null) {
            return false;
        }
        try {
            ConnectivityManager manager =
                (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (manager == null) {
                return false;
            }
            NetworkCapabilities capabilities = manager.getNetworkCapabilities(network);
            return capabilities != null
                && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
        } catch (Exception ignored) {
            return false;
        }
    }

    private static boolean sameNetwork(Network a, Network b) {
        return a == b || (a != null && a.equals(b));
    }

    private static String formatDelay(long delayMs) {
        long seconds = Math.max(1L, (delayMs + 999L) / 1000L);
        return seconds + (seconds == 1L ? " second" : " seconds");
    }

    private static Network getValidatedNetwork(Context context) {
        Network active = getActiveNetwork(context);
        return isValidatedNetwork(context, active) ? active : null;
    }

    private UploadResult uploadOnce(String link) {
        HttpURLConnection connection = null;
        try {
            JSONObject body = new JSONObject()
                .put("action", "append")
                .put("token", QueueConfig.TOKEN)
                .put("url", link);
            byte[] bodyBytes = body.toString().getBytes(StandardCharsets.UTF_8);

            URL endpoint = new URL(QueueConfig.ENDPOINT);
            // Use the process/default Android network. Do not pin this socket
            // to a captured Network object: a retry should be able to follow a
            // newer default route after Wi-Fi/mobile/VPN hand-off.
            connection = (HttpURLConnection) endpoint.openConnection();
            connection.setRequestMethod("POST");
            connection.setDoOutput(true);

            // Apps Script ContentService deliberately returns a redirect to a
            // one-time script.googleusercontent.com URL. Handle it ourselves so
            // POST semantics and failures in each stage are observable instead
            // of being hidden inside HttpURLConnection's redirect machinery.
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setUseCaches(false);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Cache-Control", "no-cache");

            try (OutputStream out = connection.getOutputStream()) {
                out.write(bodyBytes);
            }

            int status = connection.getResponseCode();
            if (isRedirect(status)) {
                String location = connection.getHeaderField("Location");
                if (location == null || location.trim().isEmpty()) {
                    return UploadResult.failure(
                        "Queue server returned HTTP " + status + " without a redirect target",
                        true
                    );
                }
                URL redirectUrl = new URL(endpoint, location);
                connection.disconnect();
                connection = null;
                return readContentRedirect(redirectUrl);
            }

            String responseText = readResponse(connection, status);
            if (status < 200 || status >= 300) {
                return httpFailure("Queue server", endpoint, status);
            }
            return parseQueueResponse(responseText);
        } catch (Exception error) {
            return exceptionFailure(error);
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    /** Follow Apps Script's one-time ContentService response URL as GET. */
    private UploadResult readContentRedirect(URL initialUrl) {
        URL current = initialUrl;
        for (int hop = 0; hop < 4; hop++) {
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) current.openConnection();
                connection.setRequestMethod("GET");
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
                connection.setReadTimeout(READ_TIMEOUT_MS);
                connection.setUseCaches(false);
                connection.setRequestProperty("Accept", "application/json");
                connection.setRequestProperty("Cache-Control", "no-cache");
    
                int status = connection.getResponseCode();
                if (isRedirect(status)) {
                    String location = connection.getHeaderField("Location");
                    if (location == null || location.trim().isEmpty()) {
                        return UploadResult.failure(
                            "Queue redirect returned HTTP " + status + " without a target at " + current.getHost(),
                            true
                        );
                    }
                    URL next = new URL(current, location);
                    connection.disconnect();
                    connection = null;
                    current = next;
                    continue;
                }

                String responseText = readResponse(connection, status);
                if (status < 200 || status >= 300) {
                    return httpFailure("Queue redirect", current, status);
                }
                return parseQueueResponse(responseText);
            } catch (Exception error) {
                return exceptionFailure(error);
            } finally {
                if (connection != null) {
                    connection.disconnect();
                }
            }
        }
        return UploadResult.failure("Too many queue response redirects", true);
    }

    private static UploadResult parseQueueResponse(String responseText) {
        if (responseText == null || responseText.trim().isEmpty()) {
            return UploadResult.failure("Queue server returned an empty response", true);
        }

        try {
            JSONObject response = new JSONObject(responseText);
            if (response.optBoolean("ok", false)) {
                return UploadResult.success();
            }
            String serverError = response.optString("error", "Queue server rejected the link");
            boolean retry = response.optBoolean("retry", false) || "Busy".equalsIgnoreCase(serverError);
            return UploadResult.failure(serverError, retry);
        } catch (Exception jsonError) {
            // A deployment/access mistake can return a Google sign-in or error
            // HTML page instead of our JSON response.
            String compact = responseText.replaceAll("\\s+", " ").trim();
            if (compact.length() > 120) {
                compact = compact.substring(0, 120) + "…";
            }
            return UploadResult.failure("Invalid queue response: " + compact, false);
        }
    }

    private static UploadResult httpFailure(String stage, URL url, int status) {
        String host = url == null ? "unknown host" : url.getHost();
        return UploadResult.failure(
            stage + " HTTP " + status + " at " + host,
            isTransientHttpStatus(status)
        );
    }

    private static boolean isRedirect(int status) {
        return status == HttpURLConnection.HTTP_MOVED_PERM
            || status == HttpURLConnection.HTTP_MOVED_TEMP
            || status == HttpURLConnection.HTTP_SEE_OTHER
            || status == 307
            || status == 308;
    }

    private static boolean isTransientHttpStatus(int status) {
        // 404 is normally permanent, but this queue has demonstrated intermittent
        // 404s from the Google web-app/redirect path that succeed on a manual retry.
        return status == 404
            || status == 408
            || status == 425
            || status == 429
            || status >= 500;
    }

    private static UploadResult exceptionFailure(Exception error) {
        String message = error.getMessage();
        if (message == null || message.trim().isEmpty()) {
            message = error.getClass().getSimpleName();
        }

        boolean transientFailure = error instanceof UnknownHostException
            || error instanceof SocketTimeoutException
            || error instanceof ConnectException
            || error instanceof SocketException
            || error instanceof IOException;

        String kind;
        if (error instanceof UnknownHostException) {
            kind = "DNS failure";
        } else if (error instanceof SocketTimeoutException) {
            String lower = message.toLowerCase();
            kind = lower.contains("connect") ? "Connection timeout" : "Response timeout";
        } else if (error instanceof ConnectException) {
            kind = "Connection failure";
        } else {
            kind = "Upload failed";
        }

        if (error instanceof UnknownHostException) {
            return UploadResult.dnsFailure(kind + ": " + message);
        }
        return UploadResult.failure(kind + ": " + message, transientFailure);
    }

    private static String readResponse(HttpURLConnection connection, int status) throws Exception {
        InputStream stream = status >= 200 && status < 400
            ? connection.getInputStream()
            : connection.getErrorStream();
        return readFully(stream);
    }

    private static String readFully(InputStream stream) throws Exception {
        if (stream == null) {
            return "";
        }
        StringBuilder result = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(
            new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) {
                result.append(line);
            }
        }
        return result.toString().trim();
    }
}
