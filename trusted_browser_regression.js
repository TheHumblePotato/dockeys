// CDP supplies real trusted pointer/keyboard input. The fixture models Docs'
// early window listeners and applies formatting to ranges, not just click logs.
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { pathToFileURL } = require("node:url")
const { spawn } = require("node:child_process")
const { fixture, executable } = require("./browser_regression")
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
if (typeof WebSocket !== "function") { console.log("SKIP trusted browser regression: requires Node 22 or later"); process.exit(0) }

async function main() {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "docskeys-pointer-"))
    const profile = path.join(temp, "profile"), html = path.join(temp, "fixture.html")
    fs.writeFileSync(html, fixture.replace("(async()=>{", "(async()=>{if(location.search==='?trusted')return;"))
    const browser = spawn(executable, ["--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
        "--disable-background-networking", "--remote-debugging-port=0", `--user-data-dir=${profile}`, pathToFileURL(html).href + "?trusted"],
        { windowsHide: true, stdio: "ignore" })
    let socket
    try {
        const portFile = path.join(profile, "DevToolsActivePort")
        for (let n = 0; n < 200 && !fs.existsSync(portFile); n++) await sleep(25)
        const port = fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0]
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
        const target = targets.find((entry) => entry.type === "page")
        socket = new WebSocket(target.webSocketDebuggerUrl)
        await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
        let id = 0
        const pending = new Map()
        socket.onmessage = (message) => {
            const result = JSON.parse(message.data), request = pending.get(result.id)
            if (!request) return
            pending.delete(result.id)
            result.error ? request.reject(Error(result.error.message)) : request.resolve(result.result)
        }
        const cdp = (method, params = {}) => new Promise((resolve, reject) => {
            const request = ++id
            pending.set(request, { resolve, reject })
            socket.send(JSON.stringify({ id: request, method, params }))
        })
        const evaluate = async (expression) => {
            const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
            if (result.exceptionDetails) throw Error(result.exceptionDetails.exception.description)
            return result.result.value
        }
        await evaluate(`new Promise(resolve=>{const ready=()=>typeof mode==='string'?resolve():setTimeout(ready,10);ready()})`)
        await evaluate(`
            window.pointerEffects=[]; window.rightMoves=0;
            window.applyFixtureFormat=(name)=>{
                const [start,end]=sim.selRange();
                pointerEffects.push({name,start,end,text:sim.selText(),reading:readScrollSettling});
                sim.formats=sim.formats||{};
                for(let at=start;at<end;at++)(sim.formats[at]||(sim.formats[at]={}))[name]=true;
            };
            const bar=document.createElement('div');bar.style.cssText='position:fixed;top:230px;left:20px;display:flex;gap:12px';
            bar.innerHTML='<div id="boldButton" class="goog-toolbar-toggle-button" aria-label="Bold" style="width:80px;height:28px">Bold</div><input id="fixture-font" value="11" style="width:60px">';
            document.body.appendChild(bar);
            let pressed=null;
            window.addEventListener('pointerdown',event=>{
                if(event.button===2&&event.target.closest('.kix-appview-editor')){rightMoves++;sim.setCaret(3);updateFixture()}
                if(event.target.id==='boldButton')pressed=event.target;
            },true);
            window.addEventListener('mouseup',event=>{
                if(event.button===2&&event.target.closest('.kix-appview-editor')){rightMoves++;sim.setCaret(3);updateFixture()}
            },true);
            window.addEventListener('contextmenu',event=>{
                if(!event.target.closest('.kix-appview-editor'))return;
                const r=highlight.getBoundingClientRect();
                if(event.clientX<r.left||event.clientX>=r.right||event.clientY<r.top||event.clientY>=r.bottom){
                    rightMoves++;sim.setCaret(3);updateFixture();
                }
            },true);
            document.querySelector('#boldButton').addEventListener('pointerup',event=>{
                if(pressed===event.target){applyFixtureFormat('bold');pressed=null}
            });
            document.querySelector('#fixture-font').addEventListener('keydown',event=>{
                if(event.key==='Enter')applyFixtureFormat('font-'+event.target.value);
            });
            input.body.addEventListener('keydown',event=>{
                if(!event.isTrusted)return;
                if(event.ctrlKey&&event.key.toLowerCase()==='b')applyFixtureFormat('bold-key');
                if(event.ctrlKey&&event.altKey&&event.key.toLowerCase()==='m'){
                    applyFixtureFormat('comment');
                    document.querySelector('#paper').style.transform='translateX(-20px)';
                    document.querySelector('#paper').style.width='700px';
                    setTimeout(()=>{editor.scrollLeft=12},80);
                }
            });
            window.beginPointerSelection=async()=>{
                if(linewiseState?.externalRange)await restoreLinewiseExternalSelection();
                await new Promise(resolve=>setTimeout(resolve,10));
                clearLinewiseSelection();switchModeToNormal();sim.setCaret(0);updateFixture();
                await startLinewiseSelection();await new Promise(resolve=>setTimeout(resolve,10));
                await linewiseMoveVertical(true);await new Promise(resolve=>setTimeout(resolve,10));
                input.body.focus();
            };
        `)
        const settle = () => evaluate(`new Promise((resolve,reject)=>{let n=0;const check=()=>{
            if(!oracleBusy&&keyQueue.length===0)resolve();else if(++n>800)reject(Error('input guard stalled'));else setTimeout(check,10)};check()})`)
        const click = async (selector, button = "left") => {
            const point = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})()`)
            await cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button, buttons: button === "right" ? 2 : 1, clickCount: 1 })
            await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button, buttons: 0, clickCount: 1 })
            await settle()
        }
        await evaluate("beginPointerSelection()")
        await settle()
        await click("#boldButton")
        let effect = await evaluate("pointerEffects.at(-1)")
        assert.equal(effect.name, "bold")
        assert.equal(effect.text, "Wi mi\niiii WWW", "pointer-based Bold did not format the full V range")
        assert.equal(effect.reading, false, "formatting inherited the probe scroll lock")
        assert.equal(await evaluate("Object.keys(sim.formats).length"), 14)

        // Press the formatting key immediately, without waiting for modifier
        // pre-arming. The queued fallback must apply the same full range.
        await evaluate("beginPointerSelection()")
        await settle()
        await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 2 })
        await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "b", code: "KeyB", windowsVirtualKeyCode: 66, modifiers: 2 })
        await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "b", code: "KeyB", windowsVirtualKeyCode: 66, modifiers: 2 })
        await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 0 })
        await settle()
        effect = await evaluate("pointerEffects.at(-1)")
        assert.ok(["bold", "bold-key"].includes(effect.name))
        assert.equal(effect.text, "Wi mi\niiii WWW", "rapid Ctrl+B lost the full range")

        await evaluate("beginPointerSelection()")
        await settle()
        await click("#fixture-font")
        await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 })
        await cdp("Input.insertText", { text: "19" })
        await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 })
        effect = await evaluate("pointerEffects.at(-1)")
        assert.equal(effect.name, "font-19")
        assert.equal(effect.text, "Wi mi\niiii WWW", "font input lost the native range")

        await evaluate("beginPointerSelection()")
        await settle()
        await click(".kix-appview-editor", "right")
        await evaluate("new Promise(resolve=>setTimeout(resolve,80))")
        assert.equal(await evaluate("rightMoves"), 0, "Docs received right pointerdown/mouseup before the guard")
        assert.equal(await evaluate("sim.selText()"), "Wi mi\niiii WWW")
        assert.equal(await evaluate("mode"), "visualLine")

        await evaluate(`(async()=>{
            await restoreLinewiseExternalSelection();await new Promise(resolve=>setTimeout(resolve,10));
            switchModeToNormal();sim.setCaret(0);updateFixture();switchModeToVisual();
        })()`)
        await settle()
        await evaluate("handleKeyEventVisualLine('l');renderOverlay()")
        const charwise = await evaluate("sim.selText()")
        await click(".kix-appview-editor", "right")
        assert.equal(await evaluate("rightMoves"), 0)
        assert.equal(await evaluate("sim.selText()"), charwise, "right-click replaced the charwise range")
        assert.equal(await evaluate("mode"), "visual")

        await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "ContextMenu", code: "ContextMenu", windowsVirtualKeyCode: 93 })
        assert.equal(await evaluate("fixtureContextRanges.at(-1)"), charwise)

        await evaluate("beginPointerSelection()")
        await settle()
        const before = await evaluate("linewiseState.point.x")
        await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 2 })
        await settle()
        await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Alt", code: "AltLeft", windowsVirtualKeyCode: 18, modifiers: 3 })
        await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "m", code: "KeyM", windowsVirtualKeyCode: 77, modifiers: 3 })
        await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "m", code: "KeyM", windowsVirtualKeyCode: 77, modifiers: 3 })
        await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Alt", code: "AltLeft", windowsVirtualKeyCode: 18, modifiers: 2 })
        await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, modifiers: 0 })
        await evaluate("new Promise(resolve=>setTimeout(resolve,120))")
        await evaluate("renderOverlay()")
        effect = await evaluate("pointerEffects.at(-1)")
        assert.equal(effect.name, "comment")
        assert.equal(effect.text, "Wi mi\niiii WWW")
        assert.equal(effect.reading, false)
        assert.equal(await evaluate("editor.scrollLeft"), 12, "the read guard or a late restore blocked comment layout scrolling")
        assert.equal(await evaluate("linewiseState.point.x"), before - 20, "comment layout left the anchor in old screen coordinates")
        assert.equal(await evaluate("linewiseState.externalRange.cursor.point.x"), before - 20)
        await evaluate("restoreLinewiseExternalSelection()")
        await settle()
        await evaluate("renderOverlay()")
        assert.equal(await evaluate("parseFloat(linewiseHighlight.style.left)"), before - 32,
            "resuming Visual line after comments left the custom highlight shifted")
        console.log("PASS trusted Chromium input: full-range pointer Bold/font size, early right-click protection, native comments and layout rebasing")
    } finally {
        socket?.close()
        browser.kill()
        await sleep(100)
        const resolved = path.resolve(temp), root = path.resolve(os.tmpdir()) + path.sep
        if (!resolved.startsWith(root) || !path.basename(resolved).startsWith("docskeys-pointer-")) throw Error("Unexpected fixture directory")
        try { fs.rmSync(resolved, { recursive: true, force: true }) } catch { /* Chromium may briefly retain files. */ }
    }
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1) })
