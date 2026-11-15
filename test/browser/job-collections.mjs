import assert from 'node:assert/strict';
import { startApp, addWork } from './harness.mjs';
const app=await startApp({port:18778,seed(db){
  addWork(db,{id:'1',title:'Apple orchard',authors:['gokurakuji']});
  addWork(db,{id:'2',title:'Birch trees',held:false,authors:['gokurakuji']});
  addWork(db,{id:'3',title:'Coastal path'});
  addWork(db,{id:'epub-demo',title:'Imported story'});
  addWork(db,{id:'4',title:null,held:false,words:0,authors:[],summary:'This is part of an ongoing challenge and will be revealed soon!'});
  db.exec("INSERT INTO reading(work_id,marked_later) SELECT work_id,1 FROM works");
  db.exec("INSERT INTO bookmarked_by(work_id,person) VALUES('3','gokurakuji'),('2','gokurakuji')");
}});
const {page,base,errors}=app;
const expectRows=names=>page.waitForFunction(expected=>JSON.stringify([...document.querySelectorAll('#works .work-title-link')].map(n=>n.textContent))===JSON.stringify(expected),names);
const openJob=async name=>{await page.click('#tabs [data-tab=activity]');await page.locator('.job-open').filter({hasText:name}).click();await page.locator('#library').waitFor({state:'visible'});};
try {
  await page.goto(base);
  assert.ok(!(await page.locator('#home').innerText()).includes('will be revealed soon'));
  await page.evaluate(()=>localStorage.setItem('fanfolio.jobs',JSON.stringify([
    {key:'download',author:'Downloaded set',part:'works',state:'done',historyComplete:true,items:[{workId:'1',state:'downloaded'},{workId:'2',state:'failed',error:'525'},{workId:'999',state:'failed',error:'404'}]},
    {key:'import',author:'Imported set',part:'EPUBs',source:{kind:'epub'},state:'done',historyComplete:true,items:[{workId:'epub-demo',state:'version'}]},
    {key:'empty',author:'Empty set',part:'works',source:{kind:'works'},state:'done',historyComplete:false,items:[]},
    {key:'old-works',author:'gokurakuji',part:'works',state:'done',items:[]},
    {key:'old-bookmarks',author:'gokurakuji',part:'bookmarks',state:'done',items:[]},
    {key:'already-saved',author:'gokurakuji',part:'works',state:'done',historyComplete:true,items:[]},
    {key:'partial',author:'gokurakuji',part:'works',state:'done',items:[{workId:'epub-demo',state:'downloaded'}]},
    {key:'big',author:'Big set',part:'works',state:'done',historyComplete:true,items:Array.from({length:1200},(_,i)=>({workId:i===0?'1':`unknown-${i}`,state:'downloaded'}))},
  ])));
  await page.reload();
  await openJob('Downloaded set');
  await expectRows(['Apple orchard']);
  assert.match(await page.locator('#job-collection-summary').innerText(),/2 need attention/);
  await page.locator('#works .work-title-link').first().click();
  await page.locator('#detail').waitFor({state:'visible'});
  await page.click('#back');
  await expectRows(['Apple orchard']);
  await page.click('#job-collection-details');
  await page.locator('#job-works [data-work-id="999"]').waitFor();
  assert.match(await page.locator('#job-works [data-work-id="999"]').innerText(),/404/);
  await page.click('#back');
  await expectRows(['Apple orchard']);
  // Tag navigation starts a fresh collection; Back restores the job scope.
  await page.locator('#works .tagpill').first().click();
  await expectRows(['Apple orchard','Birch trees','Coastal path','Imported story']);
  assert.equal(await page.locator('#job-collection').isVisible(),false);
  await page.click('#back');
  await expectRows(['Apple orchard']);
  await page.reload();
  await page.click('#tabs [data-tab=library]');
  await expectRows(['Apple orchard']);
  await page.click('#job-collection-details');
  await page.locator('#job-title').filter({hasText:'Downloaded set'}).waitFor();
  await openJob('Imported set');
  await expectRows(['Imported story']);
  await page.click('#open-filters');
  await page.click('#clear-filters');
  await expectRows(['Apple orchard','Birch trees','Coastal path','Imported story']);
  await page.click('#filters [data-close]');
  await openJob('Empty set');
  await expectRows([]);
  await page.locator('#works .empty').filter({hasText:'No works match'}).waitFor();
  await openJob('Big set');
  await expectRows(['Apple orchard']);
  // The screenshot's older 0-of-0 author job has no surviving IDs. Its row
  // padding, title and keyboard activation all open the matching saved works.
  await page.click('#tabs [data-tab=activity]');
  const oldWorks=page.locator('.job-row').filter({has:page.locator('.job-who',{hasText:'gokurakuji · works'})}).first();
  await oldWorks.click({position:{x:4,y:4}});
  await expectRows(['Apple orchard']);
  assert.match(await page.locator('#job-collection-summary').innerText(),/download history is incomplete/);
  await page.click('#open-filters');
  await page.locator('#availability').selectOption('');
  await page.click('#apply-filters');
  await expectRows(['Apple orchard','Birch trees']);
  await page.reload();await page.click('#tabs [data-tab=library]');
  await expectRows(['Apple orchard','Birch trees']);
  await page.click('#tabs [data-tab=activity]');
  await page.locator('.job-open').filter({hasText:'gokurakuji · bookmarks'}).focus();
  await page.keyboard.press('Enter');
  await expectRows(['Coastal path']);
  await page.click('#tabs [data-tab=activity]');
  await page.locator('.job-open').filter({hasText:'gokurakuji · works'}).nth(1).click();
  await expectRows(['Apple orchard']);
  assert.match(await page.locator('#job-collection-summary').innerText(),/No works were queued/);
  await page.click('#tabs [data-tab=activity]');
  await page.locator('.job-open').filter({hasText:'gokurakuji · works'}).last().click();
  await expectRows(['Apple orchard','Imported story']);
  // Deleting a row stays on Downloads; it must not bubble into navigation.
  await page.click('#tabs [data-tab=activity]');
  await page.locator('.job-row').filter({hasText:'Empty set'}).getByRole('button',{name:'Delete',exact:true}).click();
  assert.equal(await page.locator('#activity').isVisible(),true);
  // Tablet detail still browses just this job; no unrelated collection leaks in.
  await page.setViewportSize({width:1000,height:950});
  await openJob('Downloaded set');
  await page.locator('#works .work-title-link').first().click();
  await page.waitForFunction(()=>document.querySelectorAll('#preview-choices strong').length===1);
  await page.click('#back');
  await page.click('#library-collections [data-collection=all]');
  await page.click('#open-filters');
  const unrevealed=page.locator('.filter-section').filter({has:page.locator('.sec-title',{hasText:'Unavailable placeholders'})});
  await unrevealed.locator('.sec-head').click();
  await unrevealed.getByRole('button',{name:'Show unrevealed and empty placeholders',exact:true}).click();
  await page.click('#apply-filters');
  await page.waitForFunction(()=>document.querySelectorAll('#works .work-card').length===5);
  assert.ok((await page.locator('#works').innerText()).includes('will be revealed soon'));
  await page.click('#open-filters');await page.click('#clear-filters');await page.click('#filters [data-close]');
  await expectRows(['Apple orchard','Birch trees','Coastal path','Imported story']);
  // A fresh failure's status line is itself a link to saved works, including
  // a retained local copy whose attempted refresh failed. No archive requests.
  await page.route('**/api/add?*',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({error:'This work was deleted'})}));
  await page.evaluate(()=>{
    localStorage.removeItem('archive.pacing');
    localStorage.setItem('fanfolio.jobs',JSON.stringify([
      {key:'failed-refresh',author:'gokurakuji',part:'works',state:'queued',historyComplete:true,workIds:['1']},
    ]));
  });
  await page.reload();
  await page.click('#tabs [data-tab=activity]');
  await page.locator('.job-error-link').waitFor();
  await page.locator('.job-error-link').click();
  await expectRows(['Apple orchard']);
  await page.click('#tabs [data-tab=activity]');
  await page.locator('.job-row').getByRole('button',{name:'Delete',exact:true}).click();
  assert.equal(await page.locator('.job-error-link').count(),0, 'a removed job leaves no broken status link');
  assert.deepEqual(errors,[]);
  console.log('Job collections and unrevealed works: phone/tablet, import/download, restart, empty/large, Back, filters and retry access passed');
} finally {await app.close();}
