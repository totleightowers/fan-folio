package org.fanfolio;

/** Starts the journal even when Android restores only the download service. */
public class FolioApplication extends android.app.Application {
    @Override public void onCreate() { super.onCreate(); DownloadDiagnostics.init(this); }
    @Override public void onTrimMemory(int level) { DownloadDiagnostics.event("trim_memory", "level", level); super.onTrimMemory(level); }
    @Override public void onLowMemory() { DownloadDiagnostics.event("low_memory"); super.onLowMemory(); }
}
