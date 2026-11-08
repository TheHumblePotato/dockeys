const assert = require("node:assert/strict")
const { makeEnv } = require("./harness")

function viewport(e) {
    const outer = { scrollTop: 23, scrollLeft: 7, scrollHeight: 1500, clientHeight: 600 }
    const view = { scrollTop: 240, scrollLeft: 19, isConnected: true, parentElement: outer,
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 600, bottom: 600, height: 600 }) }
    const query = e.ctx.document.querySelector
    e.ctx.document.querySelector = (selector) => selector === ".kix-appview-editor" ? view : query(selector)
    return { view, outer }
}

function selectionMarkup(e) {
    const query = e.ctx.document.querySelectorAll
    const overlay = { get style() { return { display: e.sim.hasSel() ? "block" : "none" } },
        getBoundingClientRect: () => ({ left: e.sim.selRange()[0] * 8 + 50, top: 60, width: e.sim.selText().length * 8, height: 16 }) }
    e.ctx.document.querySelectorAll = (selector) => selector === ".kix-selection-overlay" ? [overlay] : query(selector)
}

async function main() {
    const source = "alpha beta\ngamma delta\nomega psi"
    for (const [keys, expected, mode] of [
        ["dw", "alpha \ngamma delta\nomega psi", "normal"],
        ["cw", "alpha \ngamma delta\nomega psi", "insert"],
        ["D", "alpha \ngamma delta\nomega psi", "normal"],
        ["C", "alpha \ngamma delta\nomega psi", "insert"],
        ["2D", "alpha \nomega psi", "normal"],
        ["dl", "alpha eta\ngamma delta\nomega psi", "normal"],
        ["cl", "alpha eta\ngamma delta\nomega psi", "insert"],
        ["vld", "alpha ta\ngamma delta\nomega psi", "normal"],
        ["vlc", "alpha ta\ngamma delta\nomega psi", "insert"],
        ["Vd", "gamma delta\nomega psi", "normal"],
        ["Vc", "\ngamma delta\nomega psi", "insert"],
        ['"_dw', "alpha \ngamma delta\nomega psi", "normal"],
    ]) {
        const e = makeEnv(source, { settings: { dvorak: false } })
        e.sim.setCaret(6)
        const { view, outer } = viewport(e)
        const key = e.sim.key.bind(e.sim), menu = e.sim.menu.bind(e.sim)
        const jump = () => { view.scrollTop = 0; view.scrollLeft = 0; outer.scrollTop = 0; outer.scrollLeft = 0 }
        e.sim.key = (event) => {
            key(event)
            if (e.get("editViewport")) { jump(); if (event.keyCode === 8) setTimeout(jump, 70) }
        }
        e.sim.menu = (caption) => { menu(caption); if (caption === "Copy" && e.get("editViewport")) jump() }
        await e.pressAll(keys)
        await e.sleep(100)
        assert.equal(e.sim.text, expected, keys + " edited the wrong range")
        assert.equal(e.get("mode"), mode)
        assert.deepEqual([view.scrollTop, view.scrollLeft, outer.scrollTop, outer.scrollLeft], [240, 19, 23, 7], keys + " moved the viewport")
        e.get("cancelEditViewport()")
    }

    // An explicit user scroll supersedes the edit's settlement frames.
    let e = makeEnv("one two three", { settings: { dvorak: false } })
    let { view } = viewport(e)
    await e.pressAll("dw")
    e.documentListeners.wheel({ isTrusted: true, deltaY: 80 })
    view.scrollTop = 320
    await e.sleep(50)
    assert.equal(view.scrollTop, 320)
    assert.equal(e.get("editViewport"), null)
    await e.pressRaw("j")

    e = makeEnv("one two three", { settings: { dvorak: false } })
    ;({ view } = viewport(e))
    await e.pressAll("dw.")
    assert.equal(e.sim.text, "three")
    assert.equal(view.scrollTop, 240)
    await e.pressRaw("e", true, { ctrlKey: true })
    assert.equal(view.scrollTop, 256, "the edit lease overrode Ctrl+e")
    e.get("cancelEditViewport()")

    // Docs can restore a range asynchronously, in either direction. Never
    // move left on an empty undo result, or let the next d act on that range.
    for (const command of ["u", "ctrl-z", "ctrl-shift-z", "ctrl-r"]) {
        for (const reverse of [false, true]) {
            e = makeEnv("alpha beta", { settings: { dvorak: false } })
            selectionMarkup(e)
            const menu = e.sim.menu.bind(e.sim)
            const restored = () => setTimeout(() => {
                e.sim.anchor = reverse ? 5 : 1; e.sim.focus = reverse ? 1 : 5
                e.get('handleNativeInput({inputType:"historyUndo"})')
            }, 65)
            e.sim.menu = (caption) => { menu(caption); if (caption === "Undo" || caption === "Redo") restored() }
            if (command === "u") await e.pressRaw("u")
            else if (command === "ctrl-r") await e.pressRaw("r", true, { ctrlKey: true })
            else {
                await e.pressRaw("z", false, { ctrlKey: true, shiftKey: command === "ctrl-shift-z" })
                restored() // The real trusted key reaches Docs after our handler.
                await e.settle()
            }
            assert.equal(e.get("mode"), "normal", command)
            assert.equal(e.sim.hasSel(), false, command + " left a range labeled Normal")
            assert.equal(e.sim.focus, 1, command + " did not collapse to the restored range start")
            await e.pressRaw("l")
            assert.equal(e.sim.focus, 2, command + " moved an extra character after cleanup")
            e.get("cancelEditViewport()")
        }
    }

    e = makeEnv("alpha beta", { settings: { dvorak: false } })
    selectionMarkup(e)
    e.sim.setCaret(4)
    await e.pressRaw("u")
    assert.equal(e.sim.focus, 4, "an empty undo selection caused an extra Left")
    assert.equal(e.sim.copyCalls, 0, "an explicitly empty native range need not be Copied")

    // Clipboard denial keeps a real restored range and accurately enters
    // Visual, rather than guessing a collapse or leaving an invalid badge.
    e = makeEnv("alpha beta", { settings: { dvorak: false } })
    selectionMarkup(e)
    const menu = e.sim.menu.bind(e.sim)
    e.sim.menu = (caption) => { menu(caption); if (caption === "Undo") { e.sim.anchor = 1; e.sim.focus = 5 } }
    e.ctx.navigator.clipboard.readText = () => Promise.reject(Error("denied"))
    await e.pressRaw("u")
    assert.equal(e.get("mode"), "visual")
    assert.equal(e.sim.selText(), "lpha")

    e = makeEnv("alpha beta", { settings: { dvorak: false } })
    selectionMarkup(e)
    const lateMenu = e.sim.menu.bind(e.sim)
    e.sim.menu = (caption) => {
        lateMenu(caption)
        if (caption === "Undo") setTimeout(() => { e.sim.anchor = 5; e.sim.focus = 1 }, 300)
    }
    await e.pressRaw("u")
    assert.equal(e.get("mode"), "normal")
    await e.sleep(180)
    e.get("overlayFrame()")
    assert.equal(e.get("mode"), "visual", "late native history left a range mislabeled Normal")
    assert.equal(e.get("nativeVisualFocusAfter"), false, "a backward restored range acquired a forward cursor")
    assert.equal(e.sim.copyCalls, 0, "late reconciliation initiated an idle clipboard read")

    e = makeEnv("alpha beta", { settings: { dvorak: false } })
    selectionMarkup(e)
    e.sim.clipboard = "keep me"
    e.sim.menu = (caption) => { if (caption === "Undo") { e.sim.anchor = 1; e.sim.focus = 5 } }
    await e.pressRaw("u")
    assert.equal(e.get("mode"), "visual", "an unresponsive Copy was mistaken for an empty native range")
    assert.equal(e.sim.focus, 5)
    assert.equal(e.sim.clipboard, "keep me")

    e = makeEnv("alpha beta", { settings: { dvorak: false } })
    selectionMarkup(e)
    const collapsingCopy = e.sim.menu.bind(e.sim)
    e.sim.menu = (caption) => {
        if (caption === "Undo") { e.sim.anchor = 1; e.sim.focus = 5 }
        else { collapsingCopy(caption); if (caption === "Copy") e.sim.setCaret(5) }
    }
    await e.pressRaw("u")
    assert.equal(e.get("mode"), "normal")
    assert.equal(e.sim.hasSel(), false)
    assert.equal(e.sim.focus, 5, "Copy already collapsed the range; cleanup sent an extra Left")

    e = makeEnv("alpha beta", { settings: { dvorak: false } })
    e.ctx.requestAnimationFrame = (fn) => setTimeout(fn, 16)
    const baseQuery = e.ctx.document.querySelectorAll
    let paintAt = Infinity
    e.ctx.document.querySelectorAll = (selector) => selector === ".kix-selection-overlay" ? [{
        get style() { return { display: e.sim.hasSel() && Date.now() >= paintAt ? "block" : "none" } },
        getBoundingClientRect: () => ({ left: 58, top: 60, width: 32, height: 16 }),
    }] : baseQuery(selector)
    const paintMenu = e.sim.menu.bind(e.sim)
    e.sim.menu = (caption) => {
        paintMenu(caption)
        if (caption === "Undo") setTimeout(() => {
            e.sim.anchor = 1; e.sim.focus = 5; paintAt = Date.now() + 80
            e.get('handleNativeInput({inputType:"historyUndo"})')
        }, 60)
    }
    await e.pressRaw("u")
    assert.equal(e.sim.hasSel(), false, "history cleanup ended before delayed selection paint")
    assert.equal(e.get("mode"), "normal")

    e = makeEnv("alpha beta", { settings: { dvorak: false } })
    selectionMarkup(e)
    e.sim.menu = (caption) => { if (caption === "Undo") { e.sim.anchor = 1; e.sim.focus = 5 } }
    e.ctx.navigator.clipboard.readText = () => new Promise(() => {})
    await e.pressRaw("u", false); await e.sleep(20)
    await e.pressRaw("Escape", false)
    e.sim.setCaret(8)
    await e.settle()
    assert.equal(e.sim.focus, 8, "cancelled undo cleanup moved a newer cursor")
    assert.equal(e.get("mode"), "normal")
    assert.equal(e.get("keyQueue.length"), 0)

    e = makeEnv("alpha beta", { settings: { dvorak: false } })
    selectionMarkup(e)
    e.sim.menu = (caption) => { if (caption === "Undo") { e.sim.anchor = 1; e.sim.focus = 5 } }
    e.ctx.navigator.clipboard.readText = () => new Promise(() => {})
    await e.pressRaw("u", false); await e.sleep(20)
    e.sim.setCaret(8)
    const clicked = Date.now()
    await e.documentListeners.mousedown({ isTrusted: true, button: 2, target: { closest: () => ({}) } })
    await e.settle()
    assert.ok(Date.now() - clicked < 250, "right-click waited for a stalled history read")
    assert.equal(e.sim.focus, 8)
    assert.equal(e.get("mode"), "normal")

    console.log("Undo/redo selection recovery, empty/denied Copy, d/c viewport protection, ancestors, counts, repeat, and user scroll passed")
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1) })
