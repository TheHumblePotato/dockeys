// Set to true and reload the extension to log how long each phase of a
// text-oracle read (f/F/t/T/w/e/b) actually takes, in the DevTools console.
// Useful for finding out where remaining latency is actually going, instead
// of guessing -- e.g. whether it's the clipboard round-trip itself, or
// something else like Docs' own Copy-click handler being slow on a large
// document.
const DEBUG_TIMING = false
let settings = { ...DocsKeysSettings.defaults }

function applySettings(value) {
    settings = DocsKeysSettings.normalize(value)
    updateModeIndicator(mode)
}

// --- Grapheme-aware text handling -------------------------------------------
// Arrow keys (and therefore every selection/motion DocsKeys builds out of
// them) step over one user-perceived character -- a grapheme cluster -- at a
// time, but JS strings index UTF-16 code units. Any line containing an emoji
// (surrogate pair), an accent written as base+combining mark, a ZWJ sequence
// or a flag therefore made every step count too large. All text the oracle
// reads is now split into grapheme arrays with Intl.Segmenter and every
// index/step count in this file is a grapheme index. The finder/classifier
// helpers accept either a string or an array, since they only use
// .length / [i] / .slice / .indexOf.
const graphemeSegmenter = (typeof Intl !== "undefined" && Intl.Segmenter)
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null
function toGraphemes(str) {
    if (str === null || str === undefined) return []
    if (Array.isArray(str)) return str
    if (!graphemeSegmenter) return Array.from(str)
    return Array.from(graphemeSegmenter.segment(str), (s) => s.segment)
}

function waitForElement(getElement, callback, { interval = 200, timeoutMs = 20000 } = {}) {
    const start = Date.now()
    const attempt = () => {
        const el = getElement()
        if (el) {
            callback(el)
            return
        }
        if (Date.now() - start > timeoutMs) {
            console.warn("DocsKeys: gave up waiting for a required Google Docs element to appear; DocsKeys may not activate on this page.")
            return
        }
        setTimeout(attempt, interval)
    }
    attempt()
}

waitForElement(
    () => {
        const el = document.querySelector('.docs-texteventtarget-iframe')
        return (el && el.contentDocument) ? el : null
    },
    (iframe) => {
        const attach = () => iframe.contentDocument.addEventListener('keydown', eventHandler, true)
        attach()
        iframe.addEventListener('load', attach)
    },
)

let cursorTop = null
function isLocalCursor(caret) {
    const owner = caret.closest && caret.closest(".kix-cursor")
    if (!owner) return false
    const name = owner.querySelector(".kix-cursor-name")
    return !name || !name.textContent.trim()
}

function getCursorTop() {
    if (cursorTop && cursorTop.isConnected && isLocalCursor(cursorTop)) return cursorTop
    cursorTop = null
    for (const className of ["kix-cursor-caret", "kix-cursor-top"]) {
        const candidates = Array.from(document.getElementsByClassName(className))
        cursorTop = candidates.find(isLocalCursor) || null
        if (cursorTop) break
    }
    // Never guess the first caret: it may belong to a collaborator.
    return cursorTop
}

// Independent box/underline overlay following only the local native caret.
// Every frame reads geometry and updates styles; it never reads document
// text, touches the clipboard, or changes the selection.
let cursorBoxOverlay = null
function getCursorBoxOverlay() {
    if (!cursorBoxOverlay || !cursorBoxOverlay.isConnected) {
        cursorBoxOverlay = document.createElement("div")
        cursorBoxOverlay.style.position = "fixed"
        cursorBoxOverlay.style.pointerEvents = "none"
        cursorBoxOverlay.style.zIndex = "9998"
        cursorBoxOverlay.style.display = "none"
        document.body.appendChild(cursorBoxOverlay)
    }
    return cursorBoxOverlay
}

const CURSOR_BOX_COLOR = "rgba(0, 0, 0, 0.25)"
const CURSOR_UNDERLINE_HEIGHT_PX = 3

// Font info comes from the docs-texteventtarget-iframe's contenteditable
// element (live font-family/size/weight in its style). Cached briefly so the
// per-frame render doesn't call getComputedStyle 60 times a second.
let cachedFontInfo = null
let cachedFontInfoAt = 0
// Font info always comes from the hidden docs-texteventtarget-iframe's
// contenteditable element, which is a small, fixed-size keystroke-capture
// target -- its CSS font-size does NOT track Google Docs' own zoom control
// (the percentage dropdown in the toolbar, which scales rendered text
// independently of that hidden element's style). Without correcting for
// this, the box cursor's WIDTH stayed sized for 100% zoom no matter the
// actual zoom level, even though its height (read directly from the real
// on-screen caret's own bounding rect) already tracked zoom correctly. Cache
// is short (400ms) since zoom can change anytime.
function getCursorFontInfo() {
    const now = Date.now()
    if (cachedFontInfo && now - cachedFontInfoAt < 400) return cachedFontInfo
    try {
        const iframe = document.querySelector(".docs-texteventtarget-iframe")
        const doc = iframe && iframe.contentDocument
        const el = doc && (doc.activeElement || doc.querySelector('[contenteditable="true"]'))
        if (!el) return null
        const cs = el.ownerDocument.defaultView.getComputedStyle(el)
        if (!cs.fontSize || !cs.fontFamily) return null
        cachedFontInfo = { fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight || "400" }
        cachedFontInfoAt = now
        return cachedFontInfo
    } catch (err) {
        return null
    }
}

// Ratio between how tall the real on-screen caret actually is and how tall a
// line of this font "should" be at 100% zoom (fontSize * a typical line-height
// ratio). Docs' zoom scales the real caret's rendered height but not the
// hidden iframe element's CSS font-size, so this ratio tracks the zoom level
// without needing to read Docs' zoom UI directly (its control's exact
// selector/value format is unconfirmed against a live page, so measuring the
// visible effect is more robust than parsing the setting). Clamped to a sane
// range so a bad reading (e.g. a blink "off" zero-height rect) can't blow the
// box up or shrink it to nothing.
const ZOOM_REFERENCE_LINE_HEIGHT_RATIO = 1.15
function zoomFactorFor(fontInfo, nativeCursorRectHeight) {
    const fontSizePx = parseFloat(fontInfo.fontSize)
    if (!fontSizePx || !nativeCursorRectHeight) return 1
    const factor = nativeCursorRectHeight / (fontSizePx * ZOOM_REFERENCE_LINE_HEIGHT_RATIO)
    if (!isFinite(factor) || factor <= 0) return 1
    return Math.min(4, Math.max(0.25, factor))
}

let measureCanvas = null
let charWidthCache = {}
let charWidthCacheSize = 0
function measureCharWidth(fontInfo, char = "0") {
    try {
        const target = (char && char !== "\n" && char !== "\r") ? char : "0"
        const font = `${fontInfo.fontWeight} ${fontInfo.fontSize} ${fontInfo.fontFamily}`
        const cacheKey = font + "|" + target
        if (charWidthCache[cacheKey] !== undefined) return charWidthCache[cacheKey]
        if (!measureCanvas) measureCanvas = document.createElement("canvas")
        const ctx = measureCanvas.getContext("2d")
        ctx.font = font
        const width = ctx.measureText(target).width
        const out = width > 0 ? width : null
        if (charWidthCacheSize > 2000) { charWidthCache = {}; charWidthCacheSize = 0 }
        charWidthCache[cacheKey] = out
        charWidthCacheSize++
        return out
    } catch (err) {
        return null
    }
}

let overlayShapeWanted = null   // "block" | "underline" | null (= hidden)
let lastOverlayKey = ""
let hiddenNativeCursor = null
let nativeCursorOpacity = ""

function restoreNativeCursor() {
    if (hiddenNativeCursor) hiddenNativeCursor.style.opacity = nativeCursorOpacity
    hiddenNativeCursor = null
}

// Positions the overlay over the native caret. Returns a rounded position
// key for the native caret, or null if there is nothing to position against.
// While the native caret is in the "off" phase of its blink (display:none ->
// zero-height rect) the last geometry is simply kept instead of hiding.
function renderOverlay() {
    const shape = overlayShapeWanted
    if (!shape || !settings.boxCursor) return null
    const nativeCursor = getCursorTop()
    const fontInfo = getCursorFontInfo()
    if (!nativeCursor || !fontInfo) {
        if (cursorBoxOverlay) cursorBoxOverlay.style.display = "none"
        restoreNativeCursor()
        return null
    }
    if (hiddenNativeCursor !== nativeCursor) {
        restoreNativeCursor()
        hiddenNativeCursor = nativeCursor
        nativeCursorOpacity = nativeCursor.style.opacity || ""
    }
    let rect
    try { rect = nativeCursor.getBoundingClientRect() } catch (err) { return null }
    if (!rect || !rect.height) return null
    // The caret's rect is still meaningful (not clipped to zero) when it has
    // scrolled out of view -- Docs positions it absolutely within the page,
    // it just happens to land outside the current viewport. Draw nothing
    // rather than a box at a misleading position; it reappears on its own as
    // soon as the caret scrolls back on screen, no explicit "resume" needed.
    const vw = (typeof window !== "undefined" && window.innerWidth) || Infinity
    const vh = (typeof window !== "undefined" && window.innerHeight) || Infinity
    if (rect.bottom <= 0 || rect.top >= vh || rect.right <= 0 || rect.left >= vw) {
        if (cursorBoxOverlay && cursorBoxOverlay.style.display !== "none") cursorBoxOverlay.style.display = "none"
        return null
    }
    const zoom = zoomFactorFor(fontInfo, rect.height)
    const width = measureCharWidth(fontInfo) * zoom
    if (!width) return null
    const overlay = getCursorBoxOverlay()
    const key = `${shape}|${rect.left}|${rect.top}|${rect.height}|${rect.bottom}|${width}`
    if (key !== lastOverlayKey) {
        overlay.style.backgroundColor = CURSOR_BOX_COLOR
        overlay.style.left = `${rect.left}px`
        overlay.style.width = `${width}px`
        if (shape === "underline") {
            overlay.style.top = `${rect.bottom - CURSOR_UNDERLINE_HEIGHT_PX}px`
            overlay.style.height = `${CURSOR_UNDERLINE_HEIGHT_PX}px`
        } else {
            overlay.style.top = `${rect.top}px`
            overlay.style.height = `${rect.height}px`
        }
        lastOverlayKey = key
    }
    if (overlay.style.display !== "block") overlay.style.display = "block"
    if (nativeCursor.style.opacity !== "0") nativeCursor.style.opacity = "0"
    return `${Math.round(rect.left)},${Math.round(rect.top)}`
}

// Hides the overlay AND restores the native cursor's own opacity. Called
// whenever insert mode is entered.
function hideCursorBoxOverlay() {
    overlayShapeWanted = null
    lastOverlayKey = ""
    if (cursorBoxOverlay) cursorBoxOverlay.style.display = "none"
    restoreNativeCursor()
}

function updateCursorOverlay(shape) {
    if (!settings.boxCursor) {
        hideCursorBoxOverlay()
        return null
    }
    overlayShapeWanted = shape
    return renderOverlay()
}

function cursorPositionKey(nativeCursor) {
    try {
        if (!nativeCursor) return null
        const rect = nativeCursor.getBoundingClientRect()
        if (!rect.height) return null   // blink "off" phase / not laid out
        return `${Math.round(rect.left)},${Math.round(rect.top)}`
    } catch (err) {
        return null
    }
}

// --- Unexpected selections in normal mode ---------------------------------
// Explicit mouse/keyboard selections enter Visual mode; selections left by
// failed reads are collapsed. Only flagged selections trigger a Copy check.
let pendingSelectionCheck = null   // null | "user" | "glitch"
function markSelectionCheck(reason) {
    if (pendingSelectionCheck === "user") return
    pendingSelectionCheck = reason
    if (mode === "normal") scheduleSelectionCheck()
}
function noteSelectionGlitch() {
    // No scheduling here (a persistently failing read must not re-trigger
    // itself); the next idle pass will look.
    if (pendingSelectionCheck === null) pendingSelectionCheck = "glitch"
}
function handleUnexpectedSelection(reason) {
    if (reason === "user") {
        visualModel = null
        visualAnchorPoint = null
        nativeVisualFocusAfter = true
        nativeVisualAnchorAfter = false
        mode = "visual"
        updateModeIndicator(mode)
    } else {
        sendKeyEvent("left") // collapse to the start of the selection
    }
}

// Selection checks only run after an explicit mouse/keyboard selection.
// Cosmetic rendering must never move the caret or use the clipboard: doing
// that during a scroll makes Docs scroll straight back to the cursor.
let SELECTION_CHECK_DEBOUNCE_MS = 40
let selectionCheckTimer = null
function scheduleSelectionCheck() {
    if (mode !== "normal" || pendingSelectionCheck === null) return
    clearTimeout(selectionCheckTimer)
    selectionCheckTimer = setTimeout(runSelectionCheck, SELECTION_CHECK_DEBOUNCE_MS)
}

async function runSelectionCheck() {
    if (mode !== "normal" || pendingSelectionCheck === null || !beginOracle()) return
    const check = pendingSelectionCheck
    pendingSelectionCheck = null
    try {
        const selected = await withClipboardSaved((previous) => copySelectionForOracle(previous))
        if (selected === null) pendingSelectionCheck = check
        else if (selected !== "" && mode === "normal") handleUnexpectedSelection(check)
    } finally {
        releaseOracleQuiet()
    }
}

