package org.fanfolio;

import android.app.Activity;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;

/** A window onto the process-owned library and download runtime. */
public class MainActivity extends Activity {
    private FolioRuntime runtime;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        DownloadDiagnostics.event("activity_create", "restored", state != null);
        runtime = FolioRuntime.get(this);
        runtime.attach(this, getIntent());
        registerBackGesture();
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        runtime.acceptIntent(intent);
    }

    @Override public void onConfigurationChanged(android.content.res.Configuration config) {
        super.onConfigurationChanged(config);
        runtime.resized();
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        runtime.onActivityResult(request, result, data);
    }

    @Override protected void onDestroy() {
        DownloadDiagnostics.event("activity_destroy", "finishing", isFinishing(), "configuration", isChangingConfigurations());
        if (runtime != null) runtime.detach(this);
        super.onDestroy();
    }

    @Override protected void onResume() { super.onResume(); DownloadDiagnostics.event("activity_resume"); }
    @Override protected void onPause() { DownloadDiagnostics.event("activity_pause"); super.onPause(); }
    @Override protected void onStop() { DownloadDiagnostics.event("activity_stop"); super.onStop(); }

    private void registerBackGesture() {
        if (Build.VERSION.SDK_INT < 33) return;      // onBackPressed still serves

        /* From Android 14 the gesture reports itself as it happens, so the page
           can move with the finger and show where back is going. Below that it
           can only be told the gesture finished, which is the difference
           between previewing a destination and being dropped at it. */
        if (Build.VERSION.SDK_INT >= 34) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
                android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                new android.window.OnBackAnimationCallback() {
                    @Override public void onBackStarted(android.window.BackEvent e) {
                        runtime.toPage("window.__onBackStart && window.__onBackStart()");
                    }
                    @Override public void onBackProgressed(android.window.BackEvent e) {
                        runtime.toPage("window.__onBackProgress && window.__onBackProgress("
                            + e.getProgress() + ")");
                    }
                    @Override public void onBackCancelled() {
                        runtime.toPage("window.__onBackCancel && window.__onBackCancel()");
                    }
                    @Override public void onBackInvoked() { handleBack(); }
                });
            return;
        }

        getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
            android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,
            new android.window.OnBackInvokedCallback() {
                @Override public void onBackInvoked() { handleBack(); }
            });
    }

    /** Ask the page to go back; close the app only when it has nowhere left. */
    private void handleBack() {
        if (runtime == null) { finish(); return; }
        runtime.evaluate("(window.__onBack && window.__onBack()) ? 'held' : 'exit'",
            new android.webkit.ValueCallback<String>() {
                @Override public void onReceiveValue(String value) {
                    if (value == null || !value.contains("held")) finish();
                }
            });
    }

    /**
     * Android's back gesture belongs to the reader, not to the activity.
     *
     * The app navigates with its own view stack rather than browser history,
     * so WebView.canGoBack() knows nothing about it and every back gesture
     * closed the app — including from inside a work, which is exactly where a
     * reader reaches for back most often. The page is asked first and only
     * gets out of the way when it has nothing left to go back to.
     */
    @Override public void onBackPressed() {
        if (Build.VERSION.SDK_INT >= 33) return;     // the dispatcher owns it there
        handleBack();
    }

}
