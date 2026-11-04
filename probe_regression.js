const assert = require("node:assert/strict")
const { makeEnv } = require("./harness")

async function main() {
    const text = Array.from({ length: 100 }, (_, i) => `row${i} alpha beta`).join("\n")
    let e = makeEnv(text, { settings: { dvorak: false, readStrategy: "clipboard" } })
    const copied = [], keys = []
    const menu = e.sim.menu.bind(e.sim)
    e.sim.menu = (caption) => { if (caption === "Copy") copied.push(e.sim.selText()); menu(caption) }
    const dispatch = e.ctx.window.dispatchEvent
    e.ctx.window.dispatchEvent = (event) => {
        if (event.type === "doc-keys-simulate-keypress") keys.push(event.detail)
        dispatch(event)
    }
    await e.pressRaw("w")
    assert.equal(e.sim.focus, 5)
    assert.equal(copied.length, 1)
    assert.ok(copied[0].length < 80, "word probe copied an unbounded document tail")
    assert.ok(!keys.some((k) => [35, 36].includes(k.keyCode) && (k.mods.control || k.mods.meta)), "word probe jumped to document boundaries")
    e.sim.setCaret(text.indexOf("row50"))
    e.get("invalidateExternalText()")
    copied.length = 0; keys.length = 0
    await e.pressRaw("b")
    assert.equal(e.sim.focus, text.indexOf("row49") + "row49 alpha ".length)
    assert.ok(copied.every((value) => value.length < 150))
    assert.ok(!keys.some((k) => [35, 36].includes(k.keyCode) && (k.mods.control || k.mods.meta)))

    // Masks and page-world leases must be paired even on exceptions.
    e = makeEnv("one two", { settings: { dvorak: false } })
    const phases = []
    const originalDispatch = e.ctx.window.dispatchEvent
    e.ctx.window.dispatchEvent = (event) => {
        if (event.type === "doc-keys-read-phase") phases.push(event.detail.active)
        originalDispatch(event)
    }
    await assert.rejects(e.get("withViewportPreserved(async () => { if (!document.documentElement.hasAttribute('data-docskeys-reading')) throw new Error('missing mask'); throw new Error('probe failure') })"), /probe failure/)
    assert.deepEqual(phases, [true, false])
    assert.equal(e.get("readPresentationDepth"), 0)
    assert.equal(e.get("viewportRead"), null)
    assert.equal(e.ctx.document.documentElement.hasAttribute("data-docskeys-reading"), false)

    // Rendered-only mode must never fall back to a clipboard document probe.
    e = makeEnv("one two\nthree", { settings: { dvorak: false, readStrategy: "rendered" } })
    await e.pressRaw("w")
    assert.equal(e.sim.copyCalls, 0)
    assert.equal(e.sim.focus, 0)
    await e.pressRaw("v")
    const selection = e.sim.selText()
    await e.pressRaw("w")
    assert.equal(e.sim.copyCalls, 0)
    assert.equal(e.sim.selText(), selection)
    await e.pressRaw("Escape")
    await e.pressRaw("/")
    await e.pressRaw("t")
    await e.pressRaw("Enter")
    assert.equal(e.sim.copyCalls, 0)

    // View placement is a read-free operation and preserves the caret.
    e = makeEnv("one two", { settings: { dvorak: false } })
    const scroller = { scrollTop: 1000, clientHeight: 200, isConnected: true,
        getBoundingClientRect: () => ({ top: 0, height: 200 }) }
    e.ctx.document.querySelector = (s) => s === ".kix-appview-editor" ? scroller : null
    e.get("docsScrollContainer = null")
    await e.pressAll("zz")
    assert.equal(scroller.scrollTop, 968)
    scroller.scrollTop = 1000
    await e.pressAll("zt")
    assert.equal(scroller.scrollTop, 1060)
    scroller.scrollTop = 1000
    await e.pressAll("zb")
    assert.equal(scroller.scrollTop, 876)
    assert.equal(e.sim.focus, 0)
    assert.equal(e.sim.copyCalls, 0)

    console.log("Bounded probes, mask cleanup, rendered-only mode, and viewport commands passed")
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1) })
