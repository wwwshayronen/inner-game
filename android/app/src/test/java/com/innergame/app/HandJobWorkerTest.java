package com.innergame.app;

import android.app.Notification;
import android.app.NotificationManager;
import android.Manifest;
import android.app.Application;
import android.content.pm.ServiceInfo;
import android.content.Context;
import android.content.Intent;
import androidx.test.core.app.ApplicationProvider;
import androidx.work.Data;
import androidx.work.ListenableWorker;
import androidx.work.ForegroundInfo;
import androidx.work.impl.utils.futures.SettableFuture;
import androidx.work.WorkerParameters;
import androidx.work.testing.TestWorkerBuilder;
import androidx.work.testing.TestListenableWorkerBuilder;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.security.cert.Certificate;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import javax.net.ssl.HttpsURLConnection;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public class HandJobWorkerTest {
    private static final ArrayDeque<Reply> replies = new ArrayDeque<>();
    private static final List<String> routes = new ArrayList<>();
    private static final List<JSONObject> requests = new ArrayList<>();
    private static final List<ForegroundInfo> foreground = new ArrayList<>();
    private static RuntimeException foregroundFailure;
    private static Runnable onForeground;
    private static SettableFuture<Void> heldPromotion;
    private static CountDownLatch promotionRequested;
    private Context context;
    private ExecutorService executor;
    private NotificationManager notifications;

    private static final class Reply {
        final int status; final String body;
        Reply(int status, String body) { this.status=status; this.body=body; }
    }
    private static final class Connection extends HttpsURLConnection {
        final ByteArrayOutputStream output = new ByteArrayOutputStream();
        Reply reply;
        Connection(URL url) { super(url); }
        @Override public OutputStream getOutputStream() { return output; }
        @Override public int getResponseCode() throws IOException {
            if (foreground.isEmpty() || heldPromotion!=null&&!heldPromotion.isDone()) throw new AssertionError("Network processing started without an active foreground service");
            routes.add(url.getPath());
            try { requests.add(new JSONObject(new String(output.toByteArray(), StandardCharsets.UTF_8))); }
            catch (Exception error) { throw new IOException(error); }
            reply = replies.remove();
            if (reply.status == -1) throw new IOException("Connection lost after submission");
            return reply.status;
        }
        @Override public InputStream getInputStream() { return new ByteArrayInputStream(reply.body.getBytes(StandardCharsets.UTF_8)); }
        @Override public InputStream getErrorStream() { return getInputStream(); }
        @Override public void disconnect() {}
        @Override public void connect() {}
        @Override public boolean usingProxy() { return false; }
        @Override public String getCipherSuite() { return "test"; }
        @Override public Certificate[] getLocalCertificates() { return new Certificate[0]; }
        @Override public Certificate[] getServerCertificates() { return new Certificate[0]; }
    }
    public static final class TestHandJobWorker extends HandJobWorker {
        public TestHandJobWorker(Context context, WorkerParameters params) { super(context,params); }
        @Override HttpURLConnection openConnection(URL url) { return new Connection(url); }
    }
    @Before public void setup() {
        context = ApplicationProvider.getApplicationContext();
        executor = Executors.newSingleThreadExecutor();
        notifications = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        HandJobStore.removeAll(context);
        notifications.cancelAll();replies.clear();routes.clear();requests.clear();foreground.clear();
        foregroundFailure=null;onForeground=null;heldPromotion=null;promotionRequested=null;
        Shadows.shadowOf((Application)context).grantPermissions(Manifest.permission.POST_NOTIFICATIONS);
    }
    @After public void cleanup() {
        if(heldPromotion!=null&&!heldPromotion.isDone())heldPromotion.setException(new IllegalStateException("Test finished"));
        HandJobStore.removeAll(context);executor.shutdownNow();
    }
    private JSONObject save(String id, String kind) throws Exception {
        JSONObject job = new JSONObject().put("requestId",id).put("handId","hand-one").put("kind",kind)
                .put("status","pending").put("createdAt",System.currentTimeMillis())
                .put("apiBase","https://test.invalid").put("payload",new JSONObject().put("spot",new JSONObject()));
        HandJobStore.write(context,job,true);return job;
    }
    private ListenableWorker.Result run(String id) {
        TestListenableWorkerBuilder<TestHandJobWorker> builder = TestWorkerBuilder.from(context,TestHandJobWorker.class,executor)
                .setInputData(new Data.Builder().putString("requestId",id).build());
        builder.setForegroundUpdater((ctx,uuid,info)->{
            SettableFuture<Void> future=SettableFuture.create();
            if(heldPromotion!=null){foreground.add(info);promotionRequested.countDown();return heldPromotion;}
            if(foregroundFailure!=null)future.setException(foregroundFailure);
            else {
                foreground.add(info);notifications.notify(info.getNotificationId(),info.getNotification());
                if(onForeground!=null)onForeground.run();
                future.set(null);
            }
            return future;
        });
        HandJobWorker worker=builder.build();
        assertEquals(1,worker.getInputData().getKeyValueMap().size());
        return worker.doWork();
    }
    private void reply(int status, String body) { replies.add(new Reply(status,body)); }
    private Notification ready(String kind) { return Shadows.shadowOf(notifications).getNotification("hand-job:"+kind+":hand-one",1); }
    private void opens(Notification notification, String view) {
        assertNotNull(notification);
        Intent intent=Shadows.shadowOf(notification.contentIntent).getSavedIntent();
        assertEquals("hand-one",intent.getStringExtra("handId"));assertEquals(view,intent.getStringExtra("handView"));
    }

    @Test public void solvePersistsResultAndNotificationOpensSolution() throws Exception {
        save("solve-one","solve");
        reply(202,"{\"jobId\":\"server-one\"}");
        reply(200,"{\"status\":\"complete\",\"result\":{\"solution\":{\"ev\":{\"fold\":0}}}}");
        assertEquals(ListenableWorker.Result.success(),run("solve-one"));
        JSONObject stored=HandJobStore.read(context,"solve-one");
        assertEquals("complete",stored.getString("status"));assertEquals(0,stored.getJSONObject("result").getJSONObject("solution").getJSONObject("ev").getInt("fold"));
        org.json.JSONArray trace=stored.getJSONArray("httpTrace");assertEquals(2,trace.length());
        assertEquals(202,trace.getJSONObject(0).getInt("status"));
        assertEquals("solve",trace.getJSONObject(0).getJSONObject("request").getString("kind"));
        assertEquals("server-one",trace.getJSONObject(0).getJSONObject("response").getString("jobId"));
        assertEquals(200,trace.getJSONObject(1).getInt("status"));
        assertEquals("complete",trace.getJSONObject(1).getJSONObject("response").getString("status"));
        opens(ready("solve"),"solverResult");assertEquals("GTO solution ready",ready("solve").extras.getString(Notification.EXTRA_TITLE));
    }
    @Test public void debugPreservesNonJsonFailureAndRedactsScreenshot() throws Exception {
        JSONObject job=save("debug-html","reconstruction");
        job.put("payload",new JSONObject().put("imageDataUrl","data:image/jpeg;base64,private-image"));
        HandJobStore.write(context,job,false);reply(502,"<html>Gateway unavailable</html>");
        assertEquals(ListenableWorker.Result.retry(),run("debug-html"));
        JSONObject event=HandJobStore.read(context,"debug-html").getJSONArray("httpTrace").getJSONObject(0);
        assertEquals(502,event.getInt("status"));assertEquals("<html>Gateway unavailable</html>",event.getString("response"));
        assertEquals("[omitted]",event.getJSONObject("request").getJSONObject("payload").getString("imageDataUrl"));
        assertFalse(event.toString().contains("private-image"));
    }
    @Test public void debugPreservesNetworkFailureAcrossRetry() throws Exception {
        save("debug-offline","solve");reply(-1,"");
        assertEquals(ListenableWorker.Result.retry(),run("debug-offline"));
        JSONObject event=HandJobStore.read(context,"debug-offline").getJSONArray("httpTrace").getJSONObject(0);
        assertEquals(0,event.getInt("status"));assertTrue(event.getString("error").contains("Connection lost"));
        assertEquals("POST",event.getString("method"));
    }
    @Test public void reconstructionMissingDetailsOpensReviewSeparately() throws Exception {
        JSONObject solve=save("first","solve");solve.put("status","complete");
        HandJobNotifications.show(context,solve,true);
        save("second","reconstruction");reply(202,"{\"jobId\":\"server-two\"}");
        reply(200,"{\"status\":\"complete\",\"result\":{\"ready\":false,\"spot\":{\"missingFields\":[\"heroCards\"]}}}");
        assertEquals(ListenableWorker.Result.success(),run("second"));
        opens(ready("solve"),"solverResult");opens(ready("reconstruction"),"solverReview");
        assertNotEquals(ready("solve").contentIntent,ready("reconstruction").contentIntent);
        assertEquals("Hand reconstruction needs attention",ready("reconstruction").extras.getString(Notification.EXTRA_TITLE));
    }
    @Test public void restartedWorkerPollsSavedRemoteJobWithoutResubmitting() throws Exception {
        JSONObject job=save("restart","solve");job.put("serverJobId","saved-server");HandJobStore.write(context,job,false);
        reply(200,"{\"status\":\"complete\",\"result\":{\"solution\":{}}}");
        assertEquals(ListenableWorker.Result.success(),run("restart"));
        assertEquals(1,routes.size());assertEquals("/hand-jobs/poll",routes.get(0));assertEquals("saved-server",requests.get(0).getString("jobId"));
    }
    @Test public void connectionLossRetriesSameRequestIdAndKeepsLargeImageOnDisk() throws Exception {
        JSONObject job=save("same-paid-request","reconstruction");
        StringBuilder image=new StringBuilder("data:image/png;base64,");for(int i=0;i<20000;i++)image.append('a');
        job.put("payload",new JSONObject().put("imageDataUrl",image.toString()));HandJobStore.write(context,job,false);
        reply(-1,"{}");assertEquals(ListenableWorker.Result.retry(),run("same-paid-request"));
        assertEquals("pending",HandJobStore.read(context,"same-paid-request").getString("status"));
        reply(202,"{\"jobId\":\"existing-server\"}");reply(200,"{\"status\":\"complete\",\"result\":{\"ready\":true,\"spot\":{}}}");
        assertEquals(ListenableWorker.Result.success(),run("same-paid-request"));
        assertEquals(requests.get(0).getString("requestId"),requests.get(1).getString("requestId"));
        assertTrue(requests.get(1).getJSONObject("payload").getString("imageDataUrl").length()>10000);
    }
    @Test public void temporaryServiceFailureKeepsRemoteJobForRetry() throws Exception {
        save("retry","solve");reply(202,"{\"jobId\":\"remote\"}");reply(503,"{\"message\":\"temporary\"}");
        assertEquals(ListenableWorker.Result.retry(),run("retry"));
        assertEquals("remote",HandJobStore.read(context,"retry").getString("serverJobId"));
        reply(200,"{\"status\":\"complete\",\"result\":{\"solution\":{}}}");assertEquals(ListenableWorker.Result.success(),run("retry"));
        assertEquals(3,routes.size());assertEquals("/hand-jobs/poll",routes.get(2));
    }
    @Test public void expiredServerJobNotifiesFailureAndPreservesHand() throws Exception {
        JSONObject job=save("expired","reconstruction");job.put("serverJobId","old");HandJobStore.write(context,job,false);
        reply(410,"{\"message\":\"Your screenshot is saved. Tap Retry.\"}");
        assertEquals(ListenableWorker.Result.success(),run("expired"));
        assertEquals("failed",HandJobStore.read(context,"expired").getString("status"));opens(ready("reconstruction"),"solverReview");
        assertEquals("Your screenshot is saved. Tap Retry.",ready("reconstruction").extras.getString(Notification.EXTRA_TEXT));
    }
    @Test public void cancellationPreventsLateResultFromRecreatingJob() throws Exception {
        JSONObject job=save("deleted","solve");HandJobStore.remove(context,"deleted");
        job.put("status","complete");assertFalse(HandJobStore.write(context,job,false));
        assertEquals(ListenableWorker.Result.success(),run("deleted"));assertTrue(routes.isEmpty());assertNull(HandJobStore.read(context,"deleted"));
    }
    @Test public void oldOfflineJobExpiresInsteadOfRetryingForever() throws Exception {
        JSONObject job=save("old-offline","solve");job.put("createdAt",System.currentTimeMillis()-25*60*60_000L);HandJobStore.write(context,job,false);
        assertEquals(ListenableWorker.Result.success(),run("old-offline"));assertTrue(routes.isEmpty());
        assertEquals("failed",HandJobStore.read(context,"old-offline").getString("status"));opens(ready("solve"),"solverResult");
    }
    @Test public void nonPokerAutoCaptureIsQuietButManualImportNotifiesReview() throws Exception {
        JSONObject job=save("not-poker","analysis");job.put("status","complete").put("source","android_auto").put("result",new JSONObject().put("isPokerHand",false));
        HandJobNotifications.show(context,job,true);assertNull(ready("analysis"));
        job.put("source","manual");HandJobNotifications.show(context,job,true);opens(ready("analysis"),"handDetail");
        assertEquals("Hand analysis needs attention",ready("analysis").extras.getString(Notification.EXTRA_TITLE));
    }

    @Test @Config(sdk = 35) public void modernAndroidPromotesPollingBeforeNetworkAndNotifiesWithoutActivity() throws Exception {
        JSONObject job=save("background-api35","solve");job.put("serverJobId","already-submitted");HandJobStore.write(context,job,false);
        reply(200,"{\"status\":\"complete\",\"result\":{\"solution\":{}}}");
        assertEquals(ListenableWorker.Result.success(),run("background-api35"));
        assertEquals(1,foreground.size());
        assertEquals(ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,foreground.get(0).getForegroundServiceType());
        assertEquals("hand_processing_v1",foreground.get(0).getNotification().getChannelId());
        assertEquals(NotificationManager.IMPORTANCE_LOW,notifications.getNotificationChannel("hand_processing_v1").getImportance());
        opens(ready("solve"),"solverResult");
        assertEquals("hand_results_v2",ready("solve").getChannelId());
        assertEquals(NotificationManager.IMPORTANCE_HIGH,notifications.getNotificationChannel("hand_results_v2").getImportance());
        assertNull(Shadows.shadowOf(notifications).getNotification(HandJobNotifications.progressId("background-api35")));
    }
    @Test @Config(sdk = 33) public void android13AlsoRunsInForegroundEvenWhenAlreadySubmitted() throws Exception {
        JSONObject job=save("background-api33","reconstruction");job.put("serverJobId","already-submitted");HandJobStore.write(context,job,false);
        reply(200,"{\"status\":\"complete\",\"result\":{\"ready\":true,\"spot\":{}}}");
        assertEquals(ListenableWorker.Result.success(),run("background-api33"));assertEquals(1,foreground.size());
        assertEquals(ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,foreground.get(0).getForegroundServiceType());
        opens(ready("reconstruction"),"solverReview");
    }
    @Test @Config(sdk = 35) public void rejectedForegroundStartKeepsRequestAndNeverSchedulesPaidWork() throws Exception {
        save("foreground-denied","solve");foregroundFailure=new IllegalStateException("Foreground start temporarily denied");
        assertEquals(ListenableWorker.Result.retry(),run("foreground-denied"));assertTrue(routes.isEmpty());
        JSONObject job=HandJobStore.read(context,"foreground-denied");
        assertEquals("pending",job.getString("status"));assertEquals("foreground",job.getString("lastAttemptStage"));
        assertFalse(job.has("serverJobId"));assertNull(ready("solve"));
    }
    @Test public void cancellationDuringForegroundStartupPreventsSubmission() throws Exception {
        save("cancel-startup","solve");onForeground=()->HandJobStore.remove(context,"cancel-startup");
        assertEquals(ListenableWorker.Result.success(),run("cancel-startup"));assertTrue(routes.isEmpty());
        assertNull(HandJobStore.read(context,"cancel-startup"));assertNull(ready("solve"));
    }
    @Test @Config(sdk = 35) public void networkWaitsUntilForegroundServiceHasActuallyStarted() throws Exception {
        save("await-foreground","solve");heldPromotion=SettableFuture.create();promotionRequested=new CountDownLatch(1);
        reply(202,"{\"jobId\":\"remote\"}");reply(200,"{\"status\":\"complete\",\"result\":{\"solution\":{}}}");
        Future<ListenableWorker.Result> result=executor.submit(()->run("await-foreground"));
        assertTrue(promotionRequested.await(5,TimeUnit.SECONDS));
        assertTrue(routes.isEmpty());assertFalse(result.isDone());
        heldPromotion.set(null);
        assertEquals(ListenableWorker.Result.success(),result.get(5,TimeUnit.SECONDS));
        assertEquals(2,routes.size());opens(ready("solve"),"solverResult");
    }
}

