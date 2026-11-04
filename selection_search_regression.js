const assert = require("node:assert/strict")
const { makeEnv } = require("./harness")
const Vim = require("./vim")

function wrappedEnv(text, unit = "display") {
    const e = makeEnv(text, { settings: { dvorak: false, visualVertical: unit } })
    const rows = () => {
        const result = []
        let start = 0
        for (const paragraph of e.sim.text.split("\n")) {
            if (!paragraph.length) result.push({ start, end: start })
            for (let at = 0; at < paragraph.length; at += 4) result.push({ start: start + at, end: start + Math.min(at + 4, paragraph.length) })
            start += paragraph.length + 1
        }
        return result
    }
    e.sim.lineInfo = (at) => rows().findLast((row) => row.start <= at) || rows()[0]
    e.sim.pointAt = (at) => {
        const all = rows(), line = e.sim.lineInfo(at)
        const row = all.findIndex((item) => item.start === line.start)
        return { x: 50 + (at - line.start) * 8, y: 60 + row * 20 }
    }
    const select = e.ctx.document.querySelectorAll
    e.ctx.document.querySelectorAll = (selector) => {
        if (!selector.includes('[role="paragraph"]')) return select(selector)
        let at = 0
        return e.sim.text.split("\n").map((text) => {
            const top = e.sim.pointAt(at).y, height = Math.max(1, Math.ceil(text.length / 4)) * 20 - 4
            at += text.length + 1
            return { getBoundingClientRect: () => ({ top, bottom: top + height, height, left: 40, right: 200, width: 160 }) }
        })
    }
    return e
}

async function query(e, prefix, pattern) {
    await e.pressAll(prefix)
    for (const char of pattern) await e.pressRaw(char)
    await e.pressRaw("Enter")
}