function overlayFrame() {
    try { renderOverlay() } catch (err) {}
}
function startOverlayFrameLoop() {
    if (typeof requestAnimationFrame !== "function") return
    const tick = () => {
        overlayFrame()
        requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
}

let mode = 'normal'
let hasHandledKey = false
let tempnormal = false 
let multipleMotion = {
    times:0,
    mode:"normal"
}

const script = document.createElement("script");
script.src = chrome.runtime.getURL("page_script.js");
document.documentElement.appendChild(script);

const isMac = /Mac/.test(navigator.platform || navigator.userAgent);

const keyCodes = {
    backspace: 8,
    enter: 13,
    space: 32,
    esc: 27,
    pageup: 33,
    pagedown: 34,
    end: 35,
    home: 36,
    left: 37,
    up: 38,
    right: 39,
    down: 40,
    "delete": 46,
};

const dvorakUnshifted = {
    "`": "$", "1": "&", "2": "[", "3": "{", "4": "}",
    "5": "(", "6": "=", "7": "*", "8": ")", "9": "+",
    "0": "]", "-": "!", "=": "#",
    q: ";", w: ",", e: ".", r: "p", t: "y", y: "f", u: "g",
    i: "c", o: "r", p: "l", "[": "/", "]": "@", "\\": "|",
    a: "a", s: "o", d: "e", f: "u", g: "i", h: "d", j: "h",
    k: "t", l: "n", ";": "s", "'": "-",
    z: "'", x: "q", c: "j", v: "k", b: "x", n: "b", m: "m",
    ",": "w", ".": "v", "/": "z",
};
const dvorakShifted = {
    "~": "~", "!": "1", "@": "2", "#": "3", "$": "4",
    "%": "5", "^": "6", "&": "7", "*": "8", "(": "9",
    ")": "0", "_": "%", "+": "`",
    Q: ":", W: "<", E: ">", R: "P", T: "Y", Y: "F", U: "G", I: "C", O: "R", P: "L", "{": "?", "}": "^", "|": "\\",
    A: "A", S: "O", D: "E", F: "U", G: "I", H: "D", J: "H", K: "T", L: "N", ":": "S", "\"": "_",
    Z: "\"", X: "Q", C: "J", V: "K", B: "X", N: "B", M: "M",
    "<": "W", ">": "V", "?": "Z",
};

const dvorakToQwerty = (() => {
    const out = {};
    for (const tbl of [dvorakUnshifted, dvorakShifted]) {
        for (const label of Object.keys(tbl)) {
            const sent = tbl[label];
            if (sent === label) continue;
            if (out[sent] !== undefined && out[sent] !== label) {
                console.warn(`DocsKeys dvorak map: '${sent}' claimed by both '${out[sent]}' and '${label}'`);
            }
            out[sent] = label;
        }
    }
    return out;
})();

function translateKey(key) {
    return settings.dvorak && dvorakToQwerty[key] !== undefined ? dvorakToQwerty[key] : key;
}

const wordModifierKey = isMac ? 'alt' : 'control'
const paragraphModifierKey = isMac ? 'alt' : 'control'

function wordMods(shift = false) {
    return { shift, [wordModifierKey]: true }
}

function paragraphMods(shift = false) {
    return { shift, [paragraphModifierKey]: true }
}

function sendKeyEvent(key, mods = {}) {
    const keyCode = keyCodes[key]
    const defaultMods = { shift: false, control: false, alt: false, meta: false }
    window.dispatchEvent(new CustomEvent("doc-keys-simulate-keypress", { detail: { keyCode, mods: { ...defaultMods, ...mods } } }));
}

const modeIndicator = document.createElement('div')
modeIndicator.style.position = 'fixed'
modeIndicator.style.bottom = '20px'
modeIndicator.style.right = '20px'
modeIndicator.style.padding = '8px 16px'
modeIndicator.style.borderRadius = '4px'
modeIndicator.style.fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
modeIndicator.style.fontSize = '14px'
modeIndicator.style.fontWeight = '500'
modeIndicator.style.zIndex = '9999'
document.body.appendChild(modeIndicator)

// Called after every normal/visual-mode keystroke, including ones like
// plain h/l/j/k that don't otherwise call updateModeIndicator() (which
// only runs on an actual mode transition). Instant and synchronous --
// nothing here is async or touches the clipboard, so it's safe to call
// after every single keystroke without any latency or concurrency concern.
function refreshCursorOverlayForCurrentMode() {
    if (mode === "normal") {
        updateCursorOverlay("block")
        scheduleSelectionCheck()
    } else if (mode === "visual" || mode === "visualLine") {
        updateCursorOverlay("block")
    } else if (mode === "insert") {
        hideCursorBoxOverlay()
    } else {
        // Pending-input modes (waitForFirstInput, waitForSecondInput,
        // waitForVisualInput, waitForRegister, waitForFindChar,
        // replaceChar, multipleMotion): underline, matching real Vim.
        updateCursorOverlay("underline")
    }
}

function updateModeIndicator(currentMode) {
    modeIndicator.style.display = settings.modeIndicator ? "block" : "none"
    if (!settings.boxCursor) hideCursorBoxOverlay()
    modeIndicator.textContent = currentMode.toUpperCase()
    switch(currentMode) {
        case 'normal':
            modeIndicator.style.backgroundColor = '#1a73e8'
            modeIndicator.style.color = 'white'
            updateCursorOverlay("block")
            scheduleSelectionCheck()
            break
        case 'insert':
            modeIndicator.style.backgroundColor = '#34a853'
            modeIndicator.style.color = 'white'
            hideCursorBoxOverlay()
            break
        case 'visual':
        case 'visualLine':
            modeIndicator.style.backgroundColor = '#fbbc04'
            modeIndicator.style.color = 'black'
            updateCursorOverlay("block")
            break
        case 'waitForFirstInput':
        case 'waitForSecondInput':
        case 'waitForVisualInput':
        case 'waitForRegister':
        case 'waitForFindChar':
        case 'replaceChar':
        case 'multipleMotion':
            modeIndicator.style.backgroundColor = '#ea4335'
            modeIndicator.style.color = 'white'
            updateCursorOverlay("underline")
            break
    }
}

function repeatMotion(motion, times, key) {
  for (let i = 0; i < times; i++) {
      motion(key)
  }
}

// --- Visual mode model -----------------------------------------------------
// Read the starting display line before selecting. Within that snapshot,
// motions use grapheme indices and synchronous Shift+arrows. Native motions
// take over when leaving it; line reads must never run on a live selection.
// a/c: inclusive Vim anchor and cursor character indices.
// dA/dF: Docs anchor/focus boundaries, where boundary i precedes character i.
// Forward: dA=a, dF=c+1. Backward: dA=a+1, dF=c.
// Crossing the anchor changes its boundary so the anchor character remains
// selected in both directions.
let visualModel = null
let nativeVisualFocusAfter = true

function visualDocsFor(a, c) {
    return c >= a ? { tA: a, tF: c + 1 } : { tA: a + 1, tF: c }
}

// Move Docs' focus from boundary `from` to boundary `to`, keeping the anchor.
function visualShiftFocus(from, to) {
    const d = to - from
    if (d === 0) return
    repeatMotion(() => sendKeyEvent(d > 0 ? "right" : "left", { shift: true }), Math.abs(d))
}

// Plain caret move; only ever used on an EMPTY selection (see below).
function visualMoveCaret(from, to) {
    const d = to - from
    if (d === 0) return
    repeatMotion(() => sendKeyEvent(d > 0 ? "right" : "left"), Math.abs(d))
}

// Bring Docs' selection to anchor boundary tA / focus boundary tF, using only
// relative key presses. If the anchor doesn't have to move, that's just
// shift+arrows. If it does (the cursor crossed the anchor, or o/iw changed
// the anchor), first collapse the selection by walking the focus back onto
// the anchor with shift+arrows -- the selection is then empty, so a plain
// arrow is an ordinary one-character caret move (no reliance on which edge
// Docs collapses a non-empty selection to) -- walk that caret to the new
// anchor boundary, then extend from there.
function visualRealizeDocs(tA, tF) {
    const m = visualModel
    if (tA === m.dA) {
        visualShiftFocus(m.dF, tF)
    } else {
        visualShiftFocus(m.dF, m.dA)
        visualMoveCaret(m.dA, tA)
        visualShiftFocus(tA, tF)
    }
    m.dA = tA
    m.dF = tF
}

function visualSetSelection(a, c) {
    const m = visualModel
    const last = m.text.length - 1
    a = Math.max(0, Math.min(last, a))
    c = Math.max(0, Math.min(last, c))
    const { tA, tF } = visualDocsFor(a, c)
    visualRealizeDocs(tA, tF)
    m.a = a
    m.c = c
}

function visualMoveCursor(c) {
    visualSetSelection(visualModel.a, c)
}

// Native selections use boundaries between characters; Vim's endpoints
// are characters. Start every native motion on the cursor character, then
// restore the inclusive boundary on the correct side of the anchor.
function cursorDocumentPoint() {
    const caret = getCursorTop()
    if (!caret) return null
    const rect = caret.getBoundingClientRect()
    if (!rect.height) return null
    const scroller = getDocsScrollContainer()
    return { x: rect.left + ((scroller && scroller.scrollLeft) || 0),
        y: rect.top + ((scroller && scroller.scrollTop) || 0) }
}

function comparePoints(a, b) {
    if (!a || !b) return null
    if (Math.abs(a.y - b.y) > 1) return a.y < b.y ? -1 : 1
    if (Math.abs(a.x - b.x) > 1) return a.x < b.x ? -1 : 1
    return 0
}

let nativeVisualAnchorAfter = false
let visualAnchorPoint = null

function prepareNativeVisualMotion(forward) {
    const m = visualModel
    if (m) {
        visualRealizeDocs(m.a, m.a)
        visualAnchorPoint = cursorDocumentPoint()
        visualRealizeDocs(forward ? m.a : m.a + 1, m.c)
        nativeVisualAnchorAfter = !forward
        visualModel = null
    } else if (nativeVisualFocusAfter) {
        sendKeyEvent("left", { shift: true })
    }
}

function finishNativeVisualMotion(direction) {
    const relation = comparePoints(cursorDocumentPoint(), visualAnchorPoint)
    const forward = relation === null ? direction : relation === 0 ? !nativeVisualAnchorAfter : relation > 0
    if (nativeVisualAnchorAfter === forward) {
        // The cursor crossed its anchor. Rebuild from the selected grapheme
        // count to move Docs' anchor by one character. This read happens only
        // on a crossing, never for ordinary word jumps or cosmetic rendering.
        repairNativeVisualAnchor(forward)
        return
    }
    if (forward) sendKeyEvent("right", { shift: true })
    nativeVisualFocusAfter = forward
}

async function repairNativeVisualAnchor(forward) {
    if (!beginOracle()) return
    try {
        const selected = await withClipboardSaved((previous) => copySelectionForOracle(previous))
        if (selected === null) return
        const n = toGraphemes(selected).length
        if (n > 0) sendKeyEvent("left")
        if (forward) {
            sendKeyEvent("left")
            repeatMotion(() => sendKeyEvent("right", { shift: true }), n + 2)
        } else {
            repeatMotion(() => sendKeyEvent("right"), n + 1)
            repeatMotion(() => sendKeyEvent("left", { shift: true }), n + 1)
        }
        nativeVisualAnchorAfter = !forward
        nativeVisualFocusAfter = forward
    } finally {
        releaseOracle()
    }
}

function visualNativeMotion(forward, nativeFn) {
    prepareNativeVisualMotion(forward)
    nativeFn()
    finishNativeVisualMotion(forward)
}

function visualNativeWordMotion(kind) {
    const forward = kind !== "b"
    visualNativeMotion(forward, () => {
        if (kind === "e") fallbackWordEnd(true)
        else fallbackWordMotion(forward, true)
    })
}

function nativeVerticalStep(down, shift = false) {
    const before = cursorDocumentPoint()
    sendKeyEvent(down ? "down" : "up", { shift })
    let after = cursorDocumentPoint()
    // Docs moves to EOL/column zero when Up/Down hits a document boundary.
    // Vim keeps the cursor in its column on that line instead.
    if (!before || !after || Math.abs(before.y - after.y) > 1) return
    for (let i = 0; i < 2000 && Math.abs(before.x - after.x) > 1; i++) {
        const key = before.x < after.x ? "left" : "right"
        sendKeyEvent(key, { shift })
        const next = cursorDocumentPoint()
        if (!next || comparePoints(next, after) === 0) break
        after = next
    }
}

// Vim's `^`: the first non-blank character; on a line of only blanks, the
// LAST character (an empty line stays at 0).
function firstNonBlankIndex(text) {
    const chars = toGraphemes(text)
    const i = chars.findIndex((ch) => !/\s/.test(ch))
    return i === -1 ? Math.max(0, chars.length - 1) : i
}

// Word/WORD motion inside the visual model: pure computation on the snapshot.
function visualWordMotion(kind, classify) {
    const m = visualModel
    const forward = (kind === "w" || kind === "e")
    const finder = kind === "e" ? findWordEnd
        : kind === "w" ? findWordStart
        : findWordStartBackward // "b"
    const text = forward ? m.text.slice(m.c) : m.text.slice(0, m.c)
    const steps = countedWordSteps(text, classify, 1, finder, !forward)
    if (steps === -1) {
        // Ran off the line (e.g. `w` on the last word): let Docs' native
        // word jump take it across the line break, same as normal mode does.
        visualNativeWordMotion(kind)
        return
    }
    visualMoveCursor(forward ? m.c + steps : m.c - steps)
}

// `aw`/`iw`/`aW`/`iW` object range containing index `idx`. Vim's rules
// (:help v_aw / v_iw): inner = the run of same-class characters (a run of
// word chars, of punctuation, or of blanks each count as one "word");
// around = that plus trailing white space, or leading white space if there is
// no trailing white space; on white space, "a word" is the white space plus
// the word after it.
function visualRunAt(text, idx, classify) {
    const cls = classify(text[idx])
    let s = idx
    let e = idx
    while (s > 0 && classify(text[s - 1]) === cls) s--
    while (e + 1 < text.length && classify(text[e + 1]) === cls) e++
    return [s, e]
}

function textObjectRange(text, idx, classify, around) {
    const [s, e] = visualRunAt(text, idx, classify)
    if (!around) return [s, e]
    if (classify(text[idx]) === "blank") {
        if (e + 1 < text.length) return [s, visualRunAt(text, e + 1, classify)[1]]
        return [s, e]
    }
    if (e + 1 < text.length && classify(text[e + 1]) === "blank") {
        return [s, visualRunAt(text, e + 1, classify)[1]]
    }
    if (s > 0 && classify(text[s - 1]) === "blank") {
        return [visualRunAt(text, s - 1, classify)[0], e]
    }
    return [s, e]
}

// iw/aw/iW/aW in charwise visual mode. With a one-character selection it
// selects the object under the cursor; with a larger selection it EXTENDS
// the selection by the next object in the direction of the cursor ("Repeating
// this object in Visual mode another string is included", :help v_aquote /
// motion.txt object-select).
function visualSelectTextObject(around, classify) {
    const m = visualModel
    if (m.a === m.c) {
        const [s, e] = textObjectRange(m.text, m.c, classify, around)
        visualSetSelection(s, e)
    } else if (m.c > m.a) {
        if (m.c + 1 < m.text.length) {
            const e = textObjectRange(m.text, m.c + 1, classify, around)[1]
            visualSetSelection(m.a, e)
        }
    } else if (m.c - 1 >= 0) {
        const s = textObjectRange(m.text, m.c - 1, classify, around)[0]
        visualSetSelection(m.a, s)
    }
}

// Which visual mode to fall back to when a pending sub-command started from
// visual mode (i/a text-object prefix) is cancelled or invalid.
let visualObjectPrefix = "i"        // 'i' | 'a'
let visualObjectReturnMode = "visual"

function switchModeToVisual() {
    mode = 'visual'
    visualModel = null
    nativeVisualFocusAfter = true
    nativeVisualAnchorAfter = false
    visualAnchorPoint = cursorDocumentPoint()
    updateModeIndicator(mode)
    startVisualSelection()
}

// Reads the line once -- BEFORE any selection exists, so the read is exact --
// then creates the one-character selection and initialises the model. Runs
// under the oracle guard, so keys typed while it's in flight are queued and
// replayed in order afterwards. If the read fails (or the line is empty, or
// its text isn't a single plain line) it degrades to the old native
// behavior: a one-character shift+Right selection and no model.
async function startVisualSelection() {
    if (!beginOracle()) {
        sendKeyEvent("right", { shift: true })
        return
    }
    try {
        const ctx = await readLineContext()
        if (mode !== "visual") return
        const beforeG = ctx ? toGraphemes(ctx.before) : []
        const afterG = ctx ? toGraphemes(ctx.after) : []
        const text = beforeG.concat(afterG)
        if (!ctx || text.length === 0 || /[\r\n\u000b\u2028\u2029]/.test(ctx.before + ctx.after)) {
            sendKeyEvent("right", { shift: true })
            visualModel = null
            return
        }
        let a = beforeG.length
        if (a >= text.length) {
            // Caret sits after the last character (after `$`/`A`+Esc). Vim's
            // cursor would be ON the last character, so `v` must select that
            // one, not the line break.
            sendKeyEvent("left")
            a = text.length - 1
        }
        sendKeyEvent("right", { shift: true })
        visualModel = { text, a, c: a, dA: a, dF: a + 1 }
    } finally {
        releaseOracle()
        refreshCursorOverlayForCurrentMode()
    }
}

// --- Visual line mode -------------------------------------------------------
// Forward: anchor at the anchor-line start, focus after the cursor line.
// Backward: anchor after the anchor line, focus at the cursor-line start.
// Boundary steps keep entire display lines selected without sticky columns.
// Rows are unknown after absolute/paragraph jumps; saved anchor coordinates
// detect when shrinking reaches the anchor again. A final empty line needs
// separate state because including it adds no selection characters.
let visualLineOrient = "fwd"   // "fwd" | "bwd"
let visualLineRows = 1
let visualLineEmptyEndIncluded = false
let visualLineAnchorEmpty = false
let visualLineAnchorStart = null
let visualLineAnchorEnd = null

function switchModeToVisualLine() {
    mode = 'visualLine'
    visualModel = null
    visualLineOrient = "fwd"
    visualLineRows = 1
    visualLineEmptyEndIncluded = false
    visualLineAnchorEmpty = false
    updateModeIndicator(mode)
    sendKeyEvent('home')
    visualLineAnchorStart = cursorDocumentPoint()
    vlStepBoundary(true)
    visualLineAnchorEnd = cursorDocumentPoint()
    visualLineAnchorEmpty = visualLineEmptyEndIncluded
}

// End+Right selects through a line break, but also works on the final line.
// Left+Home moves to the previous boundary without a sticky goal column.
// Up/Down alone clip to short lines and can leave a partial line selected.
function vlStepBoundary(forward, shift = true) {
    if (!forward && shift && visualLineOrient === "fwd" && visualLineEmptyEndIncluded) {
        visualLineEmptyEndIncluded = false
        return true // the final empty line occupies no selection characters
    }
    const before = cursorPositionKey(getCursorTop())
    if (forward) {
        sendKeyEvent("end", { shift })
        sendKeyEvent("right", { shift })
    } else {
        sendKeyEvent("left", { shift })
        sendKeyEvent("home", { shift })
    }
    const after = cursorPositionKey(getCursorTop())
    if (before === null || after === null || before !== after) return true
    if (forward && shift && !visualLineEmptyEndIncluded) {
        sendKeyEvent("home", { shift: true })
        const atStart = cursorPositionKey(getCursorTop())
        sendKeyEvent("end", { shift: true })
        if (atStart === after) {
            visualLineEmptyEndIncluded = true
            return true
        }
    }
    return false
}

// Forward selection -> backward one anchored after the anchor line. Ends with
// an empty selection whose caret is at that anchor boundary. (Left collapses
// to the selection's start = start of the anchor line; Down = start of the
// next line, or the document end for the last line.)
function vlPrepBwd() {
    if (!(visualLineAnchorEmpty && visualLineRows === 1)) sendKeyEvent("left")
    sendKeyEvent("end")
    sendKeyEvent("right")
    visualLineEmptyEndIncluded = false
}

// Backward selection -> forward one anchored at the start of the anchor line.
// Right collapses to the selection's end (the boundary after the anchor line);
// Left steps back into the anchor line; Home goes to its start. Ends with an
// empty selection whose caret is at the start of the anchor line.
function vlPrepFwd() {
    sendKeyEvent("right")
    if (!visualLineAnchorEmpty) {
        sendKeyEvent("left")
        sendKeyEvent("home")
    }
    visualLineEmptyEndIncluded = false
}

function vlMoveVertical(delta) {
    const down = delta > 0
    const steps = Math.abs(delta)
    const extending = (visualLineOrient === "fwd") === down
    if (extending) {
        for (let i = 0; i < steps; i++) {
            if (!vlStepBoundary(down)) break
            if (visualLineRows !== null) visualLineRows++
        }
        return
    }
    if (visualLineRows === null) {
        const anchor = visualLineOrient === "fwd" ? visualLineAnchorEnd : visualLineAnchorStart
        if (!anchor || !cursorDocumentPoint()) return
        for (let i = 0; i < steps; i++) {
            if (comparePoints(cursorDocumentPoint(), anchor) === 0) {
                visualLineRows = 1
                vlMoveVertical(down ? steps - i : i - steps)
                return
            }
            if (!vlStepBoundary(down)) return
        }
        return
    }
    const rows = visualLineRows === null ? Infinity : visualLineRows
    if (steps < rows) {
        // Shrinking towards the anchor line; the anchor line stays selected.
        repeatMotion(() => vlStepBoundary(down), steps)
        if (visualLineRows !== null) visualLineRows -= steps
        return
    }
    // Moving past the anchor line: flip sides. The anchor line plus
    // (steps - rows + 1) lines on the far side end up selected.
    const newRows = steps - rows + 2
    if (visualLineOrient === "fwd") {
        vlPrepBwd()
        visualLineOrient = "bwd"
    } else {
        vlPrepFwd()
        visualLineOrient = "fwd"
    }
    let movedRows = visualLineOrient === "bwd" && visualLineAnchorEmpty ? 1 : 0
    for (let i = movedRows; i < newRows; i++) {
        if (!vlStepBoundary(down)) break
        movedRows++
    }
    visualLineRows = Math.max(1, movedRows)
}

function vlGoto(toEnd) {
    if (toEnd) {
        if (visualLineOrient === "bwd") { vlPrepFwd(); visualLineOrient = "fwd" }
        goToDocEnd(true)
        // G includes an empty final line even though it adds no characters.
        sendKeyEvent("home", { shift: true })
        const endStart = cursorDocumentPoint()
        sendKeyEvent("end", { shift: true })
        visualLineEmptyEndIncluded = comparePoints(endStart, cursorDocumentPoint()) === 0
    } else {
        if (visualLineOrient === "fwd") { vlPrepBwd(); visualLineOrient = "bwd" }
        goToDocStart(true)
    }
    visualLineRows = null
}

// Paragraph jumps only in the orientation they can't cross the anchor in.
function vlParagraph(forward) {
    if (forward && visualLineOrient === "fwd") {
        goToEndOfPara(true)
        sendKeyEvent("end", { shift: true })
        sendKeyEvent("right", { shift: true })
        visualLineRows = null
    } else if (!forward && visualLineOrient === "bwd") {
        goToStartOfPara(true)
        sendKeyEvent("home", { shift: true })
        visualLineRows = null
    }
}

function handleKeyEventVisualLineMode(key) {
    switch (key) {
        case "v":
            mode = "visual"
            nativeVisualFocusAfter = visualLineOrient === "fwd"
            nativeVisualAnchorAfter = !nativeVisualFocusAfter
            visualAnchorPoint = visualLineAnchorStart
            updateModeIndicator(mode)
            break
        case "V":
            sendKeyEvent("left")
            mode = "normal"
            switchModeToNormal()
            break
        case "j": vlMoveVertical(1); break
        case "k": vlMoveVertical(-1); break
        case "G": vlGoto(true); break
        case "g": vlGoto(false); break
        case "}": vlParagraph(true); break
        case "{": vlParagraph(false); break
        case "\"":
            switchModeToWaitForRegister()
            break
        case "p": {
            const reg = pendingRegister
            pendingRegister = null
            mode = "normal" // see the charwise `p` below
            pasteRegister(reg)
            switchModeToNormal()
            break
        }
        case "c":
        case "d":
        case "y":
            visualOperator(key)
            break
        case "x":
            visualOperator("d")
            break
        case "s":
            visualOperator("c")
            break
        case "i":
        case "a":
            visualObjectPrefix = key
            visualObjectReturnMode = mode
            mode = "waitForVisualInput"
            break
        default:
            // h l w b e W B E f F t T ; , 0 ^ $ o O ...: intentionally
            // nothing -- V selects whole lines only.
            break
    }
}

// d/c/y/x/s in a visual mode whose selection isn't exactly modelled (V, or
// charwise after the selection left its line) first checks with a Copy that
// the selection is not EMPTY. An empty selection followed by Backspace deletes
// one unrelated character, which is what used to happen after Vk on the first
// line and `vh`. Exact charwise visual mode never produces an empty selection,
// so it stays synchronous.
function visualOperator(op) {
    const guarded = mode === "visualLine" || (mode === "visual" && !visualModel)
    if (!guarded || !beginOracle()) {
        runLongStringOp(op)
        return
    }
    ;(async () => {
        try {
            const selected = await withClipboardSaved((previousClipboard) => copySelectionForOracle(previousClipboard))
            await clipboardRestorePending // the restore must land before the real edit touches the clipboard
            if (selected === null) {
                pendingRegister = null
                pendingRegisterAppend = false
                console.warn("DocsKeys: couldn't verify the visual selection; nothing was changed")
                return
            }
            if (selected === "") {
                console.warn("DocsKeys: the visual selection is empty; nothing was changed")
                pendingRegister = null
                pendingRegisterAppend = false
                mode = "normal" // not visualLine: switchModeToNormal() would move the caret
                switchModeToNormal()
            } else {
                await runLongStringOp(op)
            }
        } catch (err) {
            console.warn("DocsKeys: visual operator failed", err)
        } finally {
            releaseOracle()
        }
    })()
}

function switchModeToNormal() {
    if (mode == "visualLine") sendKeyEvent("left")
    mode = 'normal'
    visualModel = null
    updateModeIndicator(mode)
    finishTemporaryNormal()
}

function finishTemporaryNormal() {
    if (tempnormal && mode === "normal" && !oracleBusy) switchModeToInsert()
}

function switchModeToInsert() {
    tempnormal = false
    mode = 'insert'
    visualModel = null
    updateModeIndicator(mode)
}

function switchModeToWait() {
    mode = "waitForFirstInput"
    updateModeIndicator(mode)
}

function switchModeToWait2() {
    mode = "waitForSecondInput"
    updateModeIndicator(mode)
}

function switchModeToReplaceChar() {
    mode = "replaceChar"
    updateModeIndicator(mode)
}

let waitForRegisterReturnMode = "normal"
function switchModeToWaitForRegister() {
    waitForRegisterReturnMode = mode
    mode = "waitForRegister"
    updateModeIndicator(mode)
}

// --- f/F/t/T (find-character motions) ---
// These are the first DocsKeys motions that need to know what character is
// actually in the document. See readLineContext() below for how that's
// done without a Docs content-reading API: temporarily select to the line's
// start/end, Copy, and read the OS clipboard (the same clipboard permission
// already used for registers), then restore the selection and the user's
// real clipboard contents. This is scoped to the current *wrapped display
// line* (Home/End), the same approximation of "line" already used by DocsKeys'
// existing $/0/D/C -- see MISSING_VIM_FEATURES.md.
let pendingFindType = null       // 'f' | 'F' | 't' | 'T'
let pendingFindOperator = null   // null for a plain/visual motion, else 'c'/'d'/'y'
let pendingFindCount = 1
let pendingFindReturnMode = "normal" // mode to resume in: 'normal' | 'visual' | 'visualLine'
let lastFind = null              // { type, char } for ';' and ','

// One input guard for document reads, selection repair, and clipboard commands.
// Distinct presses are queued while selections/clipboard values are temporary.
// Held repeats are dropped while busy to avoid continuing after key release.
// A generation prevents an older completion from releasing a newer guard.
let oracleBusy = false
let oracleGeneration = 0
const keyQueue = []
const MAX_QUEUED_KEYS = 64
let drainingKeyQueue = false

function beginOracle() {
    if (oracleBusy) return false
    oracleBusy = true
    oracleGeneration++
    return true
}


// Release after clipboard restoration and any nested clipboard commands.
function releaseOracleQuiet() {
    // Stay "busy" until the background clipboard restore has landed, so keys
    // replayed from the queue (a held Ctrl+V, `p`, `y`) and any command that
    // follows can never see or write the oracle's temporary clipboard text.
    const generation = oracleGeneration
    Promise.all([clipboardRestorePending, clipboardGuardQueue]).then(() => {
        if (generation !== oracleGeneration) return
        oracleBusy = false
        finishTemporaryNormal()
        drainKeyQueue()
    })
}

function releaseOracle() {
    releaseOracleQuiet()
    // Retry recovery only when a document read flagged a leftover selection.
    if (mode === "normal") scheduleSelectionCheck()
}

function queueKey(item) {
    if (keyQueue.length >= MAX_QUEUED_KEYS) {
        console.warn("DocsKeys: key queue full while waiting on a document read; dropping key")
        return
    }
    keyQueue.push(item)
}

function drainKeyQueue() {
    if (drainingKeyQueue) return
    drainingKeyQueue = true
    try {
        while (keyQueue.length > 0 && !oracleBusy) {
            const item = keyQueue.shift()
            try {
                if (item.redo) {
                    clickMenu(menuItems.redo)
                } else if (item.menu) {
                    clickMenu(menuItems[item.menu])
                } else {
                    handleKey({
                        key: item.key,
                        replayed: true,
                        preventDefault() {},
                        stopImmediatePropagation() {},
                    })
                }
            } catch (err) {
                console.warn("DocsKeys: error replaying a queued key", err)
            }
        }
    } finally {
        drainingKeyQueue = false
    }
}

let longStringOp = ""
let operatorCount = 0 

let lastChange = null

function recordChange(fn) {
    lastChange = fn
}

function runDotRepeatable(fn, op) {
    fn()
    if (op !== "y") recordChange(fn)
}

let registers = {}
let pendingRegister = null
let pendingRegisterAppend = false // true if the register was given as an UPPERCASE letter ("A -> append to "a)
const CUT_REGISTER = "-"      // where a plain d/c (no explicit "reg) lands, matching Vim's small-delete register name
const BLACKHOLE_REGISTER = "_" // writes here are discarded, matching Vim's "_
const PASTE_SETTLE_DELAY_MS = 40 // was 60/80 (formerly REGISTER_READ_DELAY_MS): only remaining fixed-delay wait, used to let Docs' paste actually consume the clipboard before pasteRegister() restores it. Polling doesn't apply here (we wrote the clipboard ourselves, so there's no "change" to detect -- we're waiting for Docs to *read* it, not write it). Unverified against a live Docs page; raise it if pastes intermittently pick up the wrong text.
const REGISTER_STORAGE_KEY = "docskeys-registers"

chrome.storage.local.get(REGISTER_STORAGE_KEY, (result) => {
    if (chrome.runtime.lastError) {
        console.warn("DocsKeys: couldn't load saved registers", chrome.runtime.lastError)
        return
    }
    if (result && result[REGISTER_STORAGE_KEY]) {
        registers = result[REGISTER_STORAGE_KEY]
    }
})

function saveRegisters() {
    try {
        chrome.storage.local.set({ [REGISTER_STORAGE_KEY]: registers }, () => {
            if (chrome.runtime.lastError) {
                console.warn("DocsKeys: couldn't save registers", chrome.runtime.lastError)
            }
        })
    } catch (err) {
        console.warn("DocsKeys: couldn't save registers", err)
    }
}

// Named registers persist locally; uppercase appends. "_ discards content.
// "+ is the system clipboard. "* aliases it because the extension has no
// separate X11 primary selection.
const SYSTEM_REGISTER = "+"
function isSystemRegister(reg) { return reg === "+" || reg === "*" }

function waitForRegisterInput(key) {
    if (/^[a-z0-9]$/.test(key)) {
        pendingRegister = key
        pendingRegisterAppend = false
    } else if (/^[A-Z]$/.test(key)) {
        pendingRegister = key.toLowerCase()
        pendingRegisterAppend = true
    } else if (key === "-" || key === "_" || key === "+" || key === "*") {
        pendingRegister = key
        pendingRegisterAppend = false
    }
    mode = waitForRegisterReturnMode
    updateModeIndicator(mode)
}

function writeRegister(name, text, append) {
    if (!name || name === BLACKHOLE_REGISTER) return
    registers[name] = (append && registers[name] !== undefined) ? registers[name] + text : text
    saveRegisters()
}

// Copy is the bridge from Docs selections to registers. Plain y writes the
// system clipboard; plain d/c captures into the cut register and restores
// the clipboard. Named registers also preserve it; "_ skips capture.
let clipboardGuardQueue = Promise.resolve() // serializes the background register-capture/restore tail so rapid repeats (mashing "add) can't race and clobber each other's saved clipboard snapshot

// Clipboard commands share the input guard with document reads. Keep the
// guard through capture AND restoration, so another command cannot observe
// a temporary clipboard value or act on a selection awaiting capture.
function runClipboardCommand(fn) {
    const ownsGuard = !oracleBusy && beginOracle()
    const pending = clipboardGuardQueue.then(fn, fn)
    clipboardGuardQueue = pending.catch((err) => console.warn("DocsKeys: clipboard command failed", err))
    if (ownsGuard) clipboardGuardQueue.then(releaseOracleQuiet)
    return pending
}

async function deleteOrChangeSelection(reg, append, isChange, linewise) {
    await clipboardRestorePending
    const target = isSystemRegister(reg) || reg === BLACKHOLE_REGISTER ? null : (reg || CUT_REGISTER)
    if (target) {
        const text = await withClipboardSaved((previous) => copySelectionForOracle(previous))
        await clipboardRestorePending
        if (text !== null) writeRegister(target, text, append)
    } else if (isSystemRegister(reg)) {
        clickMenu(menuItems.copy)
    }
    sendKeyEvent("backspace")
    if (linewise) sendKeyEvent("backspace")
    if (isChange) switchModeToInsert()
    else {
        mode = "normal"
        switchModeToNormal()
    }
}

// After ANY yank Vim leaves the cursor at the start of the yanked text (:help
// y / quote_ ... "the cursor is moved to the start of the yanked text": for
// `yb` that is where the motion went, for `yw`/`y$`/`yiw` it is where the
// yank started) and ends Visual mode. Docs keeps the selection highlighted
// after Copy, so without this a yank made through an operator (`yw`, `yy`,
// `y$`, `yiw`, ...) left the text highlighted with the caret at its far end,
// and DocsKeys' mode disagreed with the screen. A plain Left on a non-empty
// selection collapses it to its start. Visual LINE mode already gets this
// from switchModeToNormal(), which sends its own Left.
function collapseCharwiseVisualToStart() {
    if (mode !== "visualLine") sendKeyEvent("left")
}

async function yankSelection(reg, append) {
    await clipboardRestorePending
    if (!reg || isSystemRegister(reg)) {
        clickMenu(menuItems.copy)
    } else if (reg !== BLACKHOLE_REGISTER) {
        const text = await withClipboardSaved((previous) => copySelectionForOracle(previous))
        await clipboardRestorePending
        if (text !== null) writeRegister(reg, text, append)
    }
    collapseCharwiseVisualToStart()
    switchModeToNormal()
}

function pasteRegister(name) {
    return runClipboardCommand(() => pasteRegisterInner(name))
}

async function pasteRegisterInner(name) {
    if (!name || isSystemRegister(name)) {
        // Wait for any in-flight clipboard restore (from a document read) so
        // it can't land AFTER the paste and be pasted, or overwrite a copy.
        await clipboardRestorePending
        clickMenu(menuItems.paste)
        return
    }
    const text = registers[name]
    if (text === undefined) {
        console.warn(`DocsKeys: register "${name}" is empty, nothing pasted`)
        return
    }
    let previousClipboard = null
    try {
        previousClipboard = await readClipboardSettled()
    } catch (err) {
    }
    try {
        await navigator.clipboard.writeText(text)
        clickMenu(menuItems.paste)
        if (previousClipboard !== null) {
            await new Promise((resolve) => setTimeout(resolve, PASTE_SETTLE_DELAY_MS))
            await navigator.clipboard.writeText(previousClipboard)
        }
    } catch (err) {
        console.warn(`DocsKeys: couldn't paste from register "${name}", falling back to a normal paste`, err)
        clickMenu(menuItems.paste)
    }
}


// Save the clipboard around a text read. The next read and the input guard
// both wait for restoration. Keep restoration separate from command capture
// so nested operations can wait without depending on their own queue.
let clipboardRestorePending = Promise.resolve()
// Reads the clipboard only after any in-flight background restore has landed,
// so a save-then-restore can never capture (and later "restore") an oracle's
// temporary text or sentinel.
async function readClipboardSettled() {
    await clipboardRestorePending
    return navigator.clipboard.readText()
}
async function withClipboardSaved(fn) {
    await clipboardRestorePending
    let previousClipboard = null
    try {
        previousClipboard = await readClipboardSettled()
    } catch (err) {
        // Best-effort: if we can't read/save the existing clipboard we can't
        // restore it later, but we can still run the action itself.
    }
    try {
        return await fn(previousClipboard)
    } finally {
        if (previousClipboard !== null) {
            clipboardRestorePending = navigator.clipboard.writeText(previousClipboard).catch((err) => {
                console.warn("DocsKeys: couldn't restore clipboard", err)
            })
        }
    }
}

// Waits for the clipboard to actually contain something different from
// `previousText`, polling instead of a fixed delay. Google Docs' own
// Copy/Cut click handler writes to the clipboard asynchronously, and how
// long that takes isn't something DocsKeys can know in advance; a fixed
// delay has to be pessimistic (long enough for the worst case), while
// polling returns as soon as the write actually lands -- typically much
// sooner. Falls back to "whatever's there now" after maxWaitMs so a copy
// that happens to produce identical text to what was already on the
// clipboard doesn't hang.
async function pollClipboardForChange(previousText, maxWaitMs = 250, intervalMs = 5) {
    const start = Date.now()
    while (Date.now() - start < maxWaitMs) {
        try {
            const text = await navigator.clipboard.readText()
            if (text !== previousText) return text
        } catch (err) {
            // keep polling; a transient read failure isn't necessarily final
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
    try {
        return await navigator.clipboard.readText()
    } catch (err) {
        return null
    }
}

// Copy the selection, returning "" for no text and null on failure.
// A unique sentinel distinguishes an empty selection from stale clipboard
// contents and handles copies identical to the previous clipboard value.
// Call only inside withClipboardSaved; preserve the clipboard on failure.
const ORACLE_SENTINEL = `\u200b\u200bdocskeys-oracle-${Math.random().toString(36).slice(2)}\u200b\u200b`
// The wait for "Docs hasn't replaced the sentinel, so the selection was
// empty" adapts to how long real copies have been taking (3x the smoothed
// latency + 40ms, never below 90ms or above maxWaitMs). An empty read at the
// end of a line used to stall for the full 250ms every time, which was most
// of the lag when a word motion crossed a line.
let copyLatencyMs = null
async function copySelectionForOracle(previousClipboard, maxWaitMs = 250) {
    if (previousClipboard === null) {
        // Without a saved clipboard we cannot safely probe or distinguish
        // an empty selection from stale clipboard text.
        return null
    }
    try {
        await navigator.clipboard.writeText(ORACLE_SENTINEL)
    } catch (err) {
        return null
    }
    const t0 = Date.now()
    clickMenu(menuItems.copy)
    const wait = copyLatencyMs === null
        ? maxWaitMs
        : Math.min(maxWaitMs, Math.max(90, copyLatencyMs * 3 + 40))
    const text = await pollClipboardForChange(ORACLE_SENTINEL, wait)
    if (text === null) return null
    if (text === ORACLE_SENTINEL) return ""
    const dt = Date.now() - t0
    copyLatencyMs = copyLatencyMs === null ? dt : copyLatencyMs * 0.7 + dt * 0.3
    return text
}

// Temporarily select caret..EOL and read via Copy, then collapse to the
// original caret. These cores require an empty selection, a clipboard save,
// and the input guard. A live Visual selection has a different anchor and
// must use its snapshot or copy the selection itself, never these cores.
async function readAfterCore(previousClipboard) {
    const t0 = DEBUG_TIMING ? performance.now() : 0
    const origin = cursorDocumentPoint()
    try {
        sendKeyEvent("end", { shift: true })
        const moved = comparePoints(origin, cursorDocumentPoint())
        const t1 = DEBUG_TIMING ? performance.now() : 0
        const after = await copySelectionForOracle(previousClipboard)
        const t2 = DEBUG_TIMING ? performance.now() : 0
        if (after === null || (after === "" && moved !== null && moved !== 0)) {
            // The temporary selection is still there and we don't know how
            // far it reaches; flag it so the next idle pass collapses it.
            if (moved !== null && moved !== 0) sendKeyEvent("left")
            else if (moved === null) noteSelectionGlitch()
            return null
        }
        // Collapse the temporary selection back onto the caret. With no
        // selection to start from, the selection is exactly [caret, EOL], so
        // a plain Left (collapse to the selection's start) restores the
        // caret without having to count characters -- which is what used to
        // go wrong for emoji/combining marks. (Only when something was
        // selected: on an empty selection a plain Left would MOVE the caret.)
        if (after.length > 0) sendKeyEvent("left")
        if (DEBUG_TIMING) {
            console.log(`DocsKeys timing (after): select=${(t1 - t0).toFixed(1)}ms copy+poll=${(t2 - t1).toFixed(1)}ms TOTAL=${(performance.now() - t0).toFixed(1)}ms`)
        }
        return after
    } catch (err) {
        console.warn("DocsKeys: couldn't read text after cursor (best-effort feature; falling back to no-op)", err)
        noteSelectionGlitch()
        return null
    }
}

// Same as readAfterCore(), but for the text from the start of the line to
// the cursor. The temporary selection is [line start, caret], so a plain
// Right (collapse to the selection's end) restores the caret.
async function readBeforeCore(previousClipboard) {
    const t0 = DEBUG_TIMING ? performance.now() : 0
    const origin = cursorDocumentPoint()
    try {
        sendKeyEvent("home", { shift: true })
        const moved = comparePoints(origin, cursorDocumentPoint())
        const t1 = DEBUG_TIMING ? performance.now() : 0
        const before = await copySelectionForOracle(previousClipboard)
        const t2 = DEBUG_TIMING ? performance.now() : 0
        if (before === null || (before === "" && moved !== null && moved !== 0)) {
            if (moved !== null && moved !== 0) sendKeyEvent("right")
            else if (moved === null) noteSelectionGlitch()
            return null
        }
        if (before.length > 0) sendKeyEvent("right")
        if (DEBUG_TIMING) {
            console.log(`DocsKeys timing (before): select=${(t1 - t0).toFixed(1)}ms copy+poll=${(t2 - t1).toFixed(1)}ms TOTAL=${(performance.now() - t0).toFixed(1)}ms`)
        }
        return before
    } catch (err) {
        console.warn("DocsKeys: couldn't read text before cursor (best-effort feature; falling back to no-op)", err)
        noteSelectionGlitch()
        return null
    }
}

// Single-direction reads: every normal-mode caller (f/t, w/e, F/T, b) only
// needs one side of the caret, so this is one clipboard round-trip each.
async function readAfterCursor() {
    return withClipboardSaved((previousClipboard) => readAfterCore(previousClipboard))
}
async function readBeforeCursor() {
    return withClipboardSaved((previousClipboard) => readBeforeCore(previousClipboard))
}

// Both sides of the caret under ONE clipboard save/restore (used by `v` and
// `^`). Returns { before, after } or null.
async function readLineContext() {
    return withClipboardSaved(async (previousClipboard) => {
        const before = await readBeforeCore(previousClipboard)
        if (before === null) return null
        const after = await readAfterCore(previousClipboard)
        if (after === null) return null
        return { before, after }
    })
}

// `text` (a string or a grapheme array) is the text from the cursor to
// end-of-line, so text[0] is the character currently under the cursor. Real
// f/t search *starts* at the next character, matching Vim's ":help f": "the
// count'th occurrence of {char} to the right", not counting the character the
// cursor is already on.
//
// skipAdjacent implements Vim's default 'cpoptions' (no ';' flag, :help
// cpo-;): when `;` or `,` repeats a t/T with a count of 1, a match directly
// next to the cursor is skipped, so the cursor always moves to the NEXT
// occurrence instead of getting stuck in front of the same one. (Vim's
// searchc(): "if 'cpo' lacks ';' and count == 1, stop = FALSE" for repeats.)
function findForward(text, char, count, skipAdjacent = false) {
    let idx = skipAdjacent ? 1 : 0
    for (let n = 0; n < count; n++) {
        idx = text.indexOf(char, idx + 1)
        if (idx === -1) return { found: false }
    }
    return { found: true, matchIndex: idx } // matchIndex = steps to land ON char (plain f)
}

// `text` is the text from start-of-line to the cursor (not including the
// cursor's own character), so its last element is the character immediately
// to the left of the cursor -- distance 1 for F/T's search.
//
// NOTE the explicit bounds check: Array.prototype.lastIndexOf treats a
// negative fromIndex as "counted from the end", so lastIndexOf(c, -1) on an
// array would silently re-find the LAST element instead of failing.
function findBackward(text, char, count, skipAdjacent = false) {
    let idx = text.length - (skipAdjacent ? 1 : 0)
    for (let n = 0; n < count; n++) {
        if (idx - 1 < 0) return { found: false }
        idx = text.lastIndexOf(char, idx - 1)
        if (idx === -1) return { found: false }
    }
    return { found: true, distance: text.length - idx } // steps to land ON char (plain F)
}

function finishFind(returnMode) {
    if (returnMode === "visual" || returnMode === "visualLine") {
        mode = returnMode
        updateModeIndicator(mode)
    } else {
        switchModeToNormal()
    }
}

// Builds the actual keystrokes for a resolved f/F/t/T, given the plain-motion
// step count (how many arrow presses land the cursor on the target for f/F,
// or one short of it for t/T).
//
// Per :help f/F/t/T: f and t are *inclusive* (the landing character is part
// of an operator's range), F and T are *exclusive*. Concretely, for the
// forward (f/t) case the operator-pending selection needs one MORE shift-press
// than the plain motion, to also grab the character the cursor started on
// (which the plain motion never selects, only passes over). For the backward
// (F/T) case the operator-pending selection needs the SAME number of
// shift-presses as the plain motion -- selecting backward by N never touches
// the original cursor's own character in the first place, which is exactly
// what "exclusive" backward means here. Verified against real Vim's
// documented dfX/dtX/dFX/dTX behavior (e.g. cursor on 'a' in "abcXdef",
// "dfX" deletes "abcX", "dtX" deletes "abc").
function applyMotionSteps(forward, inclusive, steps, operator, returnMode) {
    const dirKey = forward ? "right" : "left"

    if (operator) {
        const selectSteps = inclusive ? steps + 1 : steps
        const fn = () => {
            repeatMotion(() => sendKeyEvent(dirKey, { shift: true }), selectSteps)
            runLongStringOp(operator, false)
        }
        runDotRepeatable(fn, operator)
        return
    }

    if (returnMode === "visual" || returnMode === "visualLine") {
        // Unreachable in practice: visual motions are handled by the visual
        // model (or decline) before getting here. Kept as a safe native
        // fallback.
        repeatMotion(() => sendKeyEvent(dirKey, { shift: true }), steps)
        mode = returnMode
        updateModeIndicator(mode)
        return
    }

    repeatMotion(() => sendKeyEvent(dirKey), steps)
    switchModeToNormal()
}

function applyFindResult(type, steps, operator, returnMode) {
    const forward = (type === "f" || type === "t")
    const inclusive = (type === "f" || type === "t")
    applyMotionSteps(forward, inclusive, steps, operator, returnMode)
}

// f/F/t/T inside the visual model: pure computation on the line snapshot,
// synchronous, no clipboard. Same step arithmetic as the normal-mode path
// (verified there against :help f/t/F/T); in visual mode the landing
// character is simply where the cursor ends up (the selection is inclusive).
function performVisualFind(type, char, count, skipAdjacent = false) {
    const m = visualModel
    const forward = (type === "f" || type === "t")
    const isTill = (type === "t" || type === "T")
    let target
    if (forward) {
        const result = findForward(m.text.slice(m.c), char, count, skipAdjacent)
        if (!result.found) {
            console.warn(`DocsKeys: no match for ${type}${char} on this line`)
            finishFind("visual")
            return
        }
        const steps = isTill ? result.matchIndex - 1 : result.matchIndex
        if (steps < 0) {
            finishFind("visual")
            return
        }
        target = m.c + steps
    } else {
        const result = findBackward(m.text.slice(0, m.c), char, count, skipAdjacent)
        if (!result.found) {
            console.warn(`DocsKeys: no match for ${type}${char} on this line`)
            finishFind("visual")
            return
        }
        const steps = isTill ? result.distance - 1 : result.distance
        if (steps < 0) {
            finishFind("visual")
            return
        }
        target = m.c - steps
    }
    lastFind = { type, char }
    visualMoveCursor(target)
    finishFind("visual")
}

async function performFind(type, char, count, operator, returnMode, skipAdjacent = false) {
    if (returnMode === "visual" && visualModel !== null) {
        performVisualFind(type, char, count, skipAdjacent)
        return
    }
    if (returnMode === "visual" || returnMode === "visualLine") {
        // The line model isn't available (visual LINE mode, or the selection
        // has left the line `v` was pressed on). Reading text now would
        // capture text relative to the ANCHOR, not the cursor, so decline
        // rather than act on a wrong read; f/F/t/T have no native Docs
        // equivalent to fall back to.
        console.warn(`DocsKeys: ${type}${char} isn't available in this visual selection (visual line mode, or the selection has moved off the line) -- leave and re-enter visual mode to reset`)
        finishFind(returnMode)
        return
    }
    const forward = (type === "f" || type === "t")
    const raw = forward ? await readAfterCursor() : await readBeforeCursor()
    if (raw === null) {
        finishFind(returnMode)
        return
    }
    const text = toGraphemes(raw)
    const isTill = (type === "t" || type === "T")
    const result = forward
        ? findForward(text, char, count, skipAdjacent)
        : findBackward(text, char, count, skipAdjacent)

    if (!result.found) {
        console.warn(`DocsKeys: no match for ${type}${char} on this line`)
        finishFind(returnMode)
        return
    }

    const landingSteps = forward ? result.matchIndex : result.distance
    const steps = isTill ? landingSteps - 1 : landingSteps
    if (steps < 0) {
        // e.g. "t" immediately adjacent with nothing between -- no movement
        finishFind(returnMode)
        return
    }

    lastFind = { type, char }
    applyFindResult(type, steps, operator, returnMode)
}

// Find/replace arguments are literal OS-layout characters. Apply the DVP
// translation to command keys only, never to the character being searched.
function handleFindCharInput(rawKey) {
    if (oracleBusy) return
    if (toGraphemes(rawKey).length !== 1) {
        pendingFindType = null
        pendingFindOperator = null
        finishFind(pendingFindReturnMode)
        return
    }
    const type = pendingFindType
    const operator = pendingFindOperator
    const count = pendingFindCount || 1
    const returnMode = pendingFindReturnMode
    pendingFindType = null
    pendingFindOperator = null
    pendingFindCount = 1

    if (!beginOracle()) return
    performFind(type, rawKey, count, operator, returnMode).finally(() => {
        releaseOracle()
    })
}

function repeatLastFind(reverse, operator = null, returnMode = "normal") {
    if (!lastFind) return
    if (oracleBusy) return
    let { type, char } = lastFind
    if (reverse) {
        type = { f: "F", F: "f", t: "T", T: "t" }[type]
    }
    if (!beginOracle()) return
    // `;` and `,` repeat the last f/F/t/T but must not CHANGE it: after `,`
    // (which runs the reversed search), a following `;` still goes in the
    // original direction, and `,` again reverses the original. performFind()
    // stores whatever it ran as the new "last find", so put it back.
    const saved = lastFind
    // See findForward(): `;`/`,` after a t/T skip a match right next to the
    // cursor (Vim's default 'cpoptions').
    const skipAdjacent = (type === "t" || type === "T")
    performFind(type, char, 1, operator, returnMode, skipAdjacent).finally(() => {
        lastFind = saved
        releaseOracle()
    })
}

function goToStartOfLine() {
    sendKeyEvent("home")
}

function goToEndOfLine() {
    sendKeyEvent("end")
}

// Real Vim's `^`/`_` land on the line's first non-blank character; `0` always
// lands on column 0. DocsKeys previously treated all three identically. This
// needs the *whole* current line (not just one side of the cursor), so
// unlike f/t/w/e/b it reads both directions -- a rarer-invoked motion, so
// the extra read is an acceptable trade for correctness here.
async function goToFirstNonBlank(operator, returnMode) {
    if (oracleBusy) return
    if (returnMode === "visual" || returnMode === "visualLine") {
        // Charwise visual mode with a line model handles ^/_ itself (see
        // handleKeyEventVisualLine); anything reaching here has no model.
        console.warn("DocsKeys: ^/_ isn't available in this visual selection (visual line mode, or the selection has moved off the line) -- leave and re-enter visual mode to reset")
        finishFind(returnMode)
        return
    }
    if (!beginOracle()) return
    try {
        const ctx = await readLineContext()
        if (ctx === null) {
            finishFind(returnMode)
            return
        }
        const before = toGraphemes(ctx.before)
        const after = toGraphemes(ctx.after)
        const full = before.concat(after)
        const firstNonBlank = firstNonBlankIndex(full)
        const delta = firstNonBlank - before.length
        if (delta === 0) {
            if (operator) {
                runLongStringOp(operator, false)
            } else if (returnMode === "visual" || returnMode === "visualLine") {
                mode = returnMode
                updateModeIndicator(mode)
            } else {
                switchModeToNormal()
            }
            return
        }
        applyMotionSteps(delta > 0, false, Math.abs(delta), operator, returnMode)
    } finally {
        releaseOracle()
    }
}

function selectToStartOfLine() {
    sendKeyEvent("home", { shift: true })
}

function selectToEndOfLine() {
    sendKeyEvent("end", { shift: true })
}

// --- Word and WORD motions -------------------------------------------------
// Precise motions classify a freshly read display line. Native mode bypasses
// reads for normal w/b only. Operators, e and WORD motions keep the precise
// path. Crossing a line falls back to Docs word boundaries.

// Vim's default 'iskeyword' counts every letter/digit (including accented and
// non-Latin letters) and "_" as word characters, and gives emoji a class of
// their own (utf_class() returns 3 for emoji, distinct from punctuation), so
// "foo😀bar" is three words. `ch` is one grapheme; a base letter followed by
// combining marks still classifies by its first code point.
function classifyWordChar(ch) {
    if (/\s/.test(ch)) return "blank"
    if (/^[\p{L}\p{N}\p{M}_]/u.test(ch)) return "keyword"
    if (/^\p{Extended_Pictographic}/u.test(ch)) return "emoji"
    return "punct"
}
function classifyWORDChar(ch) {
    return /\s/.test(ch) ? "blank" : "nonblank"
}

// Forward, within `text` = cursor-to-end-of-line (text[0] = char under cursor).
// Finds the end of the current word if there's more of it ahead, otherwise
// the end of the next word -- this is what makes repeated `e`/`ee`/`2e`
// naturally agree, per ":help ee/2e are the same".
function findWordEnd(text, classify) {
    const n = text.length
    if (n === 0) return -1
    const cls0 = classify(text[0])
    const atEnd = cls0 !== "blank" && (1 >= n || classify(text[1]) !== cls0)
    let i
    if (cls0 === "blank" || atEnd) {
        i = (cls0 === "blank") ? 0 : 1
        while (i < n && classify(text[i]) === "blank") i++
        if (i >= n) return -1
        const cls = classify(text[i])
        while (i + 1 < n && classify(text[i + 1]) === cls) i++
        return i
    }
    let i2 = 0
    while (i2 + 1 < n && classify(text[i2 + 1]) === cls0) i2++
    return i2
}

// Forward, within `text` = cursor-to-end-of-line. Finds the start of the next word.
function findWordStart(text, classify) {
    const n = text.length
    if (n === 0) return -1
    let i = 0
    const cls0 = classify(text[0])
    if (cls0 !== "blank") {
        while (i < n && classify(text[i]) === cls0) i++
    }
    while (i < n && classify(text[i]) === "blank") i++
    if (i >= n) return -1
    return i
}

// Backward, within `text` = start-of-line-to-cursor. Finds the start of the
// previous word, returned as a distance (steps left) from the cursor.
function findWordStartBackward(text, classify) {
    let i = text.length
    if (i === 0) return -1
    i--
    while (i >= 0 && classify(text[i]) === "blank") i--
    if (i < 0) return -1
    const cls = classify(text[i])
    while (i - 1 >= 0 && classify(text[i - 1]) === cls) i--
    return text.length - i
}

// Applies one of the four finder functions `count` times in a row, each time
// re-slicing the text so the previous match becomes the new "cursor".
function countedWordSteps(text, classify, count, finder, backward) {
    let t = text
    let total = 0
    for (let n = 0; n < count; n++) {
        const step = finder(t, classify)
        if (step === -1) return -1
        total += step
        t = backward ? t.slice(0, t.length - step) : t.slice(step)
    }
    return total
}

// Fallback for when a motion runs off the end of what we've read (i.e. it
// would need to continue onto another line): reproduces the old
// native-Ctrl+Right/Ctrl+Left-based behavior for exactly that one press.
function fallbackWordMotion(forward, shift) {
    sendKeyEvent(forward ? "right" : "left", wordMods(shift))
}
function fallbackWordEnd(shift) {
    // The old repeat-nudge heuristic -- kept only as the cross-line fallback,
    // where its "assume we're at a previous end-of-word" premise is a much
    // smaller approximation than it was as the primary implementation.
    sendKeyEvent("right", { shift })
    sendKeyEvent("right", { shift })
    sendKeyEvent("right", wordMods(shift))
    sendKeyEvent("left", { shift })
    sendKeyEvent("left", { shift })
}

// Guards against a second w/e/b press firing an overlapping async read while
// one is already in flight (there's no "waiting for input" mode transition
// for these, unlike f/t, so eventHandler would otherwise happily dispatch a
// second call mid-read).
let pendingWordCount = 1
let pendingLineCount = 1

async function performWordMotion(kind, classify, count, operator, returnMode) {
    if (oracleBusy) return
    // Operators and WORD/e motions keep Vim boundaries. Normal w/b may use
    // Docs' synchronous word navigation, with no clipboard round trip.
    if (!operator && returnMode === "normal" && settings.wordMotion === "native" &&
        classify === classifyWordChar && (kind === "w" || kind === "b")) {
        repeatMotion(() => fallbackWordMotion(kind === "w", false), count)
        switchModeToNormal()
        return
    }
    if (returnMode === "visual" || returnMode === "visualLine") {
        // No oracle in visual modes -- see "Visual mode model". Charwise
        // visual with a line model never gets here (handleKeyEventVisualLine
        // computes it directly); this is the model-less native fallback.
        fallbackToNativeWordMotion(kind, (kind === "e" || kind === "w"), operator, returnMode)
        return
    }
    if (!beginOracle()) return
    try {
        await performWordMotionInner(kind, classify, count, operator, returnMode)
    } finally {
        releaseOracle()
    }
}

function fallbackToNativeWordMotion(kind, forward, operator, returnMode, count = 1) {
    const shift = !!operator || returnMode === "visual" || returnMode === "visualLine"
    if (!operator && returnMode === "visual") {
        visualNativeWordMotion(kind)
    } else {
        repeatMotion(() => {
            if (kind === "e") fallbackWordEnd(shift)
            else fallbackWordMotion(forward, shift)
        }, count)
    }
    if (operator) {
        runLongStringOp(operator, false)
    } else if (returnMode === "visual" || returnMode === "visualLine") {
        // Can't know exactly how far the native Ctrl+Right/Left jump moved,
        // so the line model (if any) can't be kept in sync: drop it. Native
        // motions and the exact-in-line model never mix.
        visualModel = null
        mode = returnMode
        updateModeIndicator(mode)
    } else {
        switchModeToNormal()
    }
}

async function performWordMotionInner(kind, classify, count, operator, returnMode) {
    const forward = (kind === "e" || kind === "w")
    const inclusive = (kind === "e")

    if (returnMode === "visual" || returnMode === "visualLine") {
        // Never read the document with a visual selection live (see "Visual
        // mode model"); performWordMotion() already routes visual modes to
        // the native fallback, this is belt-and-braces.
        fallbackToNativeWordMotion(kind, forward, operator, returnMode)
        return
    }

    const raw = forward ? await readAfterCursor() : await readBeforeCursor()

    if (raw === null) {
        finishFind(returnMode) // oracle read failed -- bail out to normal, same as f/t
        return
    }
    const text = toGraphemes(raw)

    const finder = kind === "e" ? findWordEnd
        : kind === "w" ? findWordStart
        : findWordStartBackward // "b"
    const steps = countedWordSteps(text, classify, count, finder, !forward)

    if (steps === -1) {
        // Ran off the end of the current line -- fall back to the native
        // motion for this one press rather than silently doing nothing.
        fallbackToNativeWordMotion(kind, forward, operator, returnMode, count)
        return
    }

    applyMotionSteps(forward, inclusive, steps, operator, returnMode)
}

// --- Scrolling -------------------------------------------------------------
// Ctrl+d/u move half a viewport; Ctrl+f/b use native page navigation.
// Visual modes keep Shift held or use whole-line boundary steps.
// Ctrl+e/y changes only the document container scrollTop.
function estimateLinesPerScreen() {
    const ct = getCursorTop()
    if (!ct || typeof window === "undefined" || !window.innerHeight) return null
    let h
    try { h = ct.getBoundingClientRect().height } catch (err) { return null }
    if (!h) return null
    return Math.max(1, Math.round((window.innerHeight * 0.9) / h))
}

function halfScreenScroll(down) {
    const lines = estimateLinesPerScreen()
    const count = lines ? Math.max(1, Math.round(lines / 2)) : 10
    if (mode === "visualLine") vlMoveVertical(down ? count : -count)
    else if (mode === "visual") visualNativeMotion(down, () => {
        repeatMotion(() => sendKeyEvent(down ? "down" : "up", { shift: true }), count)
    })
    else repeatMotion(() => sendKeyEvent(down ? "down" : "up"), count)
}

function fullScreenScroll(down) {
    if (mode === "visualLine") {
        const count = Math.max(1, (estimateLinesPerScreen() || 20) - 2)
        vlMoveVertical(down ? count : -count)
    } else if (mode === "visual") {
        visualNativeMotion(down, () => sendKeyEvent(down ? "pagedown" : "pageup", { shift: true }))
    } else sendKeyEvent(down ? "pagedown" : "pageup")
}

let docsScrollContainer = null
function getDocsScrollContainer() {
    if (docsScrollContainer && docsScrollContainer.isConnected) return docsScrollContainer
    docsScrollContainer = document.querySelector(".kix-appview-editor")
        || document.querySelector(".kix-rotatingtilemanager-content")
        || document.scrollingElement
        || null
    return docsScrollContainer
}

function scrollOneLine(down) {
    const el = getDocsScrollContainer()
    const ct = getCursorTop()
    let lineHeight = 20
    try { const h = ct && ct.getBoundingClientRect().height; if (h) lineHeight = h } catch (err) {}
    if (!el || typeof el.scrollTop !== "number") {
        console.warn("DocsKeys: couldn't find the document's scroll container for Ctrl+e/Ctrl+y (best-effort feature)")
        return
    }
    el.scrollTop += down ? lineHeight : -lineHeight
}

// --- Toggle case -----------------------------------------------------------
// Read the current run, transform graphemes, and paste the replacement with
// clipboard save/restore. This does not change a register.
function toggleGraphemeCase(ch) {
    const upper = ch.toUpperCase()
    const lower = ch.toLowerCase()
    if (ch !== lower && ch === upper) return lower
    if (ch !== upper && ch === lower) return upper
    return ch
}

async function performTildeOp(count) {
    if (oracleBusy) return
    if (!beginOracle()) return
    try {
        await withClipboardSaved(async (previousClipboard) => {
            const raw = await readAfterCore(previousClipboard)
            if (raw === null) return
            const chars = toGraphemes(raw)
            const n = Math.min(count, chars.length)
            if (n === 0) return
            const toggled = chars.slice(0, n).map(toggleGraphemeCase).join("")
            repeatMotion(() => sendKeyEvent("right", { shift: true }), n)
            try {
                await navigator.clipboard.writeText(toggled)
                clickMenu(menuItems.paste) // lands the cursor right after the pasted text, matching Vim's ~ moving the cursor forward by `count`
            } catch (err) {
                console.warn("DocsKeys: ~ couldn't write the toggled text (best-effort feature)", err)
            }
        })
    } finally {
        releaseOracle()
    }
}

function goToDocStart(shift = false) {
    if (isMac) {
        sendKeyEvent("up", { meta: true, shift })
    } else {
        sendKeyEvent("home", { control: true, shift })
    }
}

function goToDocEnd(shift = false) {
    if (isMac) {
        sendKeyEvent("down", { meta: true, shift })
    } else {
        sendKeyEvent("end", { control: true, shift })
    }
}

function goToTop() {
    goToDocStart(true)
    longStringOp = ""
}

function selectToEndOfPara() {
    sendKeyEvent("down", paragraphMods(true))
}
function goToEndOfPara(shift = false) {
    sendKeyEvent("down", paragraphMods(shift))
    sendKeyEvent("right", { shift })
}
function goToStartOfPara(shift = false) {
    sendKeyEvent("up", paragraphMods(shift))
}

function selectToEndOfLineCounted(count) {
    selectToEndOfLine()
    for (let i = 1; i < count; i++) {
        sendKeyEvent("down", { shift: true })
        sendKeyEvent("end", { shift: true })
    }
}

function selectLinesDown(count) {
    goToStartOfLine()
    sendKeyEvent("end", { shift: true })
    for (let i = 0; i < count; i++) {
        sendKeyEvent("down", { shift: true })
        sendKeyEvent("end", { shift: true })
    }
}

function selectLinesUp(count) {
    goToEndOfLine()
    for (let i = 0; i < count; i++) {
        sendKeyEvent("up", { shift: true })
    }
    sendKeyEvent("home", { shift: true })
}


function addLineTop() {
    goToStartOfLine()
    sendKeyEvent("enter", { shift: true })
    sendKeyEvent("up")
    switchModeToInsert()
}
function addLineBottom() {
    goToEndOfLine()
    sendKeyEvent("enter", { shift: true })
    switchModeToInsert()
}

function runLongStringOp(operation = longStringOp, linewise = false) {
    const reg = pendingRegister
    const append = pendingRegisterAppend
    pendingRegister = null
    pendingRegisterAppend = false
    switch (operation) {
        case "c":
            return runClipboardCommand(() => deleteOrChangeSelection(reg, append, true, linewise))
        case "d":
            return runClipboardCommand(() => deleteOrChangeSelection(reg, append, false, linewise))
        case "y":
            return runClipboardCommand(() => yankSelection(reg, append))
        case "p": {
            const pasted = pasteRegister(reg)
            switchModeToNormal()
            return pasted
        }
        case "v":
            break
        case "g":
            goToTop()
            break
    }
}


// --- Operator text objects --------------------------------------------------
// iw selects a same-class run; aw includes trailing whitespace, or leading
// whitespace when none follows. Counts extend across subsequent objects.
// Read once with no live selection, then select the computed grapheme range.
let operatorObjectPrefix = "i"   // 'i' | 'a', remembered from waitForFirstInput
let operatorObjectCount = 1

async function performTextObjectOperator(op, around, classify, count) {
    if (!beginOracle()) return
    try {
        const line = await readLineContext()
        if (line === null) {
            switchModeToNormal()
            return
        }
        const before = toGraphemes(line.before)
        const text = before.concat(toGraphemes(line.after))
        if (text.length === 0) {
            // Nothing on this line (Vim: the object doesn't exist, no change).
            switchModeToNormal()
            return
        }
        // Caret after the last character (after `$`/`A`+Esc): Vim's cursor
        // would be ON the last character.
        const idx = Math.min(before.length, text.length - 1)
        const range = textObjectRange(text, idx, classify, around)
        const s = range[0]
        let e = range[1]
        for (let n = 1; n < count; n++) {
            if (e + 1 >= text.length) break
            e = textObjectRange(text, e + 1, classify, around)[1]
        }
        const back = before.length - s
        if (back > 0) repeatMotion(() => sendKeyEvent("left"), back)
        else if (back < 0) repeatMotion(() => sendKeyEvent("right"), -back)
        repeatMotion(() => sendKeyEvent("right", { shift: true }), e - s + 1)
        await runLongStringOp(op, false)
    } finally {
        releaseOracle()
    }
}

function waitForSecondInput(key) {
    const around = operatorObjectPrefix === "a"
    const op = longStringOp
    const count = operatorObjectCount || 1
    operatorObjectCount = 1
    switch (key) {
        case "w":
        case "W": {
            const classify = key === "W" ? classifyWORDChar : classifyWordChar
            const fn = () => performTextObjectOperator(op, around, classify, count)
            if (op !== "y") recordChange(fn) // yanks are never dot-repeated
            fn()
            break
        }
        case "p":
            goToStartOfPara()
            waitForFirstInput(key)
            break
        default:
            switchModeToNormal()
            break
    }
}

function waitForFirstInput(key) {
    if (/^[1-9]$/.test(key) || (operatorCount > 0 && key === "0")) {
        operatorCount = operatorCount * 10 + Number(key)
        return
    }
    const count = operatorCount || 1
    operatorCount = 0
    const op = longStringOp 

    switch (key) {
        case "i":
        case "a":
            operatorObjectPrefix = key
            operatorObjectCount = count
            switchModeToWait2()
            break
        case "w":
        case "W":
            performWordMotion("w", key === "W" ? classifyWORDChar : classifyWordChar, count, op, "normal")
            break
        case "e":
        case "E":
            performWordMotion("e", key === "E" ? classifyWORDChar : classifyWordChar, count, op, "normal")
            break
        case "b":
        case "B":
            performWordMotion("b", key === "B" ? classifyWORDChar : classifyWordChar, count, op, "normal")
            break
        case "h":
            runDotRepeatable(() => { repeatMotion(() => sendKeyEvent("left", { shift: true }), count); runLongStringOp(op) }, op)
            break
        case "l":
            runDotRepeatable(() => { repeatMotion(() => sendKeyEvent("right", { shift: true }), count); runLongStringOp(op) }, op)
            break
        case "j":
            runDotRepeatable(() => { selectLinesDown(count); runLongStringOp(op, true) }, op)
            break
        case "k":
            runDotRepeatable(() => { selectLinesUp(count); runLongStringOp(op, true) }, op)
            break
        case "p":
        case "}":
            runDotRepeatable(() => { repeatMotion(selectToEndOfPara, count); runLongStringOp(op) }, op)
            break
        case "{":
            runDotRepeatable(() => { repeatMotion(() => goToStartOfPara(true), count); runLongStringOp(op) }, op)
            break
        case "^":
        case "_":
            goToFirstNonBlank(op, "normal")
            break
        case "0":
            runDotRepeatable(() => { selectToStartOfLine(); runLongStringOp(op) }, op)
            break
        case "$":
            runDotRepeatable(() => { selectToEndOfLine(); runLongStringOp(op) }, op)
            break
					case "G":
            runDotRepeatable(() => { goToDocEnd(true); runLongStringOp(op) }, op)
            break
        case "g":
            runDotRepeatable(() => { goToDocStart(true); runLongStringOp(op) }, op)
            break
        case "f":
        case "F":
        case "t":
        case "T":
            pendingFindType = key
            pendingFindOperator = op
            pendingFindCount = count
            pendingFindReturnMode = "normal"
            mode = "waitForFindChar"
            updateModeIndicator(mode)
            break
        case ";":
            if (lastFind) { repeatLastFind(false, op, "normal") } else { switchModeToNormal() }
            break
        case ",":
            if (lastFind) { repeatLastFind(true, op, "normal") } else { switchModeToNormal() }
            break
        case longStringOp:
            runDotRepeatable(() => {
                goToStartOfLine()
                selectToEndOfLine()
                for (let i = 1; i < count; i++) {
                    sendKeyEvent("down", { shift: true })
                    sendKeyEvent("end", { shift: true })
                }
                runLongStringOp(op, true)
            }, op)
            break
        default:
            switchModeToNormal()
    }
}

// The second key of `iw`/`aw`/`iW`/`aW`/`ip`/`ap` typed in visual mode. Which
// prefix was pressed is remembered in visualObjectPrefix (it used to be lost,
// which is why `iw` and `aw` were indistinguishable). Anything other than a
// supported object key cancels back to the visual mode it was started from --
// previously any other key silently switched to visual LINE mode.
//
// Vim behavior implemented here (:help v_aw v_iw v_ap v_ip, verified against
// motion.txt): iw/aw/iW/aW work on the word under the cursor, and extend the
// selection when repeated; ip/ap switch to LINEWISE visual mode.
function waitForVisualInput(key) {
    const returnMode = visualObjectReturnMode
    const around = (visualObjectPrefix === "a")
    switch (key) {
        case "w":
        case "W":
            mode = returnMode
            if (returnMode === "visual" && visualModel) {
                visualSelectTextObject(around, key === "W" ? classifyWORDChar : classifyWordChar)
            } else {
                console.warn("DocsKeys: iw/aw aren't available in this visual selection (visual line mode, or the selection has moved off the line) -- leave and re-enter visual mode to reset")
            }
            updateModeIndicator(mode)
            break
        case "p":
            visualModel = null
            goToStartOfPara()
            switchModeToVisualLine()
            vlParagraph(true)
            break
        default:
            mode = returnMode
            updateModeIndicator(mode)
            break
    }
}

function handleMultipleMotion(key) {
    if (/^[0-9]$/.test(key)) {
        multipleMotion.times = Number(String(multipleMotion.times)+key)
        return
    }

    const times = multipleMotion.times || 1
    const targetMode = multipleMotion.mode

    if (targetMode === "visual" || targetMode === "visualLine") {
        // Restore the real visual mode BEFORE dispatching: the visual
        // handlers read `mode` (and used to receive "multipleMotion" as the
        // return mode, which made every counted visual motion -- `3w`, `2l`
        // -- silently drop out of visual mode). Also fixed: the count used
        // to always restore "visualLine", even for charwise `v`.
        mode = targetMode
        multipleMotion.times = 0
        if (key === "f" || key === "F" || key === "t" || key === "T") {
            pendingFindCount = times
            handleKeyEventVisualLine(key)
            return
        }
        if (key === "c" || key === "d" || key === "y" || key === "p" || key === "x" || key === "s" ||
            key === "o" || key === "O" || key === "i" || key === "a" || key === "\"") {
            handleKeyEventVisualLine(key) // a count doesn't apply to these
            return
        }
        repeatMotion(handleKeyEventVisualLine, times, key)
        return
    }

    if (targetMode === "normal" && (key === "c" || key === "d" || key === "y")) {
        operatorCount = times
        handleKeyEventNormal(key)
        multipleMotion.times = 0
        return
    }

    if (targetMode === "normal" && (key === "f" || key === "F" || key === "t" || key === "T")) {
        pendingFindCount = times
        handleKeyEventNormal(key)
        multipleMotion.times = 0
        return
    }

    if (targetMode === "normal" && (key === "w" || key === "W" || key === "e" || key === "E" || key === "b" || key === "B")) {
        pendingWordCount = times
        handleKeyEventNormal(key)
        multipleMotion.times = 0
        return
    }

    if (targetMode === "normal" && (key === "D" || key === "C" || key === "Y" || key === "x" || key === "s" || key === "~")) {
        pendingLineCount = times
        handleKeyEventNormal(key)
        multipleMotion.times = 0
        return
    }

    switch (targetMode) {
        case "normal":
            repeatMotion(handleKeyEventNormal, times, key)
            break
        case "visualLine":
        case "visual":
            repeatMotion(handleKeyEventVisualLine, times, key)
            break
    }

    if (mode === "multipleMotion") {
        mode = targetMode
    }
    multipleMotion.times = 0
}



// Escape while a sub-command that STARTED in visual mode is pending (the
// second key of iw/aw, the character of f/t, a "register, or a count) cancels
// just that sub-command and stays in visual mode, like Vim. Previously Escape
// dropped to normal mode with the selection still highlighted, leaving
// DocsKeys' mode and the on-screen selection disagreeing.
function visualModeToResumeOnEscape() {
    switch (mode) {
        case "waitForFindChar":
            return (pendingFindReturnMode === "visual" || pendingFindReturnMode === "visualLine") ? pendingFindReturnMode : null
        case "waitForRegister":
            return (waitForRegisterReturnMode === "visual" || waitForRegisterReturnMode === "visualLine") ? waitForRegisterReturnMode : null
        case "waitForVisualInput":
            return visualObjectReturnMode
        case "multipleMotion":
            return (multipleMotion.mode === "visual" || multipleMotion.mode === "visualLine") ? multipleMotion.mode : null
    }
    return null
}

// Esc from a live visual selection: collapse it and leave the caret where
// Vim's cursor was. With the line model that is exact: for a forward
// selection the caret goes to the cursor character (Right collapses to the
// selection's end, one past it, then Left steps back); for a backward
// selection the cursor is the selection's start (Left collapses there).
// Without a model the old behavior is kept (collapse to the end).
function leaveVisualSelectionForEscape() {
    if (mode === "visual" && visualModel) {
        if (visualModel.c >= visualModel.a) {
            sendKeyEvent("right")
            sendKeyEvent("left")
        } else {
            sendKeyEvent("left")
        }
    } else if (mode === "visual") {
        if (nativeVisualFocusAfter) {
            sendKeyEvent("right")
            sendKeyEvent("left")
        } else sendKeyEvent("left")
    } else {
        sendKeyEvent("right")
    }
}

// Keys typed with Ctrl/Alt/Meta held used to pass straight through to Docs,
// even while a document read had a TEMPORARY selection in place and the user's
// clipboard temporarily replaced: a Ctrl+V then pasted over the highlighted
// rest-of-line, Ctrl+B bolded it, Ctrl+X cut it... While a read is in flight
// these are now held. The clipboard/undo ones are replayed afterwards through
// the same Edit-menu clicks DocsKeys uses everywhere else; the rest are
// dropped (the window is a fraction of a second).
const HELD_NAMED_KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Backspace", "Delete", "Enter"]
function handleModifiedKey(e) {
    if (mode === "insert") return
    const k = e.key || ""
    if (!oracleBusy) {
        // Native selection commands (Ctrl+A, Ctrl+Shift+arrows, ...) can
        // create a selection while in normal mode; make sure it is noticed.
        if (e.shiftKey || k.toLowerCase() === "a") markSelectionCheck("user")
        return
    }
    if (!(k.length === 1 || HELD_NAMED_KEYS.includes(k))) return
    e.preventDefault()
    e.stopImmediatePropagation()
    if (e.repeat) return
    const primary = isMac ? e.metaKey : e.ctrlKey
    if (!primary || e.altKey) return
    // Raw e.key on purpose: Docs interprets its shortcuts by the layout's
    // character, not by DocsKeys' Dvorak->QWERTY command translation.
    switch (k.toLowerCase()) {
        case "c": queueKey({ menu: "copy" }); break
        case "x": queueKey({ menu: "cut" }); break
        case "v": queueKey({ menu: "paste" }); break
        case "z": queueKey({ menu: e.shiftKey ? "redo" : "undo" }); break
        case "y": queueKey({ menu: "redo" }); break
    }
}

function eventHandler(e) {
    if (e.isTrusted === false || e.isComposing || e.keyCode === 229) return
    if (
        ["Shift","Meta","Control","Alt",""].includes(e.key)
    ) return

    hasHandledKey = true

    if (e.ctrlKey && e.key === "[") {
        e.preventDefault()
        e.stopImmediatePropagation()
        if (oracleBusy) queueKey({ key: "Escape" })
        else handleKey({ key: "Escape", preventDefault() {} })
        return
    }

    const key = translateKey(e.key)

    if (e.ctrlKey && mode=='insert' && key=='o' ){
        e.preventDefault()
        e.stopImmediatePropagation()
        switchModeToNormal()

        tempnormal = true
        return;
    }
    if (e.ctrlKey && mode=='normal' && key=='r') {
        e.preventDefault()
        e.stopImmediatePropagation()
        if (oracleBusy) {
            queueKey({ redo: true })
            return
        }
        clickMenu(menuItems.redo)
        return;
    }
    if (e.ctrlKey && (mode == 'normal' || mode == 'visual' || mode == 'visualLine') &&
        (key == 'd' || key == 'u' || key == 'f' || key == 'b' || key == 'e' || key == 'y')) {
        e.preventDefault()
        e.stopImmediatePropagation()
        if (oracleBusy) return // scrolling mid-read would move the caret out from under the temporary selection
        switch (key) {
            case 'd': halfScreenScroll(true); break
            case 'u': halfScreenScroll(false); break
            case 'f': fullScreenScroll(true); break
            case 'b': fullScreenScroll(false); break
            case 'e': scrollOneLine(true); break
            case 'y': scrollOneLine(false); break
        }
        if (key !== 'e' && key !== 'y' && (mode === 'visual' || mode === 'visualLine')) {
            // These move the cursor across lines; the exact charwise model
            // (if any) can no longer be trusted, same as any other
            // line-leaving motion.
            visualModel = null
        }
        refreshCursorOverlayForCurrentMode()
        return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey) {
        handleModifiedKey(e)
        return;
    }

    // A document read is in flight and the selection is temporarily changed:
    // hold this key and replay it (in order) once the read finishes. Insert
    // mode is never queued -- typing goes straight to Docs.
    if (oracleBusy && mode != 'insert') {
        e.preventDefault()
        e.stopImmediatePropagation()
        // A key that is being HELD down is not queued: key repeat is faster
        // than a read, so every repeat used to pile up in the queue and keep
        // executing (`w` held down kept jumping words after release). While a
        // read is in flight only distinct presses count; the repeat that
        // arrives after the read finishes starts the next one.
        if (e.repeat) return
        queueKey({ key: e.key })
        return
    }

    handleKey(e)
}

// The real key handling. `e` is either a genuine keydown event or, when
// replaying a queued key, a stub with { key, replayed: true } -- a replayed
// key has already been preventDefault()ed, so it can't fall through to Docs
// as native typing.
function handleKey(e) {
    const arrows = { ArrowLeft: "h", ArrowDown: "j", ArrowUp: "k", ArrowRight: "l", Home: "0", End: "$" }
    const key = arrows[e.key] || translateKey(e.key)

    if (e.key == 'Escape') {
        e.preventDefault()
        const resume = visualModeToResumeOnEscape()
        if (resume) {
            pendingFindType = null
            pendingFindOperator = null
            pendingFindCount = 1
            pendingRegister = null
            pendingRegisterAppend = false
            multipleMotion.times = 0
            mode = resume
            updateModeIndicator(mode)
            return
        }
        if (mode == 'visualLine' || mode == 'visual') {
            leaveVisualSelectionForEscape()
        }
        pendingRegister = null
        pendingRegisterAppend = false
        pendingFindType = null
        pendingFindOperator = null
        pendingFindCount = 1
        pendingWordCount = 1
        pendingLineCount = 1
        operatorCount = 0
        multipleMotion.times = 0
        switchModeToNormal()
        return;
    }
    if (mode == 'replaceChar') {
        if (key.length === 1) {
            if (e.replayed) {
                // This key was queued while a read was in flight, so its
                // native keydown was already swallowed and can't supply the
                // replacement character (DocsKeys can't type text itself).
                // Cancel the replace rather than delete a character and
                // insert nothing.
                console.warn("DocsKeys: r{char} was cancelled because the character arrived while a document read was in flight -- press r again")
                switchModeToNormal()
                if (tempnormal) {
                    tempnormal = false
                    switchModeToInsert()
                }
                return;
            }
            sendKeyEvent('delete')
            switchModeToNormal()
            if (tempnormal) {
                tempnormal = false
                switchModeToInsert()
            }
            return;
        }
        e.preventDefault()
        switchModeToNormal()
        return;
    }
    if (mode != 'insert') {
        e.preventDefault()
        switch (mode) {
            case "normal":
                handleKeyEventNormal(key)
                break
            case "visual":
            case "visualLine":
                handleKeyEventVisualLine(key)
                break
            case "waitForFirstInput":
                waitForFirstInput(key)
                break
            case "waitForSecondInput":
                waitForSecondInput(key)
                break
            case "waitForVisualInput":
                waitForVisualInput(key)
                break
            case "waitForRegister":
                waitForRegisterInput(key)
                break
            case "waitForFindChar":
                handleFindCharInput(e.key) // raw key -- see handleFindCharInput's comment
                break
            case "multipleMotion":
                handleMultipleMotion(key)
                break
        }
    }
}

function handleKeyEventNormal(key) {
    if (/^[1-9]$/.test(key)) {
        mode = "multipleMotion"
        multipleMotion.mode = "normal"
        multipleMotion.times = Number(key)
        return
    }
    
    switch (key) {
        case "h":
            sendKeyEvent("left")
            break
        case "j":
            nativeVerticalStep(true)
            break
        case "k":
            nativeVerticalStep(false)
            break
        case "l":
            sendKeyEvent("right")
            break
        case "}":
            goToEndOfPara()
            break
        case "{":
            goToStartOfPara()
            break
        case "b":
        case "B":
        case "e":
        case "E":
        case "w":
        case "W": {
            const isWORD = (key === "B" || key === "E" || key === "W")
            const kind = (key === "b" || key === "B") ? "b" : (key === "e" || key === "E") ? "e" : "w"
            const wcount = pendingWordCount || 1
            pendingWordCount = 1
            performWordMotion(kind, isWORD ? classifyWORDChar : classifyWordChar, wcount, null, "normal")
            break
        }
        case "g":
            goToDocStart()
            break
        case "G":
            goToDocEnd()
            break
        case "c":
        case "d":
        case "y":
            longStringOp = key
            mode = "waitForFirstInput"
            break
        case "D":
            { const lcount = pendingLineCount || 1
              pendingLineCount = 1
              const fn = () => { selectToEndOfLineCounted(lcount); runLongStringOp("d") }
              fn(); recordChange(fn) }
            break
        case "C":
            { const lcount = pendingLineCount || 1
              pendingLineCount = 1
              const fn = () => { selectToEndOfLineCounted(lcount); runLongStringOp("c") }
              fn(); recordChange(fn) }
            break
        case "Y":
            { const lcount = pendingLineCount || 1
              pendingLineCount = 1
              selectToEndOfLineCounted(lcount)
              runLongStringOp("y") }
            break
        case "\"":
            switchModeToWaitForRegister()
            break
        case "p":
            { const reg = pendingRegister
              pendingRegister = null
              const fn = () => { pasteRegister(reg) }
              fn(); recordChange(fn) }
            break
        case "a":
            sendKeyEvent("right")
            switchModeToInsert()
            break
        case "i":
            switchModeToInsert()
            break
        case "^":
        case "_":
            goToFirstNonBlank(null, "normal")
            break
        case "0":
            goToStartOfLine()
            break
        case "$":
            goToEndOfLine()
            break
        case "I":
            goToStartOfLine()
            switchModeToInsert()
            break
        case "A":
            goToEndOfLine()
            switchModeToInsert()
            break
        case "v":
            switchModeToVisual()
            break
        case "V":
            switchModeToVisualLine()
            break
        case "o":
            addLineBottom()
            break
        case "O":
            addLineTop()
            break
        case "u":
            clickMenu(menuItems.undo)
            break
        case "r":
            switchModeToReplaceChar()
            break
        case ".":
            if (lastChange) lastChange()
            break
        case "/":
            clickMenu(menuItems.find)
            break
        case "f":
        case "F":
        case "t":
        case "T":
            pendingFindType = key
            pendingFindOperator = null
            pendingFindReturnMode = "normal"
            // pendingFindCount was already set by handleMultipleMotion for a
            // count prefix like "3fx"; default to 1 for a bare "fx".
            pendingFindCount = pendingFindCount || 1
            mode = "waitForFindChar"
            updateModeIndicator(mode)
            break
        case ";":
            repeatLastFind(false)
            break
        case ",":
            repeatLastFind(true)
            break
        case "x":
            { const xcount = pendingLineCount || 1
              pendingLineCount = 1
              const fn = () => { repeatMotion(() => sendKeyEvent("delete"), xcount) }
              fn(); recordChange(fn) }
            break
				case "s":
            { const scount = pendingLineCount || 1
              pendingLineCount = 1
              const fn = () => { repeatMotion(() => sendKeyEvent("delete"), scount); switchModeToInsert() }
              fn(); recordChange(fn) }
            break
        case "J":
            { const fn = () => {
                goToEndOfLine()
                sendKeyEvent("delete")
                sendKeyEvent("space")
              }
              fn(); recordChange(fn) }
            break
        case "~":
            { const tcount = pendingLineCount || 1
              pendingLineCount = 1
              const fn = () => { performTildeOp(tcount) }
              fn(); recordChange(fn) }
            break
        default:
            return;
    }
    finishTemporaryNormal()
    refreshCursorOverlayForCurrentMode()
}

function handleKeyEventVisualLine(key) {
    if (/^[1-9]$/.test(key)) {
        multipleMotion.mode = mode // "visual" or "visualLine" -- was hard-coded to "visualLine"
        mode = "multipleMotion"
        multipleMotion.times = Number(key)
        return
    }

    if (mode === "visualLine") {
        handleKeyEventVisualLineMode(key)
        refreshCursorOverlayForCurrentMode()
        return
    }

    // The line model exists only in charwise visual mode, and only until the
    // selection leaves the line `v` was pressed on.
    const model = (mode === "visual") ? visualModel : null

    switch (key) {
        case "v":
            leaveVisualSelectionForEscape()
            switchModeToNormal()
            break
        case "V":
            sendKeyEvent("left")
            switchModeToVisualLine()
            break
        case "":
            break
        case "h":
            if (model) visualMoveCursor(model.c - 1)
            else visualNativeMotion(false, () => sendKeyEvent("left", { shift: true }))
            break
        case "l":
            if (model) visualMoveCursor(model.c + 1)
            else visualNativeMotion(true, () => sendKeyEvent("right", { shift: true }))
            break
        case "j":
            visualNativeMotion(true, () => nativeVerticalStep(true, true))
            break
        case "k":
            visualNativeMotion(false, () => nativeVerticalStep(false, true))
            break
        case "\"":
            switchModeToWaitForRegister()
            break
        case "p":
            { const reg = pendingRegister
              pendingRegister = null
              // Leave visual mode BEFORE pasting. switchModeToNormal() sends
              // a Left in visual LINE mode; with a named register the paste
              // happens asynchronously (after a clipboard round-trip), so
              // that Left used to collapse the selection first and the paste
              // then landed at its start instead of replacing it.
              mode = "normal"
              pasteRegister(reg) }
            switchModeToNormal()
            break
        case "}":
            visualNativeMotion(true, () => goToEndOfPara(true))
            break
        case "{":
            visualNativeMotion(false, () => goToStartOfPara(true))
            break
        case "b":
        case "B":
        case "e":
        case "E":
        case "w":
        case "W": {
            const wordKind = (key === "b" || key === "B") ? "b" : (key === "e" || key === "E") ? "e" : "w"
            const classify = (key === "B" || key === "E" || key === "W") ? classifyWORDChar : classifyWordChar
            if (model) {
                visualWordMotion(wordKind, classify)
            } else {
                fallbackToNativeWordMotion(wordKind, (wordKind === "e" || wordKind === "w"), null, mode)
            }
            break
        }
        case "^":
        case "_":
            if (model) {
                visualMoveCursor(firstNonBlankIndex(model.text))
            } else {
                console.warn("DocsKeys: ^/_ isn't available in this visual selection (visual line mode, or the selection has moved off the line) -- leave and re-enter visual mode to reset")
            }
            break
        case "0":
            if (model) visualMoveCursor(0)
            else visualNativeMotion(false, () => selectToStartOfLine())
            break
        case "$":
            // Real Vim's `$` in Visual mode also selects the line break; this
            // stops at the last character (Docs' shift+End) -- documented
            // deviation, safer than accidentally joining lines.
            if (model) visualMoveCursor(model.text.length - 1)
            else visualNativeMotion(true, () => {
                sendKeyEvent("end", { shift: true })
                const end = cursorDocumentPoint()
                sendKeyEvent("left", { shift: true })
                const last = cursorDocumentPoint()
                if (end && last && Math.abs(end.y - last.y) > 1) sendKeyEvent("right", { shift: true })
            })
            break
        case "G":
            visualNativeMotion(true, () => goToDocEnd(true))
            break
        case "g":
            visualNativeMotion(false, () => goToDocStart(true))
            break
        case "o":
        case "O":
            // Go to the other end of the selection (:help v_o). Needs the
            // line model: swaps anchor and cursor. (Not available in visual
            // line mode or once the selection has left the line.)
            if (model) visualSetSelection(model.c, model.a)
            break
        case "c":
        case "d":
        case "y":
            visualOperator(key)
            break
        case "x":
            visualOperator("d") // :help v_x -- same as d
            break
        case "s":
            visualOperator("c") // :help v_s -- same as c
            break
        case "i":
        case "a":
            visualObjectPrefix = key
            visualObjectReturnMode = mode
            mode = "waitForVisualInput"
            break
        case "f":
        case "F":
        case "t":
        case "T":
            // A count ({n}f{char}) is set by handleMultipleMotion through
            // pendingFindCount; a bare f{char} finds the first occurrence.
            pendingFindType = key
            pendingFindOperator = null
            pendingFindCount = pendingFindCount || 1
            pendingFindReturnMode = mode
            mode = "waitForFindChar"
            updateModeIndicator(mode)
            break
        case ";":
            if (lastFind) repeatLastFind(false, null, mode)
            break
        case ",":
            if (lastFind) repeatLastFind(true, null, mode)
            break

    }
    refreshCursorOverlayForCurrentMode()
}

let menuItemElements = {}

let menuItems = {
    copy: { parent: "Edit", caption: "Copy" },
    cut: { parent: "Edit", caption: "Cut" },
    paste: { parent: "Edit", caption: "Paste" },
    redo: { parent: "Edit", caption: "Redo" },
    undo: { parent: "Edit", caption: "Undo" },
    find: { parent: "Edit", caption: "Find" },
}

function clickMenu(itemCaption) {
    simulateClick(getMenuItem(itemCaption));
}

function clickToolbarButton(captionList) {
    for (const caption of Array.from(captionList)) {
        const els = document.querySelectorAll(`*[aria-label='${caption}']`);
        if (els.length == 0) {
            console.log(`Couldn't find the element for the button labeled ${caption}.`);
            console.log(captionList);
            return;
        }
        if (els.length > 1) {
            console.log(
                `Warning: there are multiple buttons with the caption ${caption}. ` +
                "We're expecting only 1.",
            );
            console.log(captionList);
        }
        simulateClick(els[0]);
    }
}

function getMenuItem(menuItem, silenceWarning = false) {
    const caption = menuItem.caption;
    let el = menuItemElements[caption];
    if (el) return el;
    el = findMenuItem(menuItem);
    if (!el) {
        if (!silenceWarning) console.error("Could not find menu item with caption", menuItem.caption);
        return null;
    }
    return menuItemElements[caption] = el;
}

function findMenuItem(menuItem) {
    activateTopLevelMenu(menuItem.parent);
    const menuItemEls = document.querySelectorAll(".goog-menuitem");
    const caption = menuItem.caption;
    const isRegexp = caption instanceof RegExp;
    for (const el of Array.from(menuItemEls)) {
        const label = el.innerText;
        if (!label) continue;
        if (isRegexp) {
            if (caption.test(label)) {
                return el;
            }
        } else {
            if (label.startsWith(caption)) {
                return el;
            }
        }
    }
    return null;
}

function simulateClick(el, x = 0, y = 0) {
    if (!el) return
    const eventSequence = ["mouseover", "mousedown", "mouseup", "click"];
    for (const eventName of eventSequence) {
        const event = document.createEvent("MouseEvents");
        event.initMouseEvent(
            eventName,
            true,
            true,
            window,
            1,
            x,
            y,
            x,
            y,
            false,
            false,
            false,
            false,
            0,
            null,
        );
        el.dispatchEvent(event);
    }
}

function activateTopLevelMenu(menuCaption) {
    const buttons = Array.from(document.querySelectorAll(".menu-button"));
    const button = buttons.find((el) => el.innerText.trim() == menuCaption);
    if (!button) {
        throw new Error(`Couldn't find top-level button with caption ${menuCaption}`);
    }
    simulateClick(button);
    simulateClick(button);
}

switchModeToNormal()

try {
    chrome.storage.local.get(DocsKeysSettings.key, (result) => {
        if (chrome.runtime.lastError) return
        applySettings(result[DocsKeysSettings.key])
        if (!hasHandledKey && settings.startInInsert) switchModeToInsert()
    })
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes[DocsKeysSettings.key]) {
            applySettings(changes[DocsKeysSettings.key].newValue)
        }
    })
} catch (err) {
    console.warn("DocsKeys: preferences unavailable; using defaults", err)
}

