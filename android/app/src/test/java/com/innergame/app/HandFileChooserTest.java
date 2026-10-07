package com.innergame.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.webkit.WebView;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowActivity;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.List;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = {28, 35})
public class HandFileChooserTest {
    private ActivityController<MainActivity> controller;
    private MainActivity activity;
    private WebView webView;
    private final List<Uri[]> results = new ArrayList<>();

    @Before public void setup() throws Exception {
        controller = Robolectric.buildActivity(MainActivity.class).create();
        activity = controller.get();
        Field field = MainActivity.class.getDeclaredField("webView");
        field.setAccessible(true);
        webView = (WebView) field.get(activity);
    }
    @After public void cleanup() {
        if (controller != null) controller.destroy();
    }
    private ShadowActivity.IntentForResult choose() {
        assertTrue(webView.getWebChromeClient().onShowFileChooser(webView, results::add, null));
        return Shadows.shadowOf(activity).getNextStartedActivityForResult();
    }
    @Test public void imagePickerReturnsSelectedScreenshotWithoutStartingSession() {
        ShadowActivity.IntentForResult request = choose();
        assertEquals(Intent.ACTION_OPEN_DOCUMENT, request.intent.getAction());
        assertTrue(request.intent.hasCategory(Intent.CATEGORY_OPENABLE));
        assertEquals("image/*", request.intent.getType());
        assertTrue(webView.getSettings().getAllowContentAccess());
        Uri selected = Uri.parse("content://documents/hand.jpg");
        activity.onActivityResult(request.requestCode, Activity.RESULT_OK, new Intent().setData(selected));
        assertEquals(1, results.size());
        assertArrayEquals(new Uri[]{selected}, results.get(0));
        activity.onActivityResult(request.requestCode, Activity.RESULT_OK, new Intent().setData(selected));
        assertEquals(1, results.size());
    }
    @Test public void cancellingPickerReleasesCallbackAndNextImportWorks() {
        ShadowActivity.IntentForResult request = choose();
        activity.onActivityResult(request.requestCode, Activity.RESULT_CANCELED, null);
        assertEquals(1, results.size());assertNull(results.get(0));
        request = choose();
        Uri selected = Uri.parse("content://documents/another.png");
        activity.onActivityResult(request.requestCode, Activity.RESULT_OK, new Intent().setData(selected));
        assertArrayEquals(new Uri[]{selected}, results.get(1));
    }
    @Test public void secondPickerCancelsOnlyPreviousCallback() {
        choose();
        ShadowActivity.IntentForResult request = choose();
        assertEquals(1, results.size());assertNull(results.get(0));
        activity.onActivityResult(request.requestCode, Activity.RESULT_CANCELED, null);
        assertEquals(2, results.size());assertNull(results.get(1));
    }
    @Test public void closingActivityReleasesPendingPicker() {
        choose();controller.destroy();controller = null;
        assertEquals(1, results.size());assertNull(results.get(0));
    }
}
