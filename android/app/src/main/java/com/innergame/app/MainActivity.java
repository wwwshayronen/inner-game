package com.innergame.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.database.ContentObserver;
import android.database.Cursor;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.Build;
import android.os.Bundle;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewClientCompat;
import androidx.work.Data;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.concurrent.TimeUnit;

import org.json.JSONObject;

public final class MainActivity extends Activity {
    private static final int NOTIFICATION_PERMISSION_REQUEST = 42;
    private static final int MEDIA_PERMISSION_REQUEST = 43;
    private static final int MAX_BREAK_REMINDERS = 24;
    private WebView webView;
    private String pendingScreenshotDataUrl;
    private boolean autoScreenshotEnabled = true;
    private ContentObserver screenshotObserver;
    private String lastScreenshotUri = "";
    private long lastScreenshotHandledAt = 0L;

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
        WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView.setWebViewClient(new WebViewClientCompat() {
            @Override
            public android.webkit.WebResourceResponse shouldInterceptRequest(
                    WebView view,
                    android.webkit.WebResourceRequest request
            ) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                dispatchPendingScreenshot();
            }
        });
        handleIncomingIntent(getIntent());
        webView.loadUrl("https://appassets.androidplatform.net/assets/www/index.html");
    }

    private void handleIncomingIntent(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        String type = intent.getType();
        if (type == null || !type.startsWith("image/")) return;

        Uri uri;
        if (Build.VERSION.SDK_INT >= 33) {
            uri = intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
        } else {
            //noinspection deprecation
            uri = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        }
        if (uri == null) return;

        try (InputStream input = getContentResolver().openInputStream(uri);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            if (input == null) return;
            byte[] buffer = new byte[8192];
            int read;
            int total = 0;
            while ((read = input.read(buffer)) != -1) {
                total += read;
                if (total > 14_000_000) throw new IllegalArgumentException("Screenshot too large");
                output.write(buffer, 0, read);
            }
            String mime = getContentResolver().getType(uri);
            if (mime == null || !mime.startsWith("image/")) mime = "image/png";
            pendingScreenshotDataUrl = "data:" + mime + ";base64," +
                    Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP);
            dispatchPendingScreenshot();
        } catch (Exception error) {
            Toast.makeText(this, "Could not import screenshot", Toast.LENGTH_SHORT).show();
        }
    }

    private void dispatchPendingScreenshot() {
        if (pendingScreenshotDataUrl == null) return;
        final String dataUrl = pendingScreenshotDataUrl;
        dispatchScreenshotData(dataUrl, "android_share", () -> pendingScreenshotDataUrl = null);
    }

    private void dispatchScreenshotData(String dataUrl, String source, Runnable onAccepted) {
        if (webView == null || dataUrl == null) return;
        webView.post(() -> webView.evaluateJavascript(
                "(function(){if(window.innerGameReceiveScreenshot){window.innerGameReceiveScreenshot(" +
                        JSONObject.quote(dataUrl) + "," + JSONObject.quote(source) + ");return true;}return false;})()",
                result -> {
                    if ("true".equals(result) && onAccepted != null) onAccepted.run();
                }
        ));
    }

    private boolean hasMediaReadPermission() {
        if (Build.VERSION.SDK_INT >= 33) {
            return checkSelfPermission(Manifest.permission.READ_MEDIA_IMAGES) == PackageManager.PERMISSION_GRANTED;
        }
        return checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
    }

    private void requestMediaPermissionIfNeeded() {
        if (hasMediaReadPermission()) {
            registerScreenshotObserver();
            return;
        }
        if (Build.VERSION.SDK_INT >= 33) {
            requestPermissions(new String[]{Manifest.permission.READ_MEDIA_IMAGES}, MEDIA_PERMISSION_REQUEST);
        } else {
            requestPermissions(new String[]{Manifest.permission.READ_EXTERNAL_STORAGE}, MEDIA_PERMISSION_REQUEST);
        }
    }

    private void setAutoScreenshotEnabled(boolean enabled) {
        autoScreenshotEnabled = enabled;
        if (!enabled) {
            unregisterScreenshotObserver();
            return;
        }
        requestMediaPermissionIfNeeded();
    }

    private void registerScreenshotObserver() {
        if (!autoScreenshotEnabled || screenshotObserver != null || !hasMediaReadPermission()) return;
        screenshotObserver = new ContentObserver(new Handler(Looper.getMainLooper())) {
            @Override
            public void onChange(boolean selfChange, Uri uri) {
                super.onChange(selfChange, uri);
                if (!autoScreenshotEnabled || uri == null) return;
                inspectScreenshotUri(uri);
            }
        };
        getContentResolver().registerContentObserver(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
                true,
                screenshotObserver
        );
    }

    private void unregisterScreenshotObserver() {
        if (screenshotObserver == null) return;
        try { getContentResolver().unregisterContentObserver(screenshotObserver); } catch (Exception ignored) {}
        screenshotObserver = null;
    }

    private boolean looksLikeScreenshot(String name, String relativePath) {
        String hay = ((name == null ? "" : name) + " " + (relativePath == null ? "" : relativePath)).toLowerCase();
        return hay.contains("screenshot") || hay.contains("screen shot") || hay.contains("screen_shot")
                || hay.contains("screenshots") || hay.contains("screencapture");
    }

    private void inspectScreenshotUri(Uri uri) {
        final String uriText = uri.toString();
        long now = System.currentTimeMillis();
        if (uriText.equals(lastScreenshotUri) && now - lastScreenshotHandledAt < 5000L) return;

        String[] projection = Build.VERSION.SDK_INT >= 29
                ? new String[]{MediaStore.Images.Media.DISPLAY_NAME, MediaStore.Images.Media.RELATIVE_PATH, MediaStore.Images.Media.DATE_ADDED}
                : new String[]{MediaStore.Images.Media.DISPLAY_NAME, MediaStore.Images.Media.DATE_ADDED};
        try (Cursor cursor = getContentResolver().query(uri, projection, null, null, null)) {
            if (cursor == null || !cursor.moveToFirst()) return;
            String name = cursor.getString(0);
            String relativePath = Build.VERSION.SDK_INT >= 29 ? cursor.getString(1) : "";
            long dateAddedSeconds = cursor.getLong(Build.VERSION.SDK_INT >= 29 ? 2 : 1);
            if (!looksLikeScreenshot(name, relativePath)) return;
            if (dateAddedSeconds > 0 && Math.abs((System.currentTimeMillis() / 1000L) - dateAddedSeconds) > 30L) return;
        } catch (Exception ignored) {
            return;
        }

        lastScreenshotUri = uriText;
        lastScreenshotHandledAt = now;
        new Thread(() -> {
            try {
                String dataUrl = readImageDataUrl(uri);
                if (dataUrl != null) dispatchScreenshotData(dataUrl, "android_auto", null);
            } catch (Exception ignored) {}
        }, "innergame-screenshot-import").start();
    }

    private String readImageDataUrl(Uri uri) throws Exception {
        try (InputStream input = getContentResolver().openInputStream(uri);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            if (input == null) return null;
            byte[] buffer = new byte[8192];
            int read, total = 0;
            while ((read = input.read(buffer)) != -1) {
                total += read;
                if (total > 14_000_000) return null;
                output.write(buffer, 0, read);
            }
            String mime = getContentResolver().getType(uri);
            if (mime == null || !mime.startsWith("image/")) mime = "image/png";
            return "data:" + mime + ";base64," + Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == MEDIA_PERMISSION_REQUEST && grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            registerScreenshotObserver();
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIncomingIntent(intent);
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

        @JavascriptInterface
        public void captureHand(String payload) {
            runOnUiThread(() -> Toast.makeText(
                    MainActivity.this,
                    "Take a screenshot — Inner Game will detect poker hands automatically. Share also works.",
                    Toast.LENGTH_LONG
            ).show());
        }

        @JavascriptInterface
        public void setAutoScreenshotEnabled(String payload) {
            boolean enabled = true;
            try { enabled = new JSONObject(payload).optBoolean("enabled", true); } catch (Exception ignored) {}
            final boolean finalEnabled = enabled;
            runOnUiThread(() -> MainActivity.this.setAutoScreenshotEnabled(finalEnabled));
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null) webView.evaluateJavascript("history.back()", null);
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        unregisterScreenshotObserver();
        if (webView != null) {
            webView.removeJavascriptInterface("InnerGameNative");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
