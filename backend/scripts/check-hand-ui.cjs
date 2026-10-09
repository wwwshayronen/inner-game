const {chromium}=require('playwright');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');

(async()=>{
  const browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const root=path.resolve(__dirname,'../../android/app/src/main/assets/www');
  const output=path.resolve(__dirname,'../ui-proof');fs.mkdirSync(output,{recursive:true});
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url());
    const file=path.join(root,url.pathname==='/'?'index.html':url.pathname);
    if(url.hostname==='innergame.test'&&file.startsWith(root)&&fs.existsSync(file))await route.fulfill({path:file});
    else await route.fulfill({status:404,body:''});
  });
  await page.goto('https://innergame.test/');
  const ids=await page.evaluate(()=>HAND_BANK.map(h=>h.id));
  for(const width of [320,390,768]){
    await page.setViewportSize({width,height:844});
    for(const id of ids){
      await page.evaluate(id=>{
        state.prep.handWarmup={bankVersion:HAND_BANK_VERSION,selectedIds:[id,...HAND_BANK.filter(h=>h.id!==id).slice(0,2).map(h=>h.id)],answers:{},currentIndex:0,completed:false};
        navigate('handPlay');
      },id);
      const issues=await page.evaluate(()=>{
        const issues=[],table=document.querySelector('.practice-table'),cards=document.querySelector('.hero-hand-dock').getBoundingClientRect();
        const board=document.querySelector('.gg-center').getBoundingClientRect();
        const overlap=(a,b)=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1;
        if(document.documentElement.scrollWidth>innerWidth)issues.push('horizontal overflow');
        if(document.querySelector('.gg-seat.hero'))issues.push('header/seat class collision');
        for(const seat of table.querySelectorAll('.gg-seat')){
          const rect=seat.getBoundingClientRect();
          if(overlap(rect,cards))issues.push('hole cards overlap '+seat.textContent);
          if(overlap(rect,board))issues.push('board overlaps '+seat.textContent);
        }
        for(const button of document.querySelectorAll('[data-hand-action]')){
          if(button.getBoundingClientRect().height<44)issues.push('small tap target');
          if(button.scrollWidth>button.clientWidth)issues.push('clipped action');
        }
        if(!document.querySelector('#handReason'))issues.push('why missing from decision page');
        return issues;
      });
      assert.deepEqual(issues,[],`${id} at ${width}px`);
      if(['H01','H28','H45'].includes(id)&&[320,390].includes(width))await page.screenshot({path:path.join(output,`${id}-${width}.png`),fullPage:true});
    }
  }
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>{state.prep.handWarmup={bankVersion:HAND_BANK_VERSION,selectedIds:['H01','H28','H45'],answers:{},currentIndex:0,completed:false};navigate('handPlay');});
  await page.getByRole('button',{name:'Next hand',exact:false}).click();
  await page.getByText('Choose an action first.',{exact:true}).waitFor();
  await page.locator('#handReason').fill('Position and the action so far.');
  await page.locator('[data-hand-action]').nth(1).click();
  await page.locator('[data-hand-action]').nth(2).click();
  assert.equal(await page.locator('#handReason').inputValue(),'Position and the action so far.');
  assert.equal(await page.locator('[data-hand-action][aria-pressed="true"]').count(),1);
  await page.reload();
  await page.evaluate(()=>navigate('handsIntro'));
  await page.locator('[data-start-hands]').click();
  assert.equal(await page.evaluate(()=>currentHand().id),'H01','draft reasoning must not count as submitted');
  assert.equal(await page.locator('#handReason').inputValue(),'Position and the action so far.');
  for(let i=0;i<3;i++){
    await page.locator('[data-hand-action]').nth(1).click();
    await page.locator('#handReason').fill('I considered position and the betting history.');
    await page.locator('[data-submit-hand]').click();
  }
  assert.equal(await page.evaluate(()=>state.prep.handWarmup.completed),true);
  assert.equal(await page.evaluate(()=>route),'handsComplete');
  assert.deepEqual(errors,[]);
  await browser.close();
  console.log('PASS: all 50 hands at 320/390/768px; no seat/card collisions, overflow or clipped controls. Same-page reasoning, selection, draft restore and completion passed.');
})().catch(error=>{console.error(error);process.exit(1);});
