import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Execute the real lifetime/ownership methods. Android rendering is not mocked
// into a claim about device scheduling; those checks still need a device.
test('closing and recreating a screen retains one runtime and queue; cold service needs no screen', t => {
  if (spawnSync('javac', ['-version']).error) { t.skip('JDK unavailable'); return; }
  const source = readFileSync(new URL('../android/src/org/fanfolio/FolioRuntime.java', import.meta.url), 'utf8');
  const method = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  const methods = [
    method('    static FolioRuntime get(', '    private FolioRuntime('),
    method('    private void load()', '    void resized()'),
    method('    static void startWorker(', '    private void deliverCommand()'),
  ].join('\n').replaceAll('android.content.Context', 'Context');
  const java = `
import java.lang.ref.WeakReference;
import java.util.concurrent.atomic.AtomicReference;
public class FolioRuntime {
  static FolioRuntime instance;
  static int creates;
  final Context application;
  Context viewContext;
  WeakReference<MainActivity> activity=new WeakReference<>(null);
  final Root root=new Root(); final Web web=new Web();
  Object signInView; boolean loaded, ready; int delivered, closed;
  final AtomicReference<String> pendingCommand=new AtomicReference<>();
  static final String ORIGIN="https://test";
  FolioRuntime(Context app){creates++; application=app; viewContext=new Context(app);}
  Context getApplicationContext(){return application;}
  void resized(){} void toPage(String js){}
  boolean isSignedIn(){return true;} void closeSignIn(boolean signed){signInView=null;}
  void acceptIntent(Intent intent){} void deliverCommand(){delivered++;}
  static class Intent {}
  static class Context {
    Context base; Context(Context value){base=value;}
    Context getApplicationContext(){return base==null?this:base.getApplicationContext();}
    void setBaseContext(Context value){base=value;}
  }
  static class MainActivity extends Context {
    MainActivity(Context app){super(app);}
    void setContentView(Root root){root.parent=new ViewGroup();}
  }
  static class Root { ViewGroup parent; Object getParent(){return parent;} }
  static class ViewGroup { void removeView(Root root){root.parent=null;} }
  static class Web { int loads; void loadUrl(String url){loads++;} }
  ${methods}
  static void check(boolean ok,String message){if(!ok)throw new AssertionError(message);}
  public static void main(String[] args){
    Context app=new Context(null); MainActivity first=new MainActivity(app);
    FolioRuntime runtime=get(first); runtime.attach(first,new Intent());
    check(runtime.application==app,"application owns runtime");
    runtime.detach(first);
    check(runtime.activity.get()==null && runtime.viewContext.base==app && runtime.root.parent==null,"destroyed Activity released");
    check(runtime.closed==0 && runtime.web.loads==1,"work survives screen destruction");
    startWorker(app,null);
    MainActivity second=new MainActivity(app); get(second).attach(second,new Intent());
    check(get(app)==runtime && creates==1 && runtime.web.loads==1,"one database/page/queue after reopening");
    runtime.detach(first);
    check(runtime.activity.get()==second && runtime.viewContext.base==second,"late old destruction cannot detach new window");
    runtime.detach(second);
    instance=null; startWorker(app,"__stopAll");
    check(instance.activity.get()==null && instance.loaded && instance.web.loads==1,"service cold start needs no Activity");
    check("__stopAll".equals(instance.pendingCommand.get()) && instance.delivered==0,"cold command waits for restored queue");
    instance.ready=true; startWorker(app,"__resumeAll");
    check(instance.delivered==1 && instance.web.loads==1,"ready worker accepts command without reload");
  }
}`;
  const dir=mkdtempSync(join(tmpdir(),'folio-runtime-test-'));
  try {
    writeFileSync(join(dir,'FolioRuntime.java'),java);
    const build=spawnSync('javac',[join(dir,'FolioRuntime.java')],{encoding:'utf8'});
    assert.equal(build.status,0,build.stderr);
    const run=spawnSync('java',['-cp',dir,'FolioRuntime'],{encoding:'utf8'});
    assert.equal(run.status,0,run.stderr);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
