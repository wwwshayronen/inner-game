package com.innergame.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import org.json.JSONObject;

final class HandJobNotifications {
    private static final String CHANNEL = "hand_results_v1";
    private HandJobNotifications() {}
    static int progressId(String id) { return 12000 + (id.hashCode() & 0x3fffffff); }
    static Notification notification(Context context, JSONObject job, boolean ready) {
        String kind = job.optString("kind"), handId = job.optString("handId"), id = job.optString("requestId");
        boolean failed = "failed".equals(job.optString("status"));
        String view = kind.equals("solve") ? "solverResult" : kind.equals("reconstruction") ? "solverReview" : "handDetail";
        String title = kind.equals("solve") ? "GTO solution" : kind.equals("reconstruction") ? "Hand reconstruction" : "Hand analysis";
        String body = ready ? "Tap to open your hand." : "Processing your hand. You can leave Inner Game.";
        if (failed) body = job.optJSONObject("error") == null ? "Tap to review and retry." : job.optJSONObject("error").optString("message", "Tap to review and retry.");
        JSONObject result = job.optJSONObject("result");
        boolean needsReview = kind.equals("reconstruction") && result != null && !result.optBoolean("ready", true);
        boolean unrecognized = kind.equals("analysis") && result != null && !result.optBoolean("isPokerHand", true);
        title += ready ? (failed || needsReview || unrecognized ? " needs attention" : " ready") : " running";
        if (needsReview) body = "The hand is reconstructed. Tap to review the missing details.";
        if (unrecognized) body = "A poker hand could not be recognized. Tap to review your screenshot.";
        Intent open = new Intent(context, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .setData(Uri.parse("innergame://hand/" + Uri.encode(handId) + "/" + view + "/" + Uri.encode(id)))
                .putExtra("handId", handId).putExtra("handView", view);
        PendingIntent pending = PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26 && manager != null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL, "Hand results", NotificationManager.IMPORTANCE_DEFAULT);
            channel.setDescription("Completed solver results and reconstructed poker hands.");
            manager.createNotificationChannel(channel);
        }
        return new Notification.Builder(context, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_menu_info_details)
                .setContentTitle(title).setContentText(body).setStyle(new Notification.BigTextStyle().bigText(body))
                .setContentIntent(pending).setAutoCancel(ready).setOngoing(!ready).setOnlyAlertOnce(!ready)
                .setCategory(Notification.CATEGORY_STATUS).build();
    }
    static void show(Context context, JSONObject job, boolean ready) {
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        String id = job.optString("requestId");
        if (ready) {
            cancelProgress(context, id);
            JSONObject result = job.optJSONObject("result");
            if ("analysis".equals(job.optString("kind")) && "android_auto".equals(job.optString("source")) && result != null && !result.optBoolean("isPokerHand", true)) return;
            manager.notify("hand-job:" + job.optString("kind") + ":" + job.optString("handId"), 1, notification(context, job, true));
        } else manager.notify(progressId(id), notification(context, job, false));
    }
    static void cancelProgress(Context context, String id) {
        NotificationManager manager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.cancel(progressId(id));
    }
}
