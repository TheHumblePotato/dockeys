const assert = require("node:assert/strict")
const { makeEnv } = require("./harness")

async function query(e, prefix, pattern) {
    await e.pressAll(prefix)
    for (const char of pattern) await e.pressRaw(char)
    await e.pressRaw("Enter")
}

async function main() {
    const text = "aa bb\ncc dd\nee ff"
    let e = makeEnv(text, { settings: { dvorak: false } })
    e.sim.setCaret(3)
    await e.pressRaw("V")
    assert.equal(e.sim.focus, 3, "V forced the caret to a selection boundary")
    assert.equal(e.sim.hasSel(), false, "linewise highlight captured the native caret")
    assert.equal(e.selectedText(), "aa bb\n")
    const reads = e.sim.copyCalls
    await e.pressRaw("j")
    assert.equal(e.sim.focus, 9, "Vj did not preserve the column on the next row")
    assert.equal(e.selectedText(), "aa bb\ncc dd\n")
    assert.equal(e.sim.copyCalls, reads, "Vj performed a document read")
    await e.pressRaw("w")
    assert.equal(e.sim.focus, 12)
    assert.equal(e.selectedText(), text)
    await e.pressRaw("Escape")
    assert.equal(e.sim.focus, 12, "leaving V moved the actual caret")
    assert.equal(e.get("mode"), "normal")

    e = makeEnv(text, { settings: { dvorak: false } })
    await e.pressAll("V$l")
    assert.equal(e.sim.focus, 5, "Vl crossed the known EOL")
    await e.pressRaw("h")
    assert.equal(e.sim.focus, 4)

    e = makeEnv(text, { settings: { dvorak: false } })
    await e.pressAll("V3w")
    assert.equal(e.sim.focus, 9)
    assert.equal(e.selectedText(), "aa bb\ncc dd\n")
    await e.pressRaw("d")
    assert.equal(e.sim.text, "ee ff")

    e = makeEnv(text, { settings: { dvorak: false } })
    await e.pressAll("vwwV")
    assert.equal(e.sim.focus, 6)
    assert.equal(e.selectedText(), "aa bb\ncc dd\n", "charwise-to-linewise conversion lost the span")
    await e.pressRaw("v")
    assert.equal(e.sim.selText(), "aa bb\nc")

    // A plain click leaves Visual immediately without Copy; a drag retains
    // the native range and enters charwise Visual mode.
    for (const key of ["v", "V"]) {
        e = makeEnv(text, { settings: { dvorak: false } })
        await e.pressRaw(key)
        const copies = e.sim.copyCalls
        const event = { isTrusted: true, target: { closest: () => ({}) }, clientX: 100, clientY: 100, detail: 1 }
        e.documentListeners.mousedown(event)
        e.sim.setCaret(7)
        await e.documentListeners.mouseup(event)
        assert.equal(e.get("mode"), "normal")
        assert.equal(e.sim.focus, 7)
        assert.equal(e.sim.hasSel(), false)
        assert.equal(e.sim.copyCalls, copies)
        e.documentListeners.mousedown(event)
        e.sim.anchor = 7; e.sim.focus = 10
        await e.documentListeners.mouseup({ ...event, clientX: 130 })
        assert.equal(e.get("mode"), "visual")
        assert.equal(e.sim.selText(), "c d")
    }

    // A rendered match one step to the right corrects an adapter landing on
    // the preceding space. The search engine still chooses the occurrence.
    e = makeEnv("one hi two hi", { settings: { dvorak: false } })
    e.sim.setCaret(12)
    e.ctx.renderedContextAtCaret = () => ({ text: [...e.sim.text], at: e.sim.focus, char: e.sim.text[e.sim.focus], partial: false })
    const nativeKey = e.sim.key.bind(e.sim)
    let overstep = true
    e.sim.key = (detail) => {
        nativeKey(detail)
        if (overstep && detail.keyCode === 37 && !detail.mods.shift && e.get("managedTextMotion") > 0) {
            overstep = false
            nativeKey(detail)
        }
    }
    await query(e, "?", "hi")
    assert.equal(e.sim.focus, 11, "? landed before the first character of the match")

    // Delayed Docs scrolling after both successful and failed searches must
    // not replace the explicitly chosen viewport with the document bottom.
    for (const pattern of ["middle", "absent"]) {
        e = makeEnv("first row\nmiddle row\nlast row", { settings: { dvorak: false } })
        e.sim.setCaret(12)
        const view = { scrollTop: 20, scrollLeft: 0, isConnected: true, clientHeight: 200,
            getBoundingClientRect: () => ({ top: 0, bottom: 200, left: 0, width: 600 }) }
        const select = e.ctx.document.querySelector
        e.ctx.document.querySelector = (s) => s === ".kix-appview-editor" ? view : select(s)
        const caret = e.get("getCursorTop()"), nativeRect = caret.getBoundingClientRect.bind(caret)
        caret.getBoundingClientRect = () => {
            const rect = nativeRect()
            return { ...rect, top: rect.top - view.scrollTop, bottom: rect.bottom - view.scrollTop }
        }
        e.ctx.requestAnimationFrame = (fn) => setTimeout(fn, 16)
        const menu = e.sim.menu.bind(e.sim)
        e.sim.menu = (caption) => { menu(caption); if (caption === "Copy") setTimeout(() => { view.scrollTop = 900 }, 120) }
        await query(e, "/", pattern)
        await e.sleep(250)
        assert.equal(view.scrollTop, 20, pattern + " scrolled to a probe endpoint")
        assert.equal(e.sim.focus, pattern === "middle" ? 10 : 12)
    }

    // An OS/browser clipboard promise is allowed never to settle. Escape is
    // handled ahead of the queue and must wake the read, then accept movement.
    e = makeEnv("one two\nthree four", { settings: { dvorak: false } })
    e.ctx.navigator.clipboard.readText = () => new Promise(() => {})
    await e.pressRaw("w", false)
    await e.sleep(15)
    for (let i = 0; i < 10; i++) await e.pressRaw("j", false)
    await e.pressRaw("Escape")
    assert.equal(e.get("oracleBusy"), false)
    assert.equal(e.get("mode"), "normal")
    assert.equal(e.get("keyQueue.length"), 0)
    await e.pressRaw("l")
    assert.equal(e.sim.focus, 1)

    e = makeEnv("one two\nthree four", { settings: { dvorak: false } })
    e.ctx.navigator.clipboard.readText = () => Promise.reject(new Error("permission denied"))
    await e.pressRaw("V"); await e.pressRaw("j")
    assert.equal(e.get("mode"), "visualLine")
    assert.equal(e.sim.focus, 8, "Vj requires clipboard access despite having a native caret")
    await e.pressRaw("Escape")
    assert.equal(e.get("mode"), "normal")
    assert.equal(e.sim.focus, 8)

    e = makeEnv("one two", { settings: { dvorak: false } })
    e.ctx.navigator.clipboard.writeText = () => new Promise(() => {})
    await e.pressRaw("/"); await e.pressRaw("x"); await e.pressRaw("Enter", false)
    await e.sleep(20)
    await e.pressRaw("Escape")
    assert.equal(e.sim.focus, 0, "Escape moved an empty prefix probe")
    assert.equal(e.sim.hasSel(), false)
    assert.equal(e.get("oracleBusy"), false)
    await e.pressRaw("l")
    assert.equal(e.sim.focus, 1)

    e = makeEnv("one two\nthree four", { settings: { dvorak: false } })
    e.ctx.navigator.clipboard.writeText = () => new Promise(() => {})
    await e.pressRaw("w", false); await e.sleep(20)
    const click = { isTrusted: true, target: { closest: () => ({}) }, clientX: 100, clientY: 100, detail: 1 }
    e.documentListeners.mousedown(click)
    e.sim.setCaret(7)
    await e.documentListeners.mouseup(click)
    await e.settle()
    assert.equal(e.sim.focus, 7, "old cleanup moved the clicked caret")
    assert.equal(e.get("mode"), "normal")

    e = makeEnv("one two", { settings: { dvorak: false } })
    e.ctx.navigator.clipboard.readText = () => new Promise(() => {})
    await e.pressRaw("w") // finite timeout also recovers without Escape
    assert.equal(e.get("oracleBusy"), false)
    await e.pressRaw("l")
    assert.equal(e.sim.focus, 1)
    console.log("Linewise cursor/motions, mouse collapse, backward match alignment, late search scrolling, and stalled clipboard recovery passed")
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1) })