// switchModeToNormal() above runs immediately on page load, before Google
// Docs has created its cursor element yet -- so the box-cursor sizing it
// tries to do silently no-ops (getCursorTop() finds nothing). Previously
// this meant the box cursor simply didn't appear until *something else*
// happened to call switchModeToNormal() again later (e.g. pressing Esc),
// which looked like "it needs Esc to work" but was really just "nothing
// has retried since the element didn't exist yet". Retrying once the
// element actually shows up fixes this without needing any user action.
waitForElement(
    () => getCursorTop(),
    () => { if (mode === "normal") updateCursorOverlay("block") },
)

// Mouse: a drag / double-click / shift-click in normal mode creates a
// selection Docs makes on its own. It is noticed and turned into Visual mode
// (see markSelectionCheck). A click while a visual mode is active replaces
// the selection behind DocsKeys' back, so the exact models are dropped and
// motions fall back to Docs' native selection motions.
let mouseDownPos = null
if (typeof document.addEventListener === "function") {
    document.addEventListener("mousedown", (e) => {
        if (!e.isTrusted || !e.target.closest(".kix-appview-editor")) return
        mouseDownPos = { x: e.clientX, y: e.clientY }
        if (mode === "visual" || mode === "visualLine") {
            visualModel = null
            visualLineRows = null
            visualAnchorPoint = null
            mode = "visual" // a mouse range need not contain whole lines
            updateModeIndicator(mode)
        }
    }, true)
    document.addEventListener("mouseup", (e) => {
        if (!e.isTrusted || !e.target.closest(".kix-appview-editor")) return
        const moved = mouseDownPos && Math.hypot(e.clientX - mouseDownPos.x, e.clientY - mouseDownPos.y) > 3
        mouseDownPos = null
        if (mode === "insert") return
        if (moved || e.shiftKey || e.detail >= 2) markSelectionCheck("user")
    }, true)
}

startOverlayFrameLoop()