async function main() {
    const text = "abcdEFGHijkl\nMNOPqrst"
    let e = wrappedEnv(text)
    e.sim.setCaret(1)
    await e.pressRaw("V")
    assert.equal(e.sim.focus, 1)
    assert.equal(e.sim.copyCalls, 0, "entering V read the document")
    assert.equal(e.sim.keyLog.length, 0, "entering V moved a temporary caret")
    assert.equal(e.selectedText(), "abcd")
    e.get("renderOverlay()")
    assert.equal(e.get("linewiseHighlight.style.height"), "16px")
    e.changeSettings({ dvorak: false, visualVertical: "logical" })
    e.get("renderOverlay()")
    assert.equal(e.get("linewiseHighlight.style.height"), "56px", "paragraph setting did not expand the whole wrapped paragraph")
    e.changeSettings({ dvorak: false, visualVertical: "display" })
    await e.pressRaw("j")
    assert.equal(e.sim.focus, 5)
    assert.equal(e.selectedText(), "abcdEFGH")
    await e.pressRaw("y"); await e.sleep(15)
    assert.equal(e.sim.clipboard, "abcdEFGH", "display yank consumed the entire paragraph or an extra wrapped character")

    for (const op of ["d", "c"]) {
        e = wrappedEnv(text)
        e.sim.setCaret(5)
        await e.pressAll("V" + op)
        assert.equal(e.sim.text, "abcdijkl\nMNOPqrst", op + " changed text outside the displayed row")
        assert.equal(e.get("mode"), op === "c" ? "insert" : "normal")
    }
    e = wrappedEnv(text)
    e.sim.setCaret(1)
    await e.pressAll("Vjo")
    assert.equal(e.sim.focus, 1)
    assert.equal(e.selectedText(), "abcdEFGH")
    assert.equal(e.sim.copyCalls, 0, "endpoint swapping read the document")

    e = wrappedEnv(text)
    e.ctx.requestAnimationFrame = (fn) => setTimeout(fn, 16)
    await e.pressAll("Vj")
    await e.pressRaw("d", false)
    for (let n = 0; n < 60 && !e.sim.hasSel(); n++) await e.sleep(5)
    assert.equal(e.sim.hasSel(), true)
    await e.pressRaw("Escape")
    assert.equal(e.sim.hasSel(), false, "cancelling a displayed-row range left a native selection")
    assert.equal(e.sim.text, text)
    assert.equal(e.get("mode"), "normal")

    e = wrappedEnv(text, "logical")
    e.sim.setCaret(1)
    await e.pressRaw("V")
    assert.equal(e.selectedText(), "abcdEFGHijkl\n")
    await e.pressRaw("j")
    assert.equal(e.sim.focus, 14, "paragraph j stopped at the next wrapped row")
    await e.pressRaw("k")
    assert.equal(e.sim.focus, 1)
    await e.pressRaw("d")
    assert.equal(e.sim.text, "MNOPqrst", "paragraph delete removed only a displayed row")

    e = wrappedEnv(text)
    e.sim.setCaret(5)
    await e.pressRaw("V")
    e.changeSettings({ dvorak: false, visualVertical: "logical" })
    await e.pressRaw("y"); await e.sleep(15)
    assert.equal(e.sim.clipboard, "abcdEFGHijkl\n", "an active V selection ignored a unit-setting change")

    // V must remain read-free and preserve a deliberately detached viewport.
    e = makeEnv("one two\nthree four", { settings: { dvorak: false } })
    const view = { scrollTop: 900, scrollLeft: 0, isConnected: true }
    const select = e.ctx.document.querySelector
    e.ctx.document.querySelector = (s) => s === ".kix-appview-editor" ? view : select(s)
    e.ctx.navigator.clipboard.readText = () => { throw Error("V requested clipboard access") }
    await e.pressRaw("V")
    assert.equal(view.scrollTop, 900)
    assert.equal(e.sim.keyLog.length, 0)
    await e.pressRaw("Escape")
    assert.equal(view.scrollTop, 900)

    // A forward search copies only the suffix. Repeats reuse both source data
    // and the literal-match index instead of re-reading/recompiling it.
    e = makeEnv(Array(100).fill("hit alpha beta").join("\n"), { settings: { dvorak: false } })
    e.ctx.compileCalls = 0
    e.get("const compileSearchBase = DocsKeysVim.searchMatches; DocsKeysVim.searchMatches = (...args) => { compileCalls++; return compileSearchBase(...args) }")
    await query(e, "/", "hit")
    assert.equal(e.sim.copyCalls, 1)
    for (let n = 0; n < 15; n++) await e.pressRaw("n")
    await e.pressRaw("N")
    assert.equal(e.sim.copyCalls, 1, "search repeats re-read the document")
    assert.equal(e.ctx.compileCalls, 1, "search repeats rebuilt the match index")
    assert.match(e.get("searchOverlay.textContent"), /from search start/)

    e = makeEnv("word ".repeat(400) + "needle", { settings: { dvorak: false } })
    await query(e, "/", "needle")
    assert.equal(e.sim.focus, 2000)
    assert.equal(e.sim.copyCalls, 1)
    assert.ok(e.sim.keyLog.length < 40, "a match near EOF sent thousands of character events")

    e = makeEnv("hit start\nmiddle\nend hit", { settings: { dvorak: false, searchWrap: false } })
    e.sim.setCaret(e.sim.text.indexOf("middle"))
    await query(e, "/", "hit")
    assert.equal(e.sim.focus, e.sim.text.lastIndexOf("hit"))
    assert.equal(e.sim.copyCalls, 1)
    await query(e, "?", "start")
    assert.equal(e.sim.focus, 4, "backward search did not extend the known prefix with wrapping disabled")
    assert.equal(e.sim.copyCalls, 2)
    await query(e, "?", "absent")
    assert.equal(e.sim.focus, 4)
    assert.equal(e.sim.copyCalls, 2)

    e = makeEnv("alpha ALPHA Alpha alphabet", { settings: { dvorak: false, searchIgnoreCase: true, searchSmartCase: true } })
    await query(e, "/", "alpha")
    assert.equal(e.sim.focus, 6)
    await query(e, "/", "Alpha")
    assert.equal(e.sim.focus, 12)
    await query(e, "/", "alpha\\C")
    assert.equal(e.sim.focus, 18)
    await query(e, "/", "ALPHA\\c")
    assert.equal(e.sim.focus, 0)
    e.sim.setCaret(6)
    await e.pressRaw("*")
    assert.equal(e.sim.focus, 12, "smartcase incorrectly affected keyword * search")

    const matches = Vim.searchMatches([..."a a a"], "a")
    assert.equal(Vim.searchFromMatches(matches, 0, true, 1000000000, true).target, 2)
    assert.equal(Vim.searchFromMatches(matches, 4, true, 1, false), null)
    assert.deepEqual(Vim.searchMatches([..."a😀 A😀 a😀"], "a😀", false, { ignoreCase: true }).map((m) => m.target), [0, 3, 6])
    console.log("Displayed/paragraph linewise ranges, read-free V, search source/index reuse, options, and large counts passed")
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1) })
