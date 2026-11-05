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
    logicalLineInfo(off) {
        const start = off === 0 ? 0 : this.text.lastIndexOf("\n", off - 1) + 1
        let end = this.text.indexOf("\n", off)
        if (end === -1) end = this.text.length
        return { start, end }
    }
    lineInfo(off) { return this.logicalLineInfo(off) }
    pointAt(off) {
        const line = this.lineInfo(off)
        return { x: (off - line.start) * 8 + 50, y: this.text.slice(0, off).split("\n").length * 20 + 40 }
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
        if (!k) return // Modifiers/formatting keys do not collapse a Docs range.
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
                else { const n = this.lineInfo(li.end + (this.text[li.end] === "\n" ? 1 : 0)); f = n.start + Math.min(this.goal, n.end - n.start) }
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
    const mkEl = () => {
        const attrs = new Map()
        return { style: {}, isConnected: true, appendChild() {}, addEventListener() {}, remove() { this.isConnected = false },
            setAttribute(k, v) { attrs.set(k, v) }, getAttribute(k) { return attrs.get(k) },
            removeAttribute(k) { attrs.delete(k) }, hasAttribute(k) { return attrs.has(k) },
            getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 } } }
    }
    const menuEls = ["Copy", "Cut", "Paste", "Redo", "Undo", "Find"].map((c) => ({
        innerText: c,
        dispatchEvent(ev) { if (ev.type === "click") sim.menu(c) },
    }))
    const menuBtn = { innerText: "Edit", dispatchEvent() {} }
    let keydownHandler = null
    const iframeDoc = { addEventListener(type, fn) { if (type === "keydown") keydownHandler = fn } }
    const owner = { querySelector: () => null }
    const caret = {
        style: {}, isConnected: true, closest: () => owner,
        getBoundingClientRect() {
            const point = sim.pointAt(sim.focus)
            const left = point.x, top = point.y
            return { left, top, width: 1, height: 16, bottom: top + 16, right: left + 1 }
        },
    }
    const documentListeners = {}
    const documentHandlers = {}
    const document = {
        addEventListener(type, fn) {
            (documentHandlers[type] || (documentHandlers[type] = [])).push(fn)
            documentListeners[type] = (event) => Promise.all(documentHandlers[type].map((handler) => handler(event)))
        },
        getElementsByTagName: () => [{ contentDocument: iframeDoc }],
        getElementsByClassName: (c) => c === "kix-cursor-caret" ? [caret] : [],
        querySelector: (s) => s === ".docs-texteventtarget-iframe" ? { contentDocument: iframeDoc, addEventListener() {} } : null,
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
    // Older suites exercise the precise clipboard path; pass settings: {} to
    // exercise shipped defaults (including cached Vim word motions).
    const store = { "docskeys-settings": opts.settings === undefined ? { wordMotion: "precise" } : opts.settings }
    const storageListeners = []
    const chrome = {
        runtime: { getURL: (p) => p, lastError: null },
        storage: {
            local: { get(k, cb) { cb({ [k]: store[k] }) }, set(o, cb) { Object.assign(store, o); if (cb) cb() } },
            onChanged: { addListener(fn) { storageListeners.push(fn) } },
        },
    }
    if (opts.withoutStorage) delete chrome.storage
    class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail } }
    const ctx = vm.createContext({
        document, window, navigator, chrome, CustomEvent, console: { log() {}, warn: opts.warn || (() => {}), error() {} },
        setTimeout, clearTimeout, performance, Promise, Date, Math, Number, String, Array, Object, RegExp, Error, Intl, AbortController,
    })
    vm.runInContext(fs.readFileSync(path.join(__dirname, "settings.js"), "utf8"), ctx)
    vm.runInContext(fs.readFileSync(path.join(__dirname, "vim.js"), "utf8"), ctx)
    vm.runInContext(fs.readFileSync(path.join(__dirname, "read_ui.js"), "utf8"), ctx)
    vm.runInContext(fs.readFileSync(path.join(__dirname, "rendered_reader.js"), "utf8"), ctx)
    vm.runInContext(fs.readFileSync(path.join(__dirname, "text_model.js"), "utf8"), ctx)
    vm.runInContext(fs.readFileSync(path.join(__dirname, "search.js"), "utf8"), ctx)
    vm.runInContext(fs.readFileSync(path.join(__dirname, "g_prefix.js"), "utf8"), ctx)
    vm.runInContext(fs.readFileSync(path.join(__dirname, "viewport.js"), "utf8"), ctx)
    vm.runInContext(fs.readFileSync(path.join(__dirname, "linewise.js"), "utf8"), ctx)
    vm.runInContext(fs.readFileSync(opts.file || path.join(__dirname, "content.js"), "utf8"), ctx)
    const get = (expr) => vm.runInContext(expr, ctx)
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
    function selectedText() {
        const state = get("linewiseState")
        if (get("mode") !== "visualLine" || !state) return sim.selText()
        let anchor = 0
        while (anchor <= sim.text.length) {
            if (Math.abs(sim.pointAt(anchor).y - state.point.y) < 1) break
            const row = sim.lineInfo(anchor), next = row.end + (sim.text[row.end] === "\n" ? 1 : 0)
            if (next <= anchor) break
            anchor = next
        }
        const logical = get("settings.visualVertical") === "logical"
        const a = logical ? sim.logicalLineInfo(anchor) : sim.lineInfo(anchor)
        const c = logical ? sim.logicalLineInfo(sim.focus) : sim.lineInfo(sim.focus)
        const end = Math.max(a.end, c.end)
        return sim.text.slice(Math.min(a.start, c.start), sim.text[end] === "\n" ? end + 1 : end)
    }
    return { sim, ctx, get, press, pressRaw, pressAll, settle, sleep, documentListeners, selectedText,
        changeSettings(value) {
            store["docskeys-settings"] = value
            for (const fn of storageListeners) fn({ "docskeys-settings": { newValue: value } }, "local")
        },
    }
}

module.exports = { makeEnv, sleep, DocSim }
