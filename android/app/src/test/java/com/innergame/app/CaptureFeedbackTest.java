package com.innergame.app;

import android.Manifest;
import android.app.Application;
import android.app.Notification;
import android.app.NotificationManager;
import android.content.Context;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import java.lang.reflect.Method;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = {28, 35})
public class CaptureFeedbackTest {
    private ActivityController<MainActivity> controller;
    private MainActivity activity;
    private NotificationManager manager;
    @Before public void setup() {
        controller=Robolectric.buildActivity(MainActivity.class).create();activity=controller.get();
        Shadows.shadowOf((Application)activity.getApplication()).grantPermissions(Manifest.permission.POST_NOTIFICATIONS);
        manager=(NotificationManager)activity.getSystemService(Context.NOTIFICATION_SERVICE);manager.cancelAll();
    }
    @After public void cleanup(){manager.cancelAll();controller.destroy();}
    private void notify(String method,String id) throws Exception {
        Method callback=MainActivity.class.getDeclaredMethod(method,String.class);callback.setAccessible(true);callback.invoke(activity,id);
    }
    private Notification progress(String id){return Shadows.shadowOf(manager).getNotification(HandJobNotifications.progressId(id));}
    @Test public void detectionIsVisibleBeforeProcessingAndQueueUpdatesTheSameNotification() throws Exception {
        notify("notifyAutoCaptureDetected","capture-one");
        Notification first=progress("capture-one");assertNotNull(first);
        assertEquals("Screenshot captured",first.extras.getString(Notification.EXTRA_TITLE));
        assertTrue(first.extras.getString(Notification.EXTRA_TEXT).contains("Processing"));
        assertTrue((first.flags&Notification.FLAG_ONGOING_EVENT)!=0);
        notify("notifyAutoCaptureQueued","capture-one");
        assertEquals(1,Shadows.shadowOf(manager).size());
        Notification queued=progress("capture-one");
        assertTrue(queued.extras.getString(Notification.EXTRA_TEXT).contains("processing"));
        assertTrue((queued.flags&Notification.FLAG_ONLY_ALERT_ONCE)!=0);
        JSONObject job=new JSONObject().put("requestId","capture-one").put("handId","capture-one").put("kind","analysis")
            .put("status","complete").put("result",new JSONObject().put("isPokerHand",true));
        HandJobNotifications.show(activity,job,true);
        assertNull(progress("capture-one"));assertEquals(1,Shadows.shadowOf(manager).size());
    }
    @Test public void readFailureReplacesProcessingAndDoesNotLeaveAnOngoingSpinner() throws Exception {
        notify("notifyAutoCaptureDetected","bad-image");notify("notifyAutoCaptureReadFailed","bad-image");
        Notification failure=progress("bad-image");assertNotNull(failure);
        assertEquals("Screenshot capture failed",failure.extras.getString(Notification.EXTRA_TITLE));
        assertEquals(0,failure.flags&Notification.FLAG_ONGOING_EVENT);
        assertEquals(1,Shadows.shadowOf(manager).size());
    }
}
