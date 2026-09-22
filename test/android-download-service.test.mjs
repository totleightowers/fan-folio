import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Run the actual command/watchdog branches with platform effects replaced by
// counters. Device tests are still required for Android scheduling itself.
test('service restart and missing heartbeats never pretend work is running', t => {
  if (spawnSync('javac', ['-version']).error) { t.skip('JDK unavailable'); return; }
  const source = readFileSync(new URL('../android/src/org/fanfolio/DownloadService.java', import.meta.url), 'utf8');
  const from = source.indexOf('    public int onStartCommand(');
  const command = source.slice(from, source.indexOf('\n    private void standDown', from));
  const timerFrom = source.indexOf('    private final Runnable keepingTime');
  const timer = source.slice(timerFrom, source.indexOf('\n    };', timerFrom) + 7);
  const constants = [...source.matchAll(/public static final String \w+ = "[^"]*";/g)].map(m => m[0]).join('\n');
  const java = `
import java.lang.ref.WeakReference;
public class ServiceCheck {
  ${constants}
  static final int START_STICKY=1, START_NOT_STICKY=2;
  static WeakReference<ServiceCheck> alive = new WeakReference<>(null);
  static final long TICK_MS=5000, HEARTBEAT_TIMEOUT_MS=60000;
  long lastHeartbeat; String lastText="";
  int interruptedCount, foreground, holds, releases, stops, finished;
  final Clock clock = new Clock();
  static class Clock { long now; int posts; void postDelayed(Runnable r, long ms) {posts++;} void removeCallbacks(Runnable r) {} }
  static class Intent { String action, state; Intent(String a) {action=a;} String getAction(){return action;} String getStringExtra(String key){return key.equals(EXTRA_STATE)?state:null;} boolean getBooleanExtra(String key, boolean def){return def;} }
  static class MainActivity { static int ticks; static void tick(){ticks++;} static void pauseFromNotification(){} static void resumeFromNotification(){} static void stopFromNotification(){} }
  void interrupted(){interruptedCount++;}
  void hold(){holds++;} void release(){releases++;} void standDown(){stops++;}
  void startForegroundWith(String text, boolean paused){foreground++;}
  void showFinished(String text, boolean attention){finished++;}
  ${timer}
  ${command}
  static void check(boolean ok, String message){if(!ok) throw new AssertionError(message);}
  public static void main(String[] args) {
    ServiceCheck cold=new ServiceCheck();
    check(cold.onStartCommand(null,0,1)==START_NOT_STICKY, "restart must stop");
    check(cold.interruptedCount==1 && cold.foreground==0 && cold.holds==0 && cold.clock.posts==0, "restart without a queue must report interruption");
    ServiceCheck live=new ServiceCheck(); live.clock.now=100000;
    check(live.onStartCommand(new Intent(ACTION_START),0,1)==START_STICKY, "live starts");
    check(live.holds==1 && live.foreground==1, "live worker gets foreground support");
    live.clock.now+=5000; live.keepingTime.run(); check(MainActivity.ticks==1, "probe live page");
    live.clock.now+=60001; live.keepingTime.run();
    check(live.interruptedCount==1 && MainActivity.ticks==1, "missing acknowledgement ends misleading notification");
    ServiceCheck paused=new ServiceCheck(); Intent pause=new Intent(ACTION_START); pause.state="paused";
    paused.onStartCommand(pause,0,1);
    check(paused.holds==0 && paused.clock.posts==0 && paused.releases==1, "paused jobs do not keep clocks or wake locks");
  }
}`.replaceAll('android.os.SystemClock.elapsedRealtime()', 'clock.now').replace('@Override public void run()', 'public void run()');
  const dir = mkdtempSync(join(tmpdir(), 'folio-service-test-'));
  try {
    writeFileSync(join(dir, 'ServiceCheck.java'), java);
    const built = spawnSync('javac', [join(dir, 'ServiceCheck.java')], { encoding: 'utf8' });
    assert.equal(built.status, 0, built.stderr);
    const ran = spawnSync('java', ['-cp', dir, 'ServiceCheck'], { encoding: 'utf8' });
    assert.equal(ran.status, 0, ran.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
