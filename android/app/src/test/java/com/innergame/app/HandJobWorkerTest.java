package com.innergame.app;

import android.app.Notification;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import androidx.test.core.app.ApplicationProvider;
import androidx.work.Data;
import androidx.work.ListenableWorker;
import androidx.work.testing.TestWorkerBuilder;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.BeforeClass;
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
import java.net.URLConnection;
import java.net.URLStreamHandler;
import java.nio.charset.StandardCharsets;
import java.security.cert.Certificate;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.net.ssl.HttpsURLConnection;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 28)
public class HandJobWorkerTest {
    private static final ArrayDeque<Reply> replies = new ArrayDeque<>();
    private static final List<String> routes = new ArrayList<>();
    private static final List<JSONObject> requests = new ArrayList<>();
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
    @BeforeClass public static void network() {
        URL.setURLStreamHandlerFactory(protocol -> "https".equals(protocol) ? new URLStreamHandler() {
            @Override protected URLConnection openConnection(URL url) { return new Connection(url); }
        } : null);
    }
    @Before public void setup() {
        context = ApplicationProvider.getApplicationContext();
        executor = Executors.newSingleThreadExecutor();
        notifications = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        HandJobStore.removeAll(context);
        notifications.cancelAll();replies.clear();routes.clear();requests.clear();
    }
    @After public void cleanup() { HandJobStore.removeAll(context); executor.shutdownNow(); }
    private JSONObject save(String id, String kind) throws Exception {
        JSONObject job = new JSONObject().put("requestId",id).put("handId","hand-one").put("kind",kind)
                .put("status","pending").put("createdAt",System.currentTimeMillis())
                .put("apiBase","https://test.invalid").put("payload",new JSONObject().put("spot",new JSONObject()));
        HandJobStore.write(context,job,true);return job;
    }
    private ListenableWorker.Result run(String id) {
        HandJobWorker worker = TestWorkerBuilder.from(context,HandJobWorker.class,executor)
                .setInputData(new Data.Builder().putString("requestId",id).build()).build();
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
        opens(ready("solve"),"solverResult");assertEquals("GTO solution ready",ready("solve").extras.getString(Notification.EXTRA_TITLE));
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
}
