const assert = require("node:assert/strict")
const { makeEnv } = require("./harness")

async function query(e, prefix, pattern) {
    await e.pressAll(prefix)
    for (const char of pattern) await e.pressRaw(char)
    await e.pressRaw("Enter")
}

async function main() {
    // Wrapped rows belong to one paragraph. j must move one visible row with
    // bounded key volume, regardless of the paragraph's total length.
    let e = makeEnv("x".repeat(2000), { settings: { dvorak: false } })
    const rowWidth = 20
    e.sim.lineInfo = (off) => {
        const start = Math.floor(Math.min(off, e.sim.text.length - 1) / rowWidth) * rowWidth
        return { start, end: Math.min(e.sim.text.length, start + rowWidth) }
    }
    const caret = e.get("getCursorTop()")
    caret.getBoundingClientRect = () => {
        const line = e.sim.lineInfo(e.sim.focus), top = line.start / rowWidth * 20 + 60
        return { left: (e.sim.focus - line.start) * 8 + 50, top, height: 16, bottom: top + 16 }
    }
    e.sim.setCaret(2)
    await e.pressRaw("v")
    const copies = e.sim.copyCalls
    e.sim.keyLog.length = 0
    await e.pressAll("jjk")
    assert.equal(e.sim.selText().length, 21)
    assert.equal(e.sim.focus, 23)
    assert.equal(e.sim.copyCalls, copies, "ordinary Visual rows must not read the clipboard")
    assert.ok(e.sim.keyLog.length < 20, "Visual j/k walked the whole paragraph")
    await e.pressAll("3j")
    assert.equal(e.sim.focus, 83, "counted Visual j moved only one row")

    // Paint-lagged geometry must not report an anchor crossing using the old
    // row. Keep the actual selection state synchronous, as Docs' key handler
    // does, while delaying only its caret rectangle.
    e = makeEnv("abcdefgh\nabcdefgh\nabcdefgh", { settings: { dvorak: false } })
    e.sim.setCaret(12)
    const delayedCaret = e.get("getCursorTop()"), liveRect = delayedCaret.getBoundingClientRect.bind(delayedCaret)
    let oldRect = liveRect(), paintAt = 0
    const paintKey = e.sim.key.bind(e.sim)
    e.sim.key = (detail) => { oldRect = liveRect(); paintKey(detail); paintAt = Date.now() + 12 }
    delayedCaret.getBoundingClientRect = () => Date.now() < paintAt ? oldRect : liveRect()
    e.ctx.requestAnimationFrame = (fn) => setTimeout(fn, 16)
    await e.pressAll("vkj")
    assert.equal(e.sim.selText(), "d", "delayed vertical paint reversed the selection anchor")
    await e.pressRaw("Escape")
    await e.pressAll("vjw")
    assert.equal(e.sim.selText(), e.sim.text.slice(12), "a word after native j read from an unpainted caret")

    for (const linewise of [false, true]) {
        e = makeEnv("abcdefgh\nabcdefgh\nabcdefgh", { settings: { dvorak: false } })
        e.sim.setCaret(3)
        await e.pressRaw(linewise ? "V" : "v")
        const caret = e.get("getCursorTop()"), live = caret.getBoundingClientRect.bind(caret)
        let previous = live(), due = 0
        const dispatch = e.sim.key.bind(e.sim)
        e.sim.key = (detail) => { previous = live(); dispatch(detail); due = Date.now() + 80 }
        caret.getBoundingClientRect = () => Date.now() < due ? previous : live()
        e.ctx.requestAnimationFrame = (fn) => setTimeout(fn, 16)
        await e.pressAll("jjkk")
        assert.equal(e.sim.focus, linewise ? 3 : 4, "80ms caret paint made j/k move by characters")
        if (!linewise) assert.equal(e.sim.selText(), "d")
        assert.equal(e.get("mode"), linewise ? "visualLine" : "visual")
    }

    for (const middle of ["x", ""]) {
        e = makeEnv("abcdefgh\n" + middle + "\nabcdefgh", { settings: { dvorak: false } })
        e.ctx.measureCharWidth = () => 8
        e.sim.setCaret(3)
        await e.pressAll("vj")
        assert.equal(e.sim.selText(), "defgh\n" + middle + "\n", "short row did not include Vim's valid EOL cursor")
        e.get("renderOverlay()")
        assert.equal(e.get("cursorBoxOverlay.style.left"), `${50 + middle.length * 8}px`, "the newline cursor box followed the native range into the next row")
        assert.equal(e.get("cursorBoxOverlay.style.top"), "80px")
        await e.pressAll("jkk")
        assert.equal(e.sim.selText(), "d", "short/empty row lost the preferred column")
    }

    // Promotion must protect the collapse, full read, and reconstruction,
    // rather than capturing the viewport after the first disruptive step.
    e = makeEnv("one two\nthree four\nfive six", { settings: { dvorak: false } })
    const scroller = { scrollTop: 100, scrollLeft: 0, isConnected: true }
    const originalQuery = e.ctx.document.querySelector
    e.ctx.document.querySelector = (s) => s === ".kix-appview-editor" ? scroller : originalQuery(s)
    e.ctx.renderedContextAtCaret = () => ({ text: [..."one two"], at: 0, char: "o", partial: true, rendered: true })
    const nativeKey = e.sim.key.bind(e.sim)
    e.sim.key = (detail) => { nativeKey(detail); if (e.get("oracleBusy")) scroller.scrollTop = 900 }
    await e.pressAll("vww")
    assert.equal(e.sim.selText(), "one two\nt")
    assert.equal(scroller.scrollTop, 100, "Visual promotion scrolled to a probe endpoint")

    // Ctrl+e/y are intentional viewport changes too. A pending read settlement
    // must not undo them just because these commands send no caret key event.
    e = makeEnv("one two", { settings: { dvorak: false } })
    const scrollView = { scrollTop: 100, scrollLeft: 0, isConnected: true }
    const querySelector = e.ctx.document.querySelector
    e.ctx.document.querySelector = (s) => s === ".kix-appview-editor" ? scrollView : querySelector(s)
    const frames = []
    e.ctx.requestAnimationFrame = (fn) => frames.push(fn)
    await e.get("withViewportPreserved(async () => {})")
    await e.pressRaw("e", true, { ctrlKey: true })
    for (const frame of frames.slice()) frame()
    assert.equal(scrollView.scrollTop, 116, "late read restoration undid Ctrl+e")

    // Fresh, uncached no-match searches leave both the caret and document
    // unchanged, including backward and operator searches.
    for (const prefix of ["/", "?", "d/", "c?", "y/"]) {
        e = makeEnv("first row\nmiddle row\nlast row", { settings: { dvorak: false } })
        e.sim.setCaret(12)
        const original = e.sim.text
        await query(e, prefix, "absent")
        assert.equal(e.sim.focus, 12, prefix + " moved after no match")
        assert.equal(e.sim.hasSel(), false)
        assert.equal(e.sim.text, original)
        assert.match(e.get("searchOverlay.textContent"), /Pattern not found/)
    }

    // A menu integration may collapse the selection before Copy completes.
    // A second collapse arrow must not turn into a document-boundary jump.
    e = makeEnv("first row\nmiddle row\nlast row", { settings: { dvorak: false } })
    e.sim.setCaret(12)
    const copyMenu = e.sim.menu.bind(e.sim)
    e.sim.menu = (caption) => { copyMenu(caption); if (caption === "Copy") e.sim.setCaret(e.sim.focus) }
    await query(e, "/", "absent")
    assert.equal(e.sim.focus, 12)
    assert.equal(e.sim.hasSel(), false)
    assert.match(e.get("searchOverlay.textContent"), /Pattern not found/)

    // Reproduce Docs delaying its caret paint while Copy never replaces the
    // sentinel. The pre-Copy rectangle cannot prove the selection is empty.
    e = makeEnv("first row\nmiddle row\nlast row", { settings: { dvorak: false } })
    e.sim.setCaret(12)
    const failedCaret = e.get("getCursorTop()"), rect = failedCaret.getBoundingClientRect.bind(failedCaret)
    let staleUntil = 0, staleRect = rect()
    const key = e.sim.key.bind(e.sim)
    e.sim.key = (detail) => { staleRect = rect(); key(detail); staleUntil = Date.now() + 12 }
    failedCaret.getBoundingClientRect = () => Date.now() < staleUntil ? staleRect : rect()
    e.ctx.requestAnimationFrame = (fn) => setTimeout(fn, 16)
    e.sim.menu = () => {} // disabled/failed native Copy
    await query(e, "/", "absent")
    assert.equal(e.sim.focus, 12, "failed Copy stranded the cursor at a document boundary")
    assert.equal(e.sim.hasSel(), false)
    assert.match(e.get("searchOverlay.textContent"), /Search unavailable/)

    // A failed promotion retains the genuine Visual selection.
    e = makeEnv("one two\nthree four", { settings: { dvorak: false } })
    e.ctx.renderedContextAtCaret = () => ({ text: [..."one two"], at: 0, char: "o", partial: true })
    await e.pressRaw("v")
    const selected = e.sim.selText()
    e.sim.menu = () => {}
    await query(e, "/", "absent")
    assert.equal(e.sim.selText(), selected)
    assert.equal(e.get("mode"), "visual")

    // Query history edits the command line without selecting or probing text.
    e = makeEnv("one two one", { settings: { dvorak: false } })
    await query(e, "/", "two")
    const historyCopies = e.sim.copyCalls
    await e.pressRaw("/"); await e.pressRaw("x")
    await e.pressRaw("ArrowUp")
    assert.equal(e.get("searchState.query"), "two")
    await e.pressRaw("ArrowDown")
    assert.equal(e.get("searchState.query"), "x")
    assert.equal(e.sim.copyCalls, historyCopies)
    await e.pressRaw("Escape")

    // Color changes repaint a stationary cursor, and invalid CSS is rejected.
    e.ctx.getCursorFontInfo = () => ({ fontSize: "16px", fontFamily: "monospace", fontWeight: "400" })
    e.ctx.measureCharWidth = () => 8
    e.get("renderOverlay()")
    e.changeSettings({ dvorak: false, cursorColor: "#ff3300" })
    e.get("renderOverlay()")
    assert.equal(e.get("cursorBoxOverlay.style.backgroundColor"), "#ff330080")
    e.changeSettings({ cursorColor: "url(bad)" })
    assert.equal(e.get("settings.cursorColor"), "#1a73e8")
    console.log("Wrapped Visual rows, protected promotion, no-match/failed reads, search history, and cursor color passed")
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1) })
