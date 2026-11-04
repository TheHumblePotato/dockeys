// Real Chromium DOM/CSS/canvas checks in a disposable local fixture. This
// does not connect to, read, or edit an authenticated Google document.
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { pathToFileURL } = require("node:url")
const { spawnSync } = require("node:child_process")
const { DocSim } = require("./harness")
const manifest = require("./manifest.json")

const executable = process.env.DOCSKEYS_BROWSER || [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((file) => fs.existsSync(file))
if (!executable) { console.log("SKIP browser regression: set DOCSKEYS_BROWSER to Chromium/Chrome/Edge"); process.exit(0) }

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "docskeys-browser-"))
const scripts = ["page_script.js", ...manifest.content_scripts.find((entry) => entry.js.includes("content.js")).js]
const source = scripts.map((file) => `<script>${fs.readFileSync(path.join(__dirname, file), "utf8").replace(/<\/script/gi, "<\\/script")}</script>`).join("\n")
const fixture = String.raw`<!doctype html><meta charset="utf-8">
<style>
.kix-appview-editor { position:relative; height:180px; width:500px; overflow:auto; }
#paper { position:relative; height:1200px; }
.kix-cursor-caret { position:absolute; width:1px; height:24px; background:black; }
.kix-selection-overlay { position:absolute; background:rgba(26,115,232,.3); left:40px; top:40px; width:150px; height:24px; }
.docs-texteventtarget-iframe { position:fixed; left:-10000px; width:10px; height:10px; }
</style>
<div class="kix-appview-editor"><div id="paper">
<svg class="kix-canvas-tile-content" width="500" height="1200"></svg>
<div class="kix-selection-overlay"></div>
<div class="kix-cursor"><span class="kix-cursor-name"></span><div class="kix-cursor-caret"></div></div>
</div></div>
<iframe class="docs-texteventtarget-iframe"></iframe>
<button class="menu-button">Edit</button>
${["Copy", "Cut", "Paste", "Redo", "Undo", "Find"].map((x) => `<div class="goog-menuitem">${x}</div>`).join("")}
<pre id="docskeys-test-result">RUNNING</pre>
<script>
${DocSim.toString()}
DocSim.seg = new Intl.Segmenter(undefined, { granularity:'grapheme' });
const sim = new DocSim(${JSON.stringify("Wi mi\niiii WWW")});
const editor = document.querySelector('.kix-appview-editor');
const caret = document.querySelector('.kix-cursor-caret');
const highlight = document.querySelector('.kix-selection-overlay');
const nativeScrollTop = Object.getOwnPropertyDescriptor(Element.prototype,'scrollTop').set;
const measure = document.createElement('canvas').getContext('2d'); measure.font='20px Arial';
const svg = document.querySelector('svg');
for (const [row,text] of sim.text.split('\n').entries()) {
 const rect = document.createElementNS('http://www.w3.org/2000/svg','rect');
 for (const [key,value] of Object.entries({x:40,y:40+32*row,width:measure.measureText(text).width,height:24,'aria-label':text,'data-font-css':'20px Arial',fill:'transparent'})) rect.setAttribute(key,value);
 const paragraph=document.createElementNS('http://www.w3.org/2000/svg','g');paragraph.setAttribute('role','paragraph');
 paragraph.appendChild(rect);svg.appendChild(paragraph);
}
function updateFixture() {
 const line=sim.lineInfo(sim.focus), row=sim.text.slice(0,sim.focus).split('\n').length-1;
 caret.style.left=(40+measure.measureText(sim.text.slice(line.start,sim.focus)).width)+'px';
 caret.style.top=(40+32*row)+'px';
 highlight.style.display=sim.hasSel()?'block':'none';
}
const input=document.querySelector('iframe').contentDocument;
const focusCalls=[], originalFocus=input.defaultView.HTMLElement.prototype.focus;
input.defaultView.HTMLElement.prototype.focus=function(options){focusCalls.push(options);return originalFocus.call(this,options)};
input.body.style.font='20px Arial'; input.body.contentEditable='true';
input.body.addEventListener('keydown',event=>{
 sim.key({keyCode:event.keyCode,mods:{control:event.ctrlKey,alt:event.altKey,shift:event.shiftKey,meta:event.metaKey}});
 updateFixture();
 if(window.fixtureScrollAttack) {
  editor.scrollTop=900; editor.scrollTo(0,950); editor.scroll({top:999}); caret.scrollIntoView();
  setTimeout(()=>{editor.scrollTop=900;editor.scrollTo(0,950);caret.scrollIntoView();window.scrollTo(0,950)},180);
 }
});
for(const item of document.querySelectorAll('.goog-menuitem')) item.addEventListener('click',()=>sim.menu(item.textContent));
Object.defineProperty(navigator,'clipboard',{configurable:true,value:{readText:async()=>sim.clipboard,writeText:async text=>{sim.clipboard=text}}});
window.chrome={runtime:{getURL:()=> 'data:text/javascript,void%200',lastError:null},storage:{local:{get(key,cb){cb({[key]:{dvorak:false,readStrategy:'auto'}})},set(value,cb){if(cb)cb()}},onChanged:{addListener(){}}}};
updateFixture();
</script>
${source}
<script>
(async()=>{
 const assert=(value,message)=>{if(!value)throw Error(message)};
 const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
 const settle=async()=>{for(let i=0;i<500&&oracleBusy;i++)await delay(5);assert(!oracleBusy,'guard did not settle')};
 const width=()=>parseFloat(cursorBoxOverlay.style.width);
 const reset=()=>{sim.setCaret(0);updateFixture();invalidateExternalText();mode='normal';renderOverlay()};
 try {
  renderOverlay(); const wide=width();
  handleKeyEventNormal('l');renderOverlay();const narrow=width();
  assert(wide>narrow*2,'h/l glyph width did not change');
  handleKeyEventNormal('h');renderOverlay();assert(width()>narrow*2,'h did not restore wide glyph');
  handleKeyEventNormal('j');renderOverlay();assert(width()<wide/2,'j did not resize on next row');
  handleKeyEventNormal('k');renderOverlay();assert(width()>narrow*2,'k did not resize on previous row');
  reset();handleKeyEventNormal('f');handleFindCharInput('m');await settle();renderOverlay();
  assert(sim.focus===3&&width()>narrow*2,'rendered f target/width');
  reset();handleKeyEventNormal('t');handleFindCharInput('m');await settle();renderOverlay();
  assert(sim.focus===2&&width()<wide/2,'rendered t target/width');
  assert(sim.copyCalls===0,'local navigation/find should not copy');
  settings.readStrategy='rendered';reset();handleKeyEventNormal('w');await settle();
  const boundary=sim.focus;handleKeyEventNormal('w');await settle();
  assert(boundary===3&&sim.focus===6&&sim.copyCalls===0,'rendered-only words did not cross an explicit paragraph boundary');
  handleKeyEventNormal('b');await settle();assert(sim.focus===3&&sim.copyCalls===0,'rendered-only b did not cross back');
  handleKeyEventNormal('w');await settle();handleKeyEventNormal('w');await settle();handleKeyEventNormal('w');await settle();
  assert(sim.focus===11&&sim.copyCalls===0,'rendered-only mode probed beyond known paragraphs');
  reset();handleKeyEventNormal('v');await settle();handleKeyEventVisualLine('w');await settle();handleKeyEventVisualLine('w');await settle();
  assert(sim.selText()==='Wi mi\ni'&&sim.copyCalls===0,'rendered Visual words failed across paragraphs');
  handleKeyEventVisualLine('b');await settle();assert(sim.selText()==='Wi m','rendered Visual b failed across paragraphs');
  handleKey({key:'Escape',preventDefault(){},stopImmediatePropagation(){}});
  reset();handleKeyEventNormal('v');await settle();const verticalCopies=sim.copyCalls;
  handleKeyEventVisualLine('j');await settle();renderOverlay();
  assert(sim.selText()==='Wi mi\ni'&&width()<wide/2,'Visual j did not move to the next displayed row/glyph');
  handleKeyEventVisualLine('k');await settle();renderOverlay();
  assert(sim.selText()==='W'&&sim.copyCalls===verticalCopies,'Visual j/k read or rebuilt the selection');
  const oldColor=cursorBoxOverlay.style.backgroundColor;settings.cursorColor='#e91e63';renderOverlay();
  assert(cursorBoxOverlay.style.backgroundColor!==oldColor,'stationary cursor color did not update');
  handleKey({key:'Escape',preventDefault(){},stopImmediatePropagation(){}});
  settings.readStrategy='auto';
  reset();await performSearch('WWW',true);await settle();renderOverlay();
  assert(sim.focus===11&&width()>narrow*2,'search target glyph width');
  const marker=document.createElementNS('http://www.w3.org/2000/svg','rect');
  for(const [key,value] of Object.entries({x:20,y:72,width:10,height:24,'aria-label':'•','data-font-css':'20px Arial',fill:'transparent'})) marker.setAttribute(key,value);
  svg.children[1].insertBefore(marker,svg.children[1].firstChild);
  reset();handleKeyEventNormal('w');await settle();handleKeyEventNormal('w');await settle();
  assert(sim.focus===6,'w did not land at the first text character after the bullet');
  handleKeyEventNormal('w');await settle();assert(sim.focus===11,'w after crossing a bulleted paragraph moved one character');
  marker.remove();invalidateRenderedReader();
  reset();handleKeyEventNormal('V');await settle();renderOverlay();
  assert(sim.focus===0&&!sim.hasSel()&&document.querySelector('.docskeys-linewise-highlight').style.display==='block','V captured the native caret');
  handleKeyEventVisualLine('j');renderOverlay();assert(sim.focus===6&&!sim.hasSel(),'Vj did not move the real caret one row');
  handleKeyEventVisualLine('w');await settle();assert(sim.focus===11&&mode==='visualLine','Vw failed to move the linewise cursor');
  handleKey({key:'Escape',preventDefault(){},stopImmediatePropagation(){}});
  reset();nativeScrollTop.call(editor,500);window.fixtureScrollAttack=true;
  await withViewportPreserved(async()=>{
   goToDocEnd(true);
   assert(sim.hasSel(),'probe did not create temporary selection');
   input.body.focus();assert(focusCalls[focusCalls.length-1].preventScroll===true,'iframe focus was not protected');
   assert(getComputedStyle(highlight).opacity==='0','temporary blue selection is visible');
   assert(getComputedStyle(document.querySelector('#paper')).visibility==='visible','mask hid document text');
   await delay(50);
   assert(editor.scrollTop===500,'page-world scroll/focus escaped read lock');
   clickMenu(menuItems.copy);await delay(15);
   assert(sim.clipboard===sim.text,'masked selection cannot be copied');
   sendKeyEvent('left');
  });
  window.fixtureScrollAttack=false;await delay(250);
  assert(!document.documentElement.hasAttribute('data-docskeys-reading'),'read mask leaked');
  assert(editor.scrollTop===500,'late probe layout scrolled after read completion');
  nativeScrollTop.call(editor,0);reset();handleKeyEventNormal('v');await settle();await delay(80);
  assert(visualModel&&visualModel.partial,'v did not use a read-only rendered snapshot');
  withStableSelection(()=>{sendKeyEvent('right');sendKeyEvent('right',{shift:true})});
  assert(getComputedStyle(highlight).opacity==='0','selection batch was not masked');
  assert(document.querySelector('.docskeys-selection-freeze'),'genuine visual selection disappeared during batch');
  await delay(80);
  assert(!document.documentElement.hasAttribute('data-docskeys-selection-batch'),'batch mask leaked');
  assert(!document.querySelector('.docskeys-selection-freeze'),'frozen overlay leaked');
  const modelBeforeRedraw=visualModel, copiesBeforeRedraw=sim.copyCalls;
  const tile=document.createElement('div');tile.className='kix-canvas-tile-content';
  document.querySelector('#paper').appendChild(tile);highlight.appendChild(document.createElement('span'));
  await delay(20);tile.remove();await delay(20);
  assert(visualModel===modelBeforeRedraw&&sim.copyCalls===copiesBeforeRedraw,'tile/selection redraw invalidated Visual state');
  handleKey({key:'Escape',preventDefault(){},stopImmediatePropagation(){}});
  settings.readStrategy='clipboard';reset();
  const readClipboard=navigator.clipboard.readText;
  navigator.clipboard.readText=()=>new Promise(()=>{});
  handleKeyEventNormal('w');await delay(20);assert(oracleBusy,'fixture did not stall the clipboard request');
  eventHandler({key:'Escape',isTrusted:true,preventDefault(){},stopImmediatePropagation(){}});
  await settle();
  assert(mode==='normal'&&!oracleBusy&&!document.documentElement.hasAttribute('data-docskeys-reading'),'Escape did not restore browser input/masks');
  navigator.clipboard.readText=readClipboard;
  handleKeyEventNormal('j');assert(sim.focus===6,'native input remained locked after cancellation');
  document.querySelector('#docskeys-test-result').textContent='PASS real browser: rendered glyph sizing, no-copy local navigation/find, masked Copy, scroll lock, stable visual selection';
 }catch(error){document.querySelector('#docskeys-test-result').textContent='FAIL '+error.stack}
})();
</script>`
const html = path.join(temp, "fixture.html")
fs.writeFileSync(html, fixture)
const result = spawnSync(executable, ["--headless", "--disable-gpu", "--in-process-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", `--user-data-dir=${path.join(temp, "profile")}`, "--dump-dom",
    "--run-all-compositor-stages-before-draw", "--virtual-time-budget=5000", pathToFileURL(html).href],
{ encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024 })
const match = result.stdout && result.stdout.match(/<pre id="docskeys-test-result">([^<]*)<\/pre>/)
if (result.error || !match || !match[1].startsWith("PASS")) {
    console.error(match ? match[1] : result.error || result.stderr || "Browser did not report results")
    console.error("Fixture retained at", html)
    process.exit(1)
}
console.log(match[1])
// Delete only the disposable directory created above, after checking its root.
const resolved = path.resolve(temp), root = path.resolve(os.tmpdir()) + path.sep
if (!resolved.startsWith(root) || !path.basename(resolved).startsWith("docskeys-browser-")) throw Error("Unexpected fixture directory")
try { fs.rmSync(resolved, { recursive: true, force: true }) } catch (err) { /* Chromium may briefly retain a profile file. */ }
