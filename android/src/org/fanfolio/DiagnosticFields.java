package org.fanfolio;

import java.util.*;

/** Both names and values are allowlisted at the native boundary. */
final class DiagnosticFields {
    private static final Set<String> EVENTS = new HashSet<>(Arrays.asList(
        "queue", "queue_progress", "js_error", "js_rejection", "visibility"));
    private static final Set<String> KEYS = new HashSet<>(Arrays.asList(
        "running", "queued", "listing", "paused", "total", "added", "failed", "page", "pages",
        "state", "waits", "overdueMs", "cooldownMs", "hidden", "progressAgeMs"));
    /* A script error may say what kind it was and where in our own files it
       happened. Both are shapes that cannot hold a title or a name: a word,
       and function@file:line:column frames. Its message never crosses. */
    private static final java.util.regex.Pattern KIND = java.util.regex.Pattern.compile("[A-Za-z]{1,40}");
    private static final java.util.regex.Pattern WHERE = java.util.regex.Pattern.compile(
        "(?:[\\w$.<>-]{1,80}@[\\w./-]{1,80}\\.m?js:\\d{1,7}:\\d{1,7})(?:\\|[\\w$.<>-]{1,80}@[\\w./-]{1,80}\\.m?js:\\d{1,7}:\\d{1,7}){0,5}");
    static Map<String, Object> clean(String event, Map<String, Object> input) {
        if (!EVENTS.contains(event)) return null;
        Map<String, Object> safe = new HashMap<>();
        if (event.equals("js_error") || event.equals("js_rejection")) {
            Object kind = input.get("kind"), where = input.get("where");
            if (kind instanceof String && KIND.matcher((String) kind).matches()) safe.put("kind", kind);
            if (where instanceof String && ((String) where).length() <= 600
                && WHERE.matcher((String) where).matches()) safe.put("where", where);
        }
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
