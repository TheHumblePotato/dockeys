const assert = require("node:assert/strict")
const { makeEnv } = require("./harness")

async function main() {
    // Shipped defaults use a synchronous w/b path, including counts and repeats.
    let e = makeEnv("one two three four", { settings: {} })
    e.sim.clipboard = "clipboard"
    await e.pressAll("2w")
    assert.equal(e.sim.focus, 8)
    await e.press("b")
    assert.equal(e.sim.focus, 4)
    await e.press("w", true, { repeat: true })
    assert.equal(e.sim.focus, 8)
    assert.equal(e.sim.copyCalls, 0)

    assert.equal(e.sim.clipboard, "clipboard")
    assert.equal(e.get("oracleBusy"), false)

    // Settings changes take effect in an existing document. Text input stays raw.
    e.changeSettings({ dvorak: false, boxCursor: false, modeIndicator: false })
    await e.pressRaw("h")
    assert.equal(e.sim.focus, 7)
    assert.equal(e.get("modeIndicator.style.display"), "none")
    assert.equal(e.get("overlayShapeWanted"), null)
    e.changeSettings({ dvorak: false, wordMotion: "precise" })
    e.sim.setCaret(0)
    await e.pressRaw("w")
    assert.ok(e.sim.copyCalls > 0)
    assert.equal(e.sim.focus, 4)
    e = makeEnv("a b\nc d")
    await e.pressAll("3w")
    assert.equal(e.sim.focus, 6) // counted precise fallback must keep the count
    e = makeEnv("text", { settings: { startInInsert: true, dvorak: false } })
    assert.equal(e.get("mode"), "insert")
    await e.pressRaw("[", true, { ctrlKey: true })
    assert.equal(e.get("mode"), "normal")
    await e.pressRaw("ArrowRight")
    assert.equal(e.sim.focus, 1)
    await e.pressRaw("x", true, { isComposing: true })
    assert.equal(e.sim.text, "text")
    await e.pressRaw("x", true, { isTrusted: false })
    assert.equal(e.sim.text, "text")

    e = makeEnv("one two", { settings: { dvorak: false } })
    await e.pressRaw("i")
    await e.pressRaw("o", true, { ctrlKey: true })
    await e.pressRaw("d")
    assert.equal(e.get("mode"), "waitForFirstInput")
    await e.pressRaw("w")
    assert.equal(e.sim.text, "two")
    assert.equal(e.get("mode"), "insert")

    // A failed clipboard read must restore the caret and decline the motion.
    e = makeEnv("one two", { settings: { dvorak: false, wordMotion: "precise" } })
    e.ctx.navigator.clipboard.readText = async () => { throw new Error("permission denied") }
    await e.pressRaw("w")
    assert.equal(e.sim.focus, 0)
    assert.equal(e.sim.hasSel(), false)
    assert.equal(e.sim.copyCalls, 0)

    // Idle rendering and scrolling must never select text or touch clipboard.
    e = makeEnv("one two", { settings: {} })
    e.get("overlayFrame()")
    await e.sleep(180)
    assert.equal(e.sim.copyCalls, 0)
    assert.equal(e.sim.keyLog.length, 0)

    // Never hide a collaborator, including when they appear first in the DOM.
    function caret(name) {
        const owner = { querySelector: () => ({ textContent: name }) }
        return { style: { opacity: "0.7" }, isConnected: true, closest: () => owner,
            getBoundingClientRect: () => ({ left: 20, top: 30, bottom: 46, right: 21, height: 16 }) }
    }
    const remote = caret("Collaborator")
    const local = caret("")
    e.ctx.document.getElementsByClassName = () => [remote, local]
    e.get("cursorTop = null")
    assert.equal(e.get("getCursorTop()"), local)
    e.get("hiddenNativeCursor = getCursorTop(); nativeCursorOpacity = hiddenNativeCursor.style.opacity; hiddenNativeCursor.style.opacity = '0'")
    e.changeSettings({ boxCursor: false })
    assert.equal(local.style.opacity, "0.7")
    assert.equal(remote.style.opacity, "0.7")
    local.isConnected = false
    e.ctx.document.getElementsByClassName = () => [remote]
    assert.equal(e.get("getCursorTop()"), null)

    // Cross-line native word motions start on the character, not after it.
    e = makeEnv("x\na b c")
    await e.pressAll("vw")
    assert.equal(e.sim.selText(), "x\na")
    await e.press("w")
    assert.equal(e.sim.selText(), "x\na b")
    await e.press("b")
    assert.equal(e.sim.selText(), "x\na")
    e = makeEnv("a b\nx")
    e.sim.setCaret(4)
    await e.pressAll("vb")
    assert.equal(e.sim.selText(), "b\nx")
    e = makeEnv("one two\nthree four\nfive six")
    e.sim.setCaret(8)
    await e.pressAll("vbww")
    assert.equal(e.sim.selText(), "three f")
    await e.pressAll("bb")
    assert.equal(e.sim.selText(), "two\nt")
    await e.press("Escape")
    assert.equal(e.sim.focus, 4)
    e = makeEnv("abcdefgh\nabcdefgh\nabcdefgh")
    e.sim.setCaret(12)
    await e.pressAll("vjjk")
    assert.equal(e.sim.selText(), "d")

    // Check linewise movement against an independent line-index reference.
    for (const lines of [["a", "longer line", "z"], ["", "abc", "", "x", ""], ["😀xyz", "q", "longer"]]) {
        const text = lines.join("\n")
        const starts = lines.map((_, i) => lines.slice(0, i).join("\n").length + (i ? 1 : 0))
        for (let anchor = 0; anchor < lines.length; anchor++) {
            e = makeEnv(text)
            e.sim.setCaret(starts[anchor])
            await e.press("V")
            let cursor = anchor
            for (const motion of "jjjkkkkjjkjkkjjj") {
                cursor = Math.max(0, Math.min(lines.length - 1, cursor + (motion === "j" ? 1 : -1)))
                await e.press(motion)
                const lo = Math.min(anchor, cursor), hi = Math.max(anchor, cursor)
                const end = hi + 1 < lines.length ? starts[hi + 1] : text.length
                assert.equal(e.sim.selText(), text.slice(starts[lo], end), `${JSON.stringify(lines)} anchor=${anchor} cursor=${cursor} motion=${motion}`)
            }
        }
    }

    for (const jump of ["G", "g"]) {
        e = makeEnv("a\nlonger line\nz\n")
        e.sim.setCaret(2)
        await e.pressAll("V" + jump)
        if (jump === "G") {
            await e.pressAll("kk")
            assert.equal(e.sim.selText(), "longer line\n")
            await e.press("k")
            assert.equal(e.sim.selText(), "a\nlonger line\n")
        } else {
            await e.press("j")
            assert.equal(e.sim.selText(), "longer line\n")
            await e.press("j")
            assert.equal(e.sim.selText(), "longer line\nz\n")
        }
    }

    // Page motions must preserve linewise selections; mode toggles are Vim-like.
    e = makeEnv("aa\nbbb\nc\ndddd\ne")
    await e.press("V")
    await e.press("d", true, { ctrlKey: true })
    assert.equal(e.sim.selText(), e.sim.text)
    assert.equal(e.get("mode"), "visualLine")
    await e.press("V")
    assert.equal(e.get("mode"), "normal")
    assert.equal(e.sim.hasSel(), false)
    e = makeEnv("abc def")
    await e.pressAll("vv")
    assert.equal(e.get("mode"), "normal")
    assert.equal(e.sim.focus, 0)
    e.sim.setCaret(4)
    await e.press("Y")
    await e.sleep(30)
    assert.equal(e.sim.clipboard, "def") // Neovim defaults Y to y$.

    console.log("Settings, scrolling, collaborators, native words, and linewise regressions passed")
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1) })
