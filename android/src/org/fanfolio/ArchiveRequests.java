package org.fanfolio;

import java.util.*;
import java.util.concurrent.*;

/** Process-owned asynchronous reads, independent of WebView's resource loader. */
final class ArchiveRequests {
    private final Executor executor;
    private final Runnable completed;
    private final Map<Integer, Slot> pending = new HashMap<>();
    private int next;
    private static final int LIMIT = 4;
    private static final class Slot { String result; }
    ArchiveRequests(Executor executor, Runnable completed) {
        this.executor = executor;
        this.completed = completed;
    }
    synchronized int start(final Callable<String> request) {
        if (pending.size() >= LIMIT) throw new RejectedExecutionException("archive request capacity");
        final int id = ++next;
        final Slot slot = new Slot();
        pending.put(id, slot);
        try {
            executor.execute(new Runnable() { @Override public void run() {
                synchronized (ArchiveRequests.this) { if (pending.get(id) != slot) return; }
                String result;
                try { result = request.call(); }
                catch (Exception error) { result = "{\"status\":502,\"body\":\"The app could not reach the archive\"}"; }
                synchronized (ArchiveRequests.this) {
                    if (pending.get(id) != slot) return;
                    slot.result = result;
                }
                completed.run();
            }});
        } catch (RuntimeException error) { pending.remove(id); throw error; }
        return id;
    }
    synchronized String take(int id) {
        Slot slot = pending.get(id);
        if (slot == null) return "{\"status\":502,\"body\":\"Archive request is no longer available\"}";
        if (slot.result == null) return "";
        pending.remove(id);
        return slot.result;
    }
    synchronized void discard() { pending.clear(); }
}
