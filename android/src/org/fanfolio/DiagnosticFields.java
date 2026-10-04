package org.fanfolio;

import java.util.*;

/** Both names and values are allowlisted at the native boundary. */
final class DiagnosticFields {
    private static final Set<String> EVENTS = new HashSet<>(Arrays.asList(
        "queue", "queue_progress", "js_error", "js_rejection", "visibility"));
    private static final Set<String> KEYS = new HashSet<>(Arrays.asList(
        "running", "queued", "listing", "paused", "total", "added", "failed", "page", "pages",
        "state", "waits", "overdueMs", "cooldownMs", "hidden", "progressAgeMs"));
    static Map<String, Object> clean(String event, Map<String, Object> input) {
        if (!EVENTS.contains(event)) return null;
        Map<String, Object> safe = new HashMap<>();
        for (Map.Entry<String, Object> entry : input.entrySet()) {
            if (!KEYS.contains(entry.getKey())) continue;
            Object value = entry.getValue();
            if (value instanceof Boolean) safe.put(entry.getKey(), value);
            else if (value instanceof Number) {
                double n = ((Number) value).doubleValue();
                if (!Double.isNaN(n) && !Double.isInfinite(n) && Math.abs(n) <= 1e15) safe.put(entry.getKey(), value);
            }
        }
        return safe;
    }
}
