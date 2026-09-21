// Loads the REAL content.js in a vm sandbox against a simulated Google Docs
// editor (selection model with anchor/focus, sticky goal column, Home/End,
// Ctrl+arrows, Backspace/Delete, Edit-menu Copy/Paste, async clipboard).
const vm = require("vm")
const fs = require("fs")
const path = require("path")

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class DocSim {
    constructor(text) {
        this.text = text
        this.anchor = 0
        this.focus = 0
        this.goal = null
        this.clipboard = ""
        this.copyDelay = 6
        this.clipDelay = 2
        this.copyCalls = 0
        this.keyLog = []
    }
    lineInfo(off) {
        const start = this.text.lastIndexOf("\n", off - 1) + 1
        let end = this.text.indexOf("\n", off)
        if (end === -1) end = this.text.length
        return { start, end }
    }
    prevB(f) { // previous grapheme boundary (arrow keys step over whole graphemes)
        if (f <= 0) return 0
        if (!DocSim.seg) return f - 1
        let last = 0
        for (const s of DocSim.seg.segment(this.text)) { if (s.index >= f) break; last = s.index }
        return last
    }
    nextB(f) {
        const n = this.text.length
        if (f >= n) return n
        if (!DocSim.seg) return f + 1
        for (const s of DocSim.seg.segment(this.text)) { if (s.index > f) return s.index }
        return n
    }
    hasSel() { return this.anchor !== this.focus }
    selRange() { return [Math.min(this.anchor, this.focus), Math.max(this.anchor, this.focus)] }
    selText() { const [s, e] = this.selRange(); return this.text.slice(s, e) }
    setCaret(off) { this.anchor = this.focus = off }
    key(detail) {
        const { keyCode, mods } = detail
        const shift = !!mods.shift
        const ctrl = !!(mods.control || mods.alt)
        const names = { 37: "left", 38: "up", 39: "right", 40: "down", 35: "end", 36: "home", 8: "backspace", 46: "delete", 13: "enter", 32: "space" }
        const k = names[keyCode]
        this.keyLog.push(k + (shift ? "+S" : ""))
        const vertical = (k === "up" || k === "down")
        if (!vertical) this.goal = null
        if (k === "backspace" || k === "delete") {
            if (this.hasSel()) {
                const [s, e] = this.selRange()
                this.text = this.text.slice(0, s) + this.text.slice(e)
                this.setCaret(s)
            } else if (k === "backspace" && this.focus > 0) {
                const p = this.prevB(this.focus)
                this.text = this.text.slice(0, p) + this.text.slice(this.focus)
                this.setCaret(p)
            } else if (k === "delete" && this.focus < this.text.length) {
                this.text = this.text.slice(0, this.focus) + this.text.slice(this.nextB(this.focus))
            }
            return
        }
        if (k === "space") { this.insert(" "); return }
        if (k === "enter") { this.insert("\n"); return }
        let f = this.focus
        if (!shift && this.hasSel() && (k === "left" || k === "right")) {
            const [s, e] = this.selRange()
            this.setCaret(k === "left" ? s : e)
            return
        }
        if (k === "left") f = ctrl ? this.wordLeft(f) : this.prevB(f)
        else if (k === "right") f = ctrl ? this.wordRight(f) : this.nextB(f)
        else if (k === "home") f = ctrl ? 0 : this.lineInfo(f).start
        else if (k === "end") f = ctrl ? this.text.length : this.lineInfo(f).end
        else if (vertical) {
            const li = this.lineInfo(f)
            if (this.goal === null) this.goal = f - li.start
            if (k === "up") {
                if (li.start === 0) f = 0
                else { const p = this.lineInfo(li.start - 1); f = p.start + Math.min(this.goal, p.end - p.start) }
            } else {
                if (li.end >= this.text.length) f = this.text.length
                else { const n = this.lineInfo(li.end + 1); f = n.start + Math.min(this.goal, n.end - n.start) }
            }
        }
        this.focus = f
        if (!shift) this.anchor = f
    }
    insert(s) {
        const [a, b] = this.selRange()
        this.text = this.text.slice(0, a) + s + this.text.slice(b)
        this.setCaret(a + s.length)
    }
    wordRight(f) {
        let i = f
        const t = this.text
        while (i < t.length && !/\s/.test(t[i])) i++
        while (i < t.length && /\s/.test(t[i])) i++
        return i
    }
    wordLeft(f) {
        let i = f
        const t = this.text
        while (i > 0 && /\s/.test(t[i - 1])) i--
        while (i > 0 && !/\s/.test(t[i - 1])) i--
        return i
    }
    menu(caption) {
        if (caption === "Copy") {
            this.copyCalls++
            if (!this.hasSel()) return // disabled in real Docs with no selection
            const text = this.selText()
            setTimeout(() => { this.clipboard = text }, this.copyDelay)
        } else if (caption === "Paste") {
            const clip = this.clipboard
            this.insert(clip)
        }
    }
}

