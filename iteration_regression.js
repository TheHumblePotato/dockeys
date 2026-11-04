const assert = require("node:assert/strict")
const { makeEnv } = require("./harness")

async function query(env, prefix, text) {
    await env.pressAll(prefix)
    for (const char of text) await env.pressRaw(char)
    await env.pressRaw("Enter")
}

async function main() {
    for (const wordMotion of ["native", "precise"]) {
        let e = makeEnv("one two.three\n\nfour five\nsix", { settings: { dvorak: false, wordMotion } })
        await e.pressRaw("w")
        assert.equal(e.sim.focus, 4)
        assert.equal(e.sim.copyCalls, 1, "first forward motion copies only the suffix")
        await e.pressRaw("w")
        assert.equal(e.sim.focus, 7, "punctuation remains a separate Vim word in fast mode")
        await e.pressRaw("w")
        assert.equal(e.sim.focus, 8)
        assert.equal(e.sim.copyCalls, 1, "a motion burst reuses the snapshot")
        await e.pressRaw("b")
        assert.equal(e.sim.focus, 7)
        assert.equal(e.sim.copyCalls, 1)
        e.get("textSnapshot.created -= 600")
        await e.pressRaw("w")
        assert.equal(e.sim.copyCalls, wordMotion === "precise" ? 2 : 1)

        e = makeEnv("one two\nthree four\nfive", { settings: { dvorak: false, wordMotion } })
        e.ctx.getCursorFontInfo = () => ({ fontSize: `${16 / 1.15}px`, fontFamily: "monospace", fontWeight: "400" })
        e.ctx.measureCharWidth = () => 8
        await e.pressAll("vww")
        assert.equal(e.sim.selText(), "one two\nt")
        assert.equal(e.get("visualModel.c"), 8)
        e.get("renderOverlay()")
        assert.equal(e.get("cursorBoxOverlay.style.left"), "50px", "box is on the cursor character, not its outer selection boundary")
        await e.pressRaw("b")
        assert.equal(e.sim.selText(), "one t")
        await e.pressRaw("e")
        assert.equal(e.sim.selText(), "one two")
        const copies = e.sim.copyCalls
        await e.pressAll("wwbb")
        assert.equal(e.sim.copyCalls, copies, "cross-line visual words perform no further reads")
        await e.pressRaw("Escape")
        assert.equal(e.sim.focus, 4)

        e = makeEnv("one hi two hi three", { settings: { dvorak: false, wordMotion } })
        await query(e, "d/", "hi")
        assert.equal(e.sim.text, "hi two hi three")
        await e.pressRaw(".")
        assert.equal(e.sim.text, "hi three", "dot repeat re-evaluates the search from the new position")
        e = makeEnv("aaa", { settings: { dvorak: false, wordMotion } })
        await query(e, "/", "aa")
        assert.equal(e.sim.focus, 1, "searches may overlap")
        await e.pressRaw("n")
        assert.equal(e.sim.focus, 0, "search wraps")
        e = makeEnv("one HI\nhi", { settings: { dvorak: false, wordMotion } })
        await query(e, "/", "hi\\c")
        assert.equal(e.sim.focus, 4)
        await e.pressRaw("n")
        assert.equal(e.sim.focus, 7)
        await query(e, "?", "missing")
        assert.equal(e.sim.focus, 7)
        assert.match(e.get("searchOverlay.textContent"), /Pattern not found/)
        await e.pressAll("d/")
        await e.pressRaw("x")
        await e.pressRaw("Escape")
        assert.equal(e.get("mode"), "normal")
        assert.equal(e.sim.text, "one HI\nhi")

        e = makeEnv("a b c d e f g", { settings: { dvorak: false, wordMotion } })
        await e.pressAll("2d3w")
        assert.equal(e.sim.text, "g", "operator and motion counts multiply")
        e = makeEnv("foo bar", { settings: { dvorak: false, wordMotion } })
        await e.pressAll("cw")
        assert.equal(e.sim.text, " bar", "cw preserves trailing whitespace")
        e = makeEnv("foo\nbar", { settings: { dvorak: false, wordMotion } })
        await e.pressAll("dw")
        assert.equal(e.sim.text, "\nbar", "dw on the final word does not join the next paragraph")

        e = makeEnv(Array(50).fill("word").join(" "), { settings: { dvorak: false, wordMotion } })
        await e.pressRaw("v")
        const caret = e.get("getCursorTop()")
        const originalRect = caret.getBoundingClientRect.bind(caret)
        let geometryReads = 0
        caret.getBoundingClientRect = () => { geometryReads++; return originalRect() }
        await e.pressAll("20w")
        assert.equal(e.get("visualModel.c"), 100)
        assert.ok(geometryReads < 20, "long visual motions must not force layout for every character")
    }

    // No idle clipboard work, even when recovery was flagged and the user scrolls.
    let e = makeEnv("one two", { settings: { dvorak: false } })
    e.get("noteSelectionGlitch(); scheduleSelectionCheck()")
    e.documentListeners.wheel({ isTrusted: true, deltaY: 90 })
    await e.sleep(180)
    assert.equal(e.sim.copyCalls, 0)
    assert.equal(e.sim.keyLog.length, 0)

    // A read and its late animation-frame restore both preserve wheel intent.
    e = makeEnv("one two", { settings: { dvorak: false } })
    const scroller = { scrollTop: 1000, scrollLeft: 0, isConnected: true }
    e.ctx.document.querySelector = (s) => s === ".kix-appview-editor" ? scroller : null
    e.get("docsScrollContainer = null")
    const frames = []
    e.ctx.requestAnimationFrame = (fn) => frames.push(fn)
    const pending = e.get("withViewportPreserved(async () => { sendKeyEvent('end', { shift: true }); await new Promise(resolve => setTimeout(resolve, 30)); sendKeyEvent('left') })")
    e.documentListeners.wheel({ isTrusted: true, deltaY: 80, deltaMode: 0 })
    scroller.scrollTop = 500 // simulate Docs scrolling to its temporary selection
    await pending
    assert.equal(scroller.scrollTop, 1080)
    e.documentListeners.wheel({ isTrusted: true, deltaY: 100, deltaMode: 0 })
    scroller.scrollTop = 1180
    for (const frame of frames) frame()
    assert.equal(scroller.scrollTop, 1180, "a late read frame must not undo a subsequent wheel event")

    e = makeEnv("one two three", { settings: { dvorak: false, wordMotion: "precise" }, copyDelay: 30 })
    scroller.scrollTop = 1000
    e.ctx.document.querySelector = (s) => s === ".kix-appview-editor" ? scroller : null
    e.get("docsScrollContainer = null")
    const dispatch = e.ctx.window.dispatchEvent
    e.ctx.window.dispatchEvent = (event) => { dispatch(event); scroller.scrollTop = 123 }
    await e.pressRaw("w", false)
    await e.sleep(5)
    e.documentListeners.wheel({ isTrusted: true, deltaY: 90, deltaMode: 0 })
    await e.settle()
    assert.equal(e.sim.focus, 4)
    assert.equal(scroller.scrollTop, 1090, "a motion completing after a wheel gesture must not pull the view back")
    console.log("Cache, exact word modes, visual box geometry, custom search, counts, and scroll races passed")
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1) })
