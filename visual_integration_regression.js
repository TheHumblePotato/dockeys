const assert = require("node:assert/strict")
const { makeEnv } = require("./harness")

function mouse(target, extra = {}) {
    return { isTrusted: true, button: 0, target, clientX: 100, clientY: 100, detail: 1,
        preventDefault() {}, stopImmediatePropagation() {}, ...extra }
}
const editor = { closest: (selector) => selector === ".kix-appview-editor" ? editor : null }

async function main() {
    // Missing extension storage at startup and after an extension reload must
    // not break register edits, initialization, or Escape/queue recovery.
    for (const startup of [true, false]) {
        const warnings = []
        const e = makeEnv("one two\nthree four", { withoutStorage: startup, warn: (...args) => warnings.push(args), settings: { dvorak: false } })
        if (!startup) e.ctx.chrome.storage = undefined
        await e.pressAll('"adw')
        assert.equal(e.sim.text, "two\nthree four")
        assert.equal(e.get('registers.a'), "one ")
        assert.equal(e.get("mode"), "normal")
        await e.pressAll('"ap')
        assert.ok(e.sim.text.includes("one "))
        await e.pressAll("v"); await e.pressRaw("Escape")
        assert.equal(e.get("mode"), "normal")
        assert.equal(e.get("oracleBusy"), false)
        assert.equal(warnings.length, 0, "missing storage repeatedly logged exceptions")
    }

    // Shifted formatting must not enqueue a selection check that cannot run
    // in Visual mode. Native edits keep the range for Docs but leave Visual.
    let e = makeEnv("one two\nthree four", { settings: { dvorak: false } })
    await e.pressAll("vl")
    await e.pressRaw(">", true, { ctrlKey: true, shiftKey: true })
    assert.equal(e.get("pendingSelectionCheck"), null)
    await e.pressRaw("l")
    assert.equal(e.sim.selText(), "one")
    await e.pressRaw("x", true, { ctrlKey: true })
    assert.equal(e.get("mode"), "normal")
    assert.equal(e.sim.selText(), "one", "native cut lost its range before Docs handled it")
    await e.pressRaw("Escape")
    assert.equal(e.get("keyQueue.length"), 0)

    e = makeEnv("one two", { settings: { dvorak: false } })
    await e.pressAll("vl")
    const select = e.ctx.document.querySelectorAll
    e.ctx.document.querySelectorAll = (selector) => selector === ".kix-selection-overlay" ? [{ style: { display: "none" } }] : select(selector)
    e.sim.setCaret(2)
    await e.pressRaw("l")
    assert.equal(e.get("mode"), "normal", "an explicitly removed native range retained a Visual badge")
    assert.equal(e.sim.focus, 3)

    // Native shortcuts observe the complete linewise range, keep the logical
    // box cursor, and return to that cursor before the next Vim motion.
    for (const unit of ["display", "logical"]) {
        e = makeEnv("alpha beta\ngamma delta\nepsilon", { settings: { dvorak: false, visualVertical: unit } })
        e.sim.setCaret(2)
        await e.pressAll("Vj")
        const cursor = e.sim.focus
        const dispatch = e.ctx.window.dispatchEvent
        const shortcuts = []
        e.ctx.window.dispatchEvent = (event) => {
            if (event.type === "doc-keys-native-shortcut") shortcuts.push([event.detail.key, e.sim.selText()])
            else dispatch(event)
        }
        await e.pressRaw("m", true, { ctrlKey: true, altKey: true })
        assert.deepEqual(shortcuts, [["m", "alpha beta\ngamma delta\n"]])
        assert.equal(e.get("mode"), "visualLine")
        assert.equal(e.get("linewiseState.externalRange.cursor.point.x"), 66)
        await e.pressRaw(">", true, { ctrlKey: true, shiftKey: true })
        assert.equal(shortcuts.length, 2)
        assert.equal(e.sim.selText(), "alpha beta\ngamma delta\n")
        await e.pressRaw("h")
        assert.equal(e.sim.focus, cursor - 1, "formatting lost the logical linewise cursor")
        assert.equal(e.get("mode"), "visualLine")
        assert.equal(e.sim.hasSel(), false)
        await e.pressRaw("Escape")
        assert.equal(e.get("mode"), "normal")
    }

    // Formatting can reflow paragraphs. Relative range offsets must restore
    // the original character on the new layout rather than its old pixels.
    e = makeEnv("alpha beta\ngamma delta\nepsilon", { settings: { dvorak: false } })
    e.sim.setCaret(2); await e.pressAll("Vj")
    await e.pressRaw("m", true, { ctrlKey: true, altKey: true })
    const pointAt = e.sim.pointAt.bind(e.sim)
    e.sim.pointAt = (at) => { const point = pointAt(at); return { x: point.x * 1.5, y: point.y * 1.5 } }
    await e.pressRaw("h")
    assert.equal(e.sim.focus, 12)
    assert.equal(e.get("linewiseState.point.x"), 99)

    e = makeEnv("alpha beta\ngamma delta", { settings: { dvorak: false } })
    await e.pressAll("Vj")
    await e.get("prepareLinewiseExternalSelection()")
    await e.settle()
    e.get('handleNativeInput({inputType:"formatBold"})')
    assert.equal(e.get("mode"), "visualLine")
    const nativeRange = e.sim.selText()
    e.get('handleNativeInput({inputType:"deleteByCut"})')
    assert.equal(e.get("mode"), "normal")
    assert.equal(e.sim.selText(), nativeRange, "native context cut lost its range before the edit")

    // A toolbar click is replayed once, after range preparation. The native
    // selection remains available for subsequent font/menu actions.
    e = makeEnv("alpha beta\ngamma delta\nepsilon", { settings: { dvorak: false } })
    e.sim.setCaret(2)
    await e.pressAll("Vj")
    const clicks = []
    const button = { isConnected: true, closest: (selector) => selector === ".kix-appview-editor" ? null : button,
        focus() {}, dispatchEvent(event) { if (event.type === "click") clicks.push(e.sim.selText()) } }
    await e.documentListeners.mousedown(mouse(button))
    await e.documentListeners.mouseup(mouse(button))
    await e.documentListeners.click(mouse(button))
    await e.settle()
    assert.deepEqual(clicks, ["alpha beta\ngamma delta\n"])
    assert.equal(e.get("mode"), "visualLine")
    await e.pressRaw("Escape")
    assert.equal(e.sim.focus, 13)

    // Right-click preserves both Visual modes. Linewise context menus receive
    // an actual range even if the trusted contextmenu arrives before Copy.
    for (const mode of ["v", "V"]) {
        e = makeEnv("alpha beta\ngamma delta\nepsilon", { settings: { dvorak: false } })
        await e.pressAll(mode + "j")
        const expected = e.get("mode"), contextRanges = []
        e.ctx.MouseEvent = class { constructor(type, args) { this.type = type; Object.assign(this, args) } }
        const target = { closest: editor.closest, dispatchEvent(event) { if (event.type === "contextmenu") contextRanges.push(e.sim.selText()) } }
        await e.documentListeners.mousedown(mouse(target, { button: 2 }))
        await e.documentListeners.contextmenu(mouse(target, { button: 2 }))
        await e.documentListeners.mouseup(mouse(target, { button: 2 }))
        await e.settle()
        assert.equal(e.get("mode"), expected)
        if (mode === "V") {
            assert.equal(e.sim.selText(), "alpha beta\ngamma delta\n")
            assert.deepEqual(contextRanges, ["alpha beta\ngamma delta\n"])
        }
        const outside = { closest: () => null }
        await e.documentListeners.mousedown(mouse(outside)); await e.documentListeners.mouseup(mouse(outside))
        assert.equal(e.get("mode"), expected)
        await e.pressRaw("Escape")
        assert.equal(e.get("mode"), "normal")
    }

    // Same-position clicks retain the modeled range; moving clicks return to
    // Normal, and native drag selections still enter charwise Visual.
    e = makeEnv("alpha beta\ngamma delta", { settings: { dvorak: false } })
    await e.pressAll("vll")
    const focus = e.sim.focus - 1
    await e.documentListeners.mousedown(mouse(editor))
    e.sim.setCaret(focus)
    await e.documentListeners.mouseup(mouse(editor))
    assert.equal(e.get("mode"), "visual")
    assert.equal(e.sim.selText(), "alp")
    await e.documentListeners.mousedown(mouse(editor))
    e.sim.setCaret(15)
    await e.documentListeners.mouseup(mouse(editor))
    assert.equal(e.get("mode"), "normal")
    assert.equal(e.sim.focus, 15)

    console.log("Storage fallback, Visual shortcut/queue recovery, linewise formatting/context ranges, toolbar and mouse behavior passed")
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1) })