DocSim.seg = (typeof Intl !== 'undefined' && Intl.Segmenter) ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null

function makeEnv(text, opts = {}) {
    const sim = new DocSim(text)
    if (opts.copyDelay !== undefined) sim.copyDelay = opts.copyDelay
    const listeners = {}
    const mkEl = () => ({ style: {}, appendChild() {}, addEventListener() {}, getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 } } })
    const menuEls = ["Copy", "Cut", "Paste", "Redo", "Undo", "Find"].map((c) => ({
        innerText: c,
        dispatchEvent(ev) { if (ev.type === "click") sim.menu(c) },
    }))
    const menuBtn = { innerText: "Edit", dispatchEvent() {} }
    let keydownHandler = null
    const iframeDoc = { addEventListener(type, fn) { if (type === "keydown") keydownHandler = fn } }
    const document = {
        getElementsByTagName: () => [{ contentDocument: iframeDoc }],
        getElementsByClassName: () => [],
        querySelector: () => null,
        querySelectorAll: (sel) => (sel === ".menu-button" ? [menuBtn] : sel === ".goog-menuitem" ? menuEls : []),
        createElement: mkEl,
        createEvent: () => ({ initMouseEvent(name) { this.type = name } }),
        documentElement: mkEl(),
        body: mkEl(),
    }
    const window = {
        addEventListener(t, fn) { listeners[t] = fn },
        dispatchEvent(ev) { if (ev.type === "doc-keys-simulate-keypress") sim.key(ev.detail) },
    }
    const navigator = {
        platform: "Win32",
        clipboard: {
            async readText() { await sleep(sim.clipDelay); return sim.clipboard },
            async writeText(t) { await sleep(sim.clipDelay); sim.clipboard = t },
        },
    }
    const store = {}
    const chrome = {
        runtime: { getURL: (p) => p, lastError: null },
        storage: { local: { get(k, cb) { cb({}) }, set(o, cb) { if (cb) cb() } } },
    }
    class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail } }
    const ctx = vm.createContext({
        document, window, navigator, chrome, CustomEvent, console: { log() {}, warn: opts.warn || (() => {}), error() {} },
        setTimeout, clearTimeout, performance, Promise, Date, Math, Number, String, Array, Object, RegExp, Error, Intl,
    })
    vm.runInContext(fs.readFileSync(opts.file || path.join(__dirname, "..", "content.js"), "utf8"), ctx)
    const get = (expr) => vm.runInContext(expr, ctx)
    // The cosmetic idle refresh (box width / selection check) is 40ms in the
    // extension; the fixed sleeps in the older tests were written against the
    // old 150ms, so default to that here. Pass { refreshMs: 40 } to test the
    // real timing.
    vm.runInContext(`ACCURATE_WIDTH_REFRESH_DEBOUNCE_MS = ${opts.refreshMs !== undefined ? opts.refreshMs : 150}`, ctx)
    async function settle() {
        for (let i = 0; i < 400; i++) {
            let q = 0; try { q = get("keyQueue.length") } catch (e) {}
            if (!get("oracleBusy") && q === 0) return
            await sleep(5)
        }
        throw new Error("settle timeout")
    }
    // Commands are typed as their QWERTY-command letter; the extension's
    // Dvorak translation means the raw e.key must be the inverse image.
    const inv = {}
    for (let c = 32; c < 127; c++) {
        const raw = String.fromCharCode(c)
        const cmd = get(`translateKey(${JSON.stringify(raw)})`)
        if (inv[cmd] === undefined) inv[cmd] = raw
    }
    async function press(k, wait = true, extra = {}) {
        const raw = (k === "Escape") ? k : (inv[k] !== undefined ? inv[k] : k)
        return pressRaw(raw, wait, extra)
    }
    async function pressRaw(k, wait = true, extra = {}) {
        keydownHandler(Object.assign({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, preventDefault() {}, stopImmediatePropagation() {} }, extra))
        if (wait) { await sleep(1); await settle() }
    }
    async function pressAll(str) { for (const ch of str) await press(ch) }
    return { sim, ctx, get, press, pressRaw, pressAll, settle, sleep }
}

module.exports = { makeEnv, sleep, DocSim }
