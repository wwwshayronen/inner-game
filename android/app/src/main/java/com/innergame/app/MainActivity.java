package com.innergame.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.work.Data;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;

import java.util.concurrent.TimeUnit;

import org.json.JSONObject;

public final class MainActivity extends Activity {
    private static final int NOTIFICATION_PERMISSION_REQUEST = 42;
    private static final int MAX_BREAK_REMINDERS = 24;
    private WebView webView;

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccess(true);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);

        createNotificationChannel();
        webView.addJavascriptInterface(new NativeBridge(), "InnerGameNative");
        webView.setWebViewClient(new WebViewClient());
        webView.loadUrl("file:///android_asset/www/index.html");
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
                BreakReminderReceiver.CHANNEL_ID,
                "Session break reminders",
                NotificationManager.IMPORTANCE_HIGH
        );
        channel.enableVibration(true);
        channel.setVibrationPattern(new long[]{0, 500, 250, 500, 250, 800});
        manager.createNotificationChannel(channel);
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_PERMISSION_REQUEST);
        }
    }

    private String breakWorkName(int index) {
        return "innergame-session-break-" + index;
    }

    private void scheduleBreaks(String payload) {
        requestNotificationPermissionIfNeeded();
        cancelBreaks();

        long startedAt = System.currentTimeMillis();
        int intervalMinutes = 60;
        int breakMinutes = 5;
        try {
            JSONObject data = new JSONObject(payload);
            startedAt = data.optLong("startedAt", startedAt);
            intervalMinutes = Math.max(1, data.optInt("intervalMinutes", 60));
            breakMinutes = Math.max(1, data.optInt("breakMinutes", 5));
        } catch (Exception ignored) {}

        long intervalMs = intervalMinutes * 60_000L;
        long now = System.currentTimeMillis();
        WorkManager workManager = WorkManager.getInstance(getApplicationContext());

        // Schedule each reminder in Android's persistent native job scheduler.
        // These jobs survive the Activity/WebView process being killed and device reboot.
        for (int i = 0; i < MAX_BREAK_REMINDERS; i++) {
            long triggerAt = startedAt + (long) (i + 1) * intervalMs;
            long delayMs = triggerAt - now;
            if (delayMs <= 0) continue;

            Data input = new Data.Builder()
                    .putInt("breakNumber", i + 1)
                    .putInt("breakMinutes", breakMinutes)
                    .build();

            OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(BreakReminderWorker.class)
                    .setInitialDelay(delayMs, TimeUnit.MILLISECONDS)
                    .setInputData(input)
                    .addTag("innergame-session-breaks")
                    .build();

            workManager.enqueueUniqueWork(
                    breakWorkName(i),
                    androidx.work.ExistingWorkPolicy.REPLACE,
                    request
            );
        }
    }

    private void cancelBreaks() {
        WorkManager workManager = WorkManager.getInstance(getApplicationContext());
        workManager.cancelAllWorkByTag("innergame-session-breaks");
        for (int i = 0; i < MAX_BREAK_REMINDERS; i++) {
            workManager.cancelUniqueWork(breakWorkName(i));
        }
    }

    private final class NativeBridge {
        @JavascriptInterface
        public void scheduleBreakReminders(String payload) {
            runOnUiThread(() -> scheduleBreaks(payload));
        }

        @JavascriptInterface
        public void cancelBreakReminders(String payload) {
            runOnUiThread(MainActivity.this::cancelBreaks);
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null) webView.evaluateJavascript("history.back()", null);
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.removeJavascriptInterface("InnerGameNative");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
