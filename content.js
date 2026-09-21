// Set to true and reload the extension to log how long each phase of a
// text-oracle read (f/F/t/T/w/e/b) actually takes, in the DevTools console.
// Useful for finding out where remaining latency is actually going, instead
// of guessing -- e.g. whether it's the clipboard round-trip itself, or
// something else like Docs' own Copy-click handler being slow on a large
// document.
const DEBUG_TIMING = false

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
        const el = document.getElementsByTagName('iframe')[0]   
        return (el && el.contentDocument) ? el : null
    },
    (iframe) => {
        iframe.contentDocument.addEventListener('keydown', eventHandler, true)
    },
)

let cursorTop = null
function getCursorTop() {
    if (!cursorTop || !cursorTop.isConnected) {
        // kix-cursor-caret is the element multiple independent sources
        // describe as the actual visible blinking cursor (Docs toggles its
        // `display` between "none"/"inline" for the blink). Falls back to
        // kix-cursor-top in case the class name varies by Docs
        // version/rollout -- unverified against a live page.
        cursorTop = document.getElementsByClassName("kix-cursor-caret")[0]
            || document.getElementsByClassName("kix-cursor-top")[0]
            || null
    }
    return cursorTop
}

// Box/underline cursor: an independent overlay element that follows the
// native caret's on-screen rectangle. The native caret is only ever READ
// (position) and hidden via opacity while the overlay is shown -- see
// hideCursorBoxOverlay().
//
// FOLLOWING THE CARET. Overlay position used to be refreshed only from
// DocsKeys' own keystroke handlers, so anything that moved the caret without
// going through them -- a mouse click, a native arrow key, Docs' own
// scrolling -- left the box stranded where it was. It is now re-positioned
// every animation frame (renderOverlay() is a couple of cheap DOM reads and
// only writes styles when something changed), which covers all of those at
// once. The same frame loop notices caret movement it didn't cause and
// schedules the exact-width refresh (see startOverlayFrameLoop()).
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
// Exact width of the character under the caret, bound to the caret position
// it was measured at (so it is ignored as soon as the caret moves).
let accurateWidth = null        // { left, top, width }

// Positions the overlay over the native caret. Returns a rounded position
// key for the native caret, or null if there is nothing to position against.
// While the native caret is in the "off" phase of its blink (display:none ->
// zero-height rect) the last geometry is simply kept instead of hiding.
function renderOverlay() {
    const shape = overlayShapeWanted
    if (!shape) return null
    const nativeCursor = getCursorTop()
    const fontInfo = getCursorFontInfo()
    if (!nativeCursor || !fontInfo) return null
    let rect
    try { rect = nativeCursor.getBoundingClientRect() } catch (err) { return null }
    if (!rect || !rect.height) return null
    let width = null
    if (accurateWidth && Math.abs(accurateWidth.left - rect.left) < 1 && Math.abs(accurateWidth.top - rect.top) < 1) {
        width = accurateWidth.width
    }
    if (!width) width = measureCharWidth(fontInfo)
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
    const nativeCursor = getCursorTop()
    if (nativeCursor) nativeCursor.style.opacity = ""
}

function updateCursorOverlay(shape) {
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

// --- Unexpected selections in normal mode ------------------------------------
// A selection while DocsKeys thinks it is in normal mode is a bug by
// definition. Two sources:
//   "user"   -- the person made it (mouse drag / double-click / shift-click,
//               Ctrl+A, Ctrl+Shift+arrows). Like Vim, a mouse selection
//               simply starts Visual mode, so the mode badge always agrees
//               with what is on screen.
//   "glitch" -- DocsKeys left one behind (a failed document read, ...). It is
//               collapsed.
// Detecting a selection costs one Copy, so it only happens when one of those
// sources flagged it (markSelectionCheck), during the same idle-time pass
// that refreshes the box width.
let pendingSelectionCheck = null   // null | "user" | "glitch"
function markSelectionCheck(reason) {
    if (pendingSelectionCheck === "user") return
    pendingSelectionCheck = reason
    if (mode === "normal") scheduleAccurateWidthRefresh()
}
function noteSelectionGlitch() {
    // No scheduling here (a persistently failing read must not re-trigger
    // itself); the next idle pass will look.
    if (pendingSelectionCheck === null) pendingSelectionCheck = "glitch"
}
function handleUnexpectedSelection(reason) {
    if (reason === "user") {
        visualModel = null
        mode = "visual"
        updateModeIndicator(mode)
    } else {
        sendKeyEvent("left") // collapse to the start of the selection
    }
}

// Debounced exact-character width refresh (+ selection check) for the
// NORMAL-mode box cursor. Safety rules, each from a real bug found in review:
//  * NORMAL MODE ONLY -- it temporarily changes the selection.
//  * It goes through beginOracle()/releaseOracleQuiet(): keys that arrive
//    while the temporary selection exists are QUEUED and replayed after.
//  * It selects exactly ONE character (shift+Right, Copy, collapse) instead
//    of the whole rest of the line, which is what made the box lag behind
//    the caret.
//  * The debounce is short; caret movement DocsKeys didn't cause (mouse,
//    arrows, scrolling) also triggers it, from the frame loop.
let ACCURATE_WIDTH_REFRESH_DEBOUNCE_MS = 40
let accurateWidthRefreshTimer = null
let lastEmptyWidthReadKey = null

function scheduleAccurateWidthRefresh() {
    if (mode !== "normal") return
    clearTimeout(accurateWidthRefreshTimer)
    accurateWidthRefreshTimer = setTimeout(runAccurateWidthRefresh, ACCURATE_WIDTH_REFRESH_DEBOUNCE_MS)
}

async function runAccurateWidthRefresh() {
    if (mode !== "normal") return
    if (!beginOracle()) return
    try {
        const nativeCursor = getCursorTop()
        const positionKey = cursorPositionKey(nativeCursor)
        let rect0 = null
        try { rect0 = nativeCursor ? nativeCursor.getBoundingClientRect() : null } catch (err) {}
        const check = pendingSelectionCheck
        if (check === null && positionKey !== null && positionKey === lastEmptyWidthReadKey) return
        const result = await withClipboardSaved(async (previousClipboard) => {
            if (check !== null) {
                pendingSelectionCheck = null
                const selected = await copySelectionForOracle(previousClipboard)
                if (selected === null) {
                    pendingSelectionCheck = check
                    return { failed: true }
                }
                if (selected !== "") return { selection: true }
            }
            return { text: await readCharAfterCore(previousClipboard) }
        })
        if (mode !== "normal") return
        if (result.selection) {
            handleUnexpectedSelection(check)
            return
        }
        if (result.failed || result.text === null || result.text === undefined) return
        if (result.text === "") {
            lastEmptyWidthReadKey = positionKey
            return
        }
        lastEmptyWidthReadKey = null
        const fontInfo = getCursorFontInfo()
        if (!fontInfo || !rect0 || !rect0.height) return
        const width = measureCharWidth(fontInfo, toGraphemes(result.text)[0])
        if (!width) return
        accurateWidth = { left: rect0.left, top: rect0.top, width }
        renderOverlay()
    } finally {
        releaseOracleQuiet()
    }
}

// Frame loop: keep the overlay glued to the native caret, and notice caret
// movement that DocsKeys did not cause. Reads made by the oracle move the
// native caret around temporarily, so position changes are ignored while a
// read is in flight and for a short time after it.
let lastFramePositionKey = null
function overlayFrame() {
    let key = null
    try { key = renderOverlay() } catch (err) {}
    if (mode === "normal" && key !== null && key !== lastFramePositionKey) {
        const settling = oracleBusy || Date.now() < ignorePositionUntil
        lastFramePositionKey = key
        if (!settling) scheduleAccurateWidthRefresh()
    }
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
    return dvorakToQwerty[key] !== undefined ? dvorakToQwerty[key] : key;
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
        scheduleAccurateWidthRefresh()
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
    modeIndicator.textContent = currentMode.toUpperCase()
    switch(currentMode) {
        case 'normal':
            modeIndicator.style.backgroundColor = '#1a73e8'
            modeIndicator.style.color = 'white'
            updateCursorOverlay("block")
            scheduleAccurateWidthRefresh()
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

// --- Visual mode model ------------------------------------------------------
//
// WHY THIS EXISTS (the "v is totally broken" bug). Visual mode used to work
// by moving Docs' selection with shift+arrows and, whenever a motion needed
// to know the text (w/e/b/f/t/^), by *reading* the line through the clipboard
// oracle while the visual selection was live: shift+End (or shift+Home),
// Copy, then retract. Two things were wrong with that, and together they
// made every visual motion other than `l` unreliable:
//   1. Shift+End/Home always extend relative to the *anchor*, so the read
//      only lines up with the cursor if the anchor and the cursor are on the
//      same line AND the selection only ever grew rightwards. After h, j, k
//      (or a leftwards w/b/F/T) neither is true, and the retract step then
//      snapped the selection back to the anchor -- "takes you back to the
//      start".
//   2. The cosmetic box-cursor width refresh ran the same read 150ms after
//      any keystroke, so even a plain `vh` and a short pause got clobbered.
//
// THE FIX. Visual mode never reads the document while a selection is live.
// Instead, when `v` is pressed (while there is NO selection yet) the current
// display line is read once -- text and caret position -- and everything
// after that is pure arithmetic on that snapshot, turned into shift+arrow
// presses. Consequences:
//   * h/l/w/W/e/E/b/B/f/F/t/T/;/,/0/^/_/$/iw/aw/o are exact within the line
//     `v` was pressed on, and instant (no clipboard round-trips).
//   * The selection is INCLUSIVE of the character under the cursor, and the
//     anchor character stays selected when the cursor crosses the anchor
//     (`vh` selects two characters), matching :help visual-use -- "The text
//     from the start of the Visual mode up to and including the character
//     under the cursor is highlighted." Docs' selection is between-character
//     boundaries, so when the cursor passes the anchor the Docs-side anchor
//     boundary has to move by one; visualRealizeDocs() does this with
//     relative key presses only (no absolute positions, no reads).
//   * j/k/{/}/g/G (anything that leaves the line) drop the model: from then
//     on the selection is driven by Docs' native shift+motions, and w/e/b
//     use native word jumps, while f/F/t/T/^ decline. Pressing v again
//     restores the exact behavior. The orientation is normalised right
//     before a native vertical move so the anchor character stays included
//     (see visualNormalizeForNative()).
//
// Model fields (all indices are character indices into `text`, the display
// line Home..End, same "line" as $/0/f/t):
//   a, c   Vim anchor / cursor character indices (selection = min..max, both
//          inclusive)
//   dA, dF where Docs' own anchor / focus boundaries currently are (a
//          boundary i sits BEFORE character i; boundary n is end of line).
//          Forward (c >= a):  dA = a,     dF = c + 1
//          Backward (c < a):  dA = a + 1, dF = c
let visualModel = null

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

// Called right before a NATIVE motion (j/k/{/}/g/G, or a word jump that ran
// off the line) takes over. Puts Docs' selection in the orientation Vim's
// end result will have, so the native motion starts from the right place:
//   forward  (cursor ends up after the anchor):  Docs anchor = a,     focus = c + 1
//   backward (cursor ends up before the anchor): Docs anchor = a + 1, focus = c
// The second one is what keeps the ANCHOR character selected when `vk` moves
// up a line (Vim includes it; a bare shift+Up from the initial state would
// not). Then the model is dropped -- the new line's text is unknown.
function visualNormalizeForNative(forward) {
    const m = visualModel
    if (!m) return
    if (forward) visualRealizeDocs(m.a, m.c + 1)
    else visualRealizeDocs(m.a + 1, m.c)
    visualModel = null
}

// Runs `nativeFn` (a native shift+motion) with the right pre-normalisation.
function visualNativeMotion(forward, nativeFn) {
    visualNormalizeForNative(forward)
    nativeFn()
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
        visualNormalizeForNative(forward)
        if (kind === "e") fallbackWordEnd(true)
        else fallbackWordMotion(forward, true)
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

// --- Visual LINE mode model ---------------------------------------------------
//
// V used to run charwise-native shift+arrows, which is wrong twice over:
//   * h/l/w/b/e/f... extended the selection by individual characters and
//     words, so the highlight was not "only whole lines"; and
//   * V then k did not select the line above: `V` selected [start of line A,
//     start of line A+1] with the Docs anchor at A, so shift+Up walked the
//     focus straight back onto the anchor -- an EMPTY selection, and a
//     following d Backspaced one unrelated character.
//
// Same fix as the charwise model, with lines as the unit. Docs' selection
// always covers WHOLE lines, including the trailing line break of the
// bottom one:
//   forward  (cursor on/below the anchor line):
//                Docs anchor = start of the anchor line,
//                Docs focus  = start of the line after the cursor line
//   backward (cursor above the anchor line):
//                Docs anchor = start of the line after the anchor line,
//                Docs focus  = start of the cursor line
// Moving away from the anchor is one shift+Down/Up per line. Moving back
// towards it, or across it, first collapses the selection and re-anchors on
// the other side (vlPrepFwd/vlPrepBwd), using only relative key presses --
// nothing is read. h/l/w/b/e/W/B/E/f/F/t/T/;/,/0/^/$ do nothing in V, as the
// cursor's column is invisible in a linewise selection. `visualLineRows` is
// the number of lines currently selected (null = unknown, after G/g/{/}).
// "Line" here means a Docs display line, the same as $/0/D/C everywhere else.
let visualLineOrient = "fwd"   // "fwd" | "bwd"
let visualLineRows = 1

function switchModeToVisualLine() {
    mode = 'visualLine'
    visualModel = null
    visualLineOrient = "fwd"
    visualLineRows = 1
    updateModeIndicator(mode)
    sendKeyEvent('home')
    sendKeyEvent('down', { shift: true })
}

// Forward selection -> backward one anchored after the anchor line. Ends with
// an empty selection whose caret is at that anchor boundary. (Left collapses
// to the selection's start = start of the anchor line; Down = start of the
// next line, or the document end for the last line.)
function vlPrepBwd() {
    sendKeyEvent("left")
    sendKeyEvent("down")
}

// Backward selection -> forward one anchored at the start of the anchor line.
// Right collapses to the selection's end (the boundary after the anchor line);
// Left steps back into the anchor line; Home goes to its start. Ends with an
// empty selection whose caret is at the start of the anchor line.
function vlPrepFwd() {
    sendKeyEvent("right")
    sendKeyEvent("left")
    sendKeyEvent("home")
}

function vlMoveVertical(delta) {
    const down = delta > 0
    const steps = Math.abs(delta)
    const key = down ? "down" : "up"
    const extending = (visualLineOrient === "fwd") === down
    if (extending) {
        repeatMotion(() => sendKeyEvent(key, { shift: true }), steps)
        if (visualLineRows !== null) visualLineRows += steps
        return
    }
    const rows = visualLineRows === null ? Infinity : visualLineRows
    if (steps < rows) {
        // Shrinking towards the anchor line; the anchor line stays selected.
        repeatMotion(() => sendKeyEvent(key, { shift: true }), steps)
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
    repeatMotion(() => sendKeyEvent(key, { shift: true }), newRows)
    visualLineRows = newRows
}

function vlGoto(toEnd) {
    if (toEnd) {
        if (visualLineOrient === "bwd") { vlPrepFwd(); visualLineOrient = "fwd" }
        goToDocEnd(true)
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
        visualLineRows = null
    } else if (!forward && visualLineOrient === "bwd") {
        goToStartOfPara(true)
        visualLineRows = null
    }
}

function handleKeyEventVisualLineMode(key) {
    switch (key) {
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
}

function switchModeToInsert() {
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
// actually in the document. See readCursorLineContext() below for how that's
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

// Single, unified re-entrancy guard around every use of the clipboard-based
// text oracle (readAfterCursor/readBeforeCursor/readLineContext and anything
// that calls them: f/F/t/T, w/e/b, ^/_, the `v` line snapshot, and the
// cosmetic normal-mode cursor-width refresh).
//
// While the oracle is busy the selection is TEMPORARILY changed, so a real
// keystroke must not act on it. Two things used to go wrong: keys that ran
// anyway (plain h/j/k/l/x/dd aren't guarded) acted on the temporary
// selection -- an `x` there deleted the highlighted rest-of-line -- and keys
// that were guarded were silently dropped. Now every key that arrives while
// the oracle is busy is queued (in order) and replayed as soon as it's
// released; see eventHandler().
let oracleBusy = false
const keyQueue = []
const MAX_QUEUED_KEYS = 64
let drainingKeyQueue = false

function beginOracle() {
    if (oracleBusy) return false
    oracleBusy = true
    return true
}

// Caret movement seen by the frame loop within this long after a read is
// treated as the read's own doing (it moves the native caret temporarily).
let ignorePositionUntil = 0

// Release for the cosmetic width/selection pass: must NOT schedule another
// pass (that would loop).
function releaseOracleQuiet() {
    // Stay "busy" until the background clipboard restore has landed, so keys
    // replayed from the queue (a held Ctrl+V, `p`, `y`) and any command that
    // follows can never see or write the oracle's temporary clipboard text.
    clipboardRestorePending.then(() => {
        oracleBusy = false
        ignorePositionUntil = Date.now() + 150
        drainKeyQueue()
    })
}

function releaseOracle() {
    releaseOracleQuiet()
    // A command that ran while the box was showing has probably moved the
    // caret; refresh the exact width once things are idle.
    if (mode === "normal") scheduleAccurateWidthRefresh()
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

// "a-"z (or 0-9, or -/_) selects that register for the next y/d/c/p.
// An UPPERCASE letter selects the same (lowercased) register in *append*
// mode: the next y/d/c adds to what's already there instead of overwriting.
// "_ is the black-hole register: anything "written" there is discarded, and
// it always reads back empty, same as real Vim.
function waitForRegisterInput(key) {
    if (/^[a-z0-9]$/.test(key)) {
        pendingRegister = key
        pendingRegisterAppend = false
    } else if (/^[A-Z]$/.test(key)) {
        pendingRegister = key.toLowerCase()
        pendingRegisterAppend = true
    } else if (key === "-" || key === "_") {
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

// Everything below this point is the y/d/c <-> clipboard/register wiring.
// The core tension: Google Docs only exposes "what's selected" through its
// own Cut/Copy menu items, which always write to the real OS clipboard --
// there's no clipboard-free way to ask "what text is in this selection".
// So capturing a register's contents always means briefly writing to the
// real clipboard and reading it back. To keep a *plain* y/d/c from
// permanently stepping on whatever the user had copied from somewhere else:
//   - reading the clipboard's *current* contents (to know what to restore)
//     has to happen before our own Copy/Cut call overwrites it, and that
//     read is unavoidably async -- so register-qualified y/d/c/"reg commands
//     carry one small clipboard-read's worth of latency before the actual
//     edit happens. In practice this is a handful of ms, not the ~150-300ms
//     read used for f/t/w/e/b (those wait out Docs' own async clipboard
//     write; this is just reading whatever's already sitting there).
//   - restoring the user's original clipboard afterward doesn't need to
//     block anything, so it (and the register-write itself) happens in the
//     background after the edit and mode switch are already done.
//   - a *plain* y with no register keeps going straight to the OS clipboard
//     exactly as before, with none of the above -- zero added latency.
//   - a plain d/c with no register now defaults to the CUT_REGISTER ("-")
//     instead of the OS clipboard, so frequent deletes stop overwriting
//     whatever the user meant to paste elsewhere; "-p pastes it back, and
//     ""p (the real OS clipboard) is untouched by cuts.
//   - deletion itself always goes through Backspace on the active selection,
//     never Docs' Cut menu item, specifically so a *plain* d/c never has to
//     touch the clipboard system at all when going to the black-hole
//     register, and so the register bookkeeping above is a clean side
//     channel rather than being load-bearing for the deletion itself.
let clipboardGuardQueue = Promise.resolve() // serializes the background register-capture/restore tail so rapid repeats (mashing "add) can't race and clobber each other's saved clipboard snapshot

function queueRegisterCapture(targetReg, append, previousClipboard) {
    clipboardGuardQueue = clipboardGuardQueue.then(async () => {
        const text = await pollClipboardForChange(previousClipboard)
        if (text !== null) {
            writeRegister(targetReg, text, append)
        } else {
            console.warn(`DocsKeys: couldn't capture text into register "${targetReg}"`)
        }
        if (previousClipboard !== null) {
            try {
                await navigator.clipboard.writeText(previousClipboard)
            } catch (err) {
                console.warn("DocsKeys: couldn't restore clipboard", err)
            }
        }
    })
}

async function deleteOrChangeSelection(reg, append, isChange, linewise) {
    const targetReg = (reg === BLACKHOLE_REGISTER) ? null : (reg || CUT_REGISTER)
    let previousClipboard = null
    if (targetReg) {
        try {
            previousClipboard = await readClipboardSettled()
        } catch (err) {
            // Can't save it, so there'll be nothing to restore -- proceed anyway.
        }
        clickMenu(menuItems.copy)
    }
    sendKeyEvent("backspace") // deletes the active selection; see the block comment above for why this is Backspace, not Docs' Cut
    if (linewise) sendKeyEvent("backspace")
    if (isChange) {
        switchModeToInsert()
    } else {
        mode = "normal"
        switchModeToNormal()
    }
    if (targetReg) {
        queueRegisterCapture(targetReg, append, previousClipboard)
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
    if (!reg) {
        await clipboardRestorePending // a pending restore must not overwrite the yank
        clickMenu(menuItems.copy) // straight to the OS clipboard, exactly as before -- no added latency
        collapseCharwiseVisualToStart()
        switchModeToNormal()
        return
    }
    let previousClipboard = null
    try {
        previousClipboard = await readClipboardSettled()
    } catch (err) {
    }
    clickMenu(menuItems.copy)
    collapseCharwiseVisualToStart()
    switchModeToNormal()
    queueRegisterCapture(reg, append, previousClipboard)
}


async function pasteRegister(name) {
    if (!name) {
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


// Wraps an action in a save-clipboard/restore-clipboard pair, the same
// pattern pasteRegister() established. Used by every oracle read. `fn`
// receives the saved previous clipboard value.
//
// The restore write is intentionally NOT awaited by the caller: the caller
// only cares about `fn`'s result (the read text) and shouldn't have to wait
// on a second clipboard round-trip just to get it back. It IS awaited by the
// NEXT withClipboardSaved() call (clipboardRestorePending). Without that, two
// reads in quick succession (`v` reads both sides of the caret back to back)
// could read the clipboard's "previous" value before the first read's
// restore had landed, see that read's temporary text instead of the user's
// real clipboard, and later "restore" that -- permanently replacing what the
// user had copied with a fragment of the line.
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

// Copies the current selection and returns its text -- or "" if the
// selection was empty. Must be called inside withClipboardSaved().
//
// Why a sentinel: Docs' Copy does nothing at all when the selection is empty
// (the menu item is disabled), so the clipboard never changes, and the old
// "poll until it differs from the previous clipboard" fell through to
// "whatever's there now" -- i.e. the user's OLD clipboard contents, which
// callers then treated as the text of the line. At the end of a line (or on
// an empty line) every f/t/w/e/b read therefore "found" unrelated text and
// moved the cursor by garbage step counts. Writing a known sentinel first
// makes "nothing was copied" unambiguous, and also stops a copy whose text
// happens to equal the old clipboard from waiting out the full timeout.
// Assumption (unverified against a live page): if Docs hasn't replaced the
// sentinel within maxWaitMs, the selection was empty.
const ORACLE_SENTINEL = `\u200b\u200bdocskeys-oracle-${Math.random().toString(36).slice(2)}\u200b\u200b`
// The wait for "Docs hasn't replaced the sentinel, so the selection was
// empty" adapts to how long real copies have been taking (3x the smoothed
// latency + 40ms, never below 90ms or above maxWaitMs). An empty read at the
// end of a line used to stall for the full 250ms every time, which was most
// of the lag when a word motion crossed a line.
let copyLatencyMs = null
async function copySelectionForOracle(previousClipboard, maxWaitMs = 250) {
    if (previousClipboard === null) {
        // Couldn't read the user's clipboard, so writing a sentinel would
        // leave it stuck on the clipboard afterwards. Old behavior instead.
        clickMenu(menuItems.copy)
        return await pollClipboardForChange(null, maxWaitMs)
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

// Reads the text from the cursor to the end of the current wrapped display
// line (same "line" $/0/D/C already use), via a temporary selection + Copy +
// clipboard read. Returns null on any failure. This is a live, on-demand
// read every time -- never a cached snapshot -- so it stays correct even
// while a collaborator is editing elsewhere in the doc.
//
// These cores must only run with NO selection active (normal mode, or `v`
// right before it creates its selection): Shift+End/Shift+Home extend
// relative to the selection's ANCHOR, so with a live selection the copied
// text starts at the anchor rather than at the caret. Visual mode therefore
// never calls them -- see "Visual mode model". Caller holds the oracle
// guard (beginOracle) and the clipboard save (withClipboardSaved).
async function readAfterCore(previousClipboard) {
    const t0 = DEBUG_TIMING ? performance.now() : 0
    try {
        sendKeyEvent("end", { shift: true })
        const t1 = DEBUG_TIMING ? performance.now() : 0
        const after = await copySelectionForOracle(previousClipboard)
        const t2 = DEBUG_TIMING ? performance.now() : 0
        if (after === null) {
            // The temporary selection is still there and we don't know how
            // far it reaches; flag it so the next idle pass collapses it.
            noteSelectionGlitch()
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
    try {
        sendKeyEvent("home", { shift: true })
        const t1 = DEBUG_TIMING ? performance.now() : 0
        const before = await copySelectionForOracle(previousClipboard)
        const t2 = DEBUG_TIMING ? performance.now() : 0
        if (before === null) {
            noteSelectionGlitch()
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

// Reads just the character under the caret (shift+Right, Copy, collapse).
// Used by the box-cursor width refresh: selecting one character instead of
// the rest of the line is what keeps that refresh quick. At the end of a
// paragraph the "character" is the line break itself.
async function readCharAfterCore(previousClipboard) {
    try {
        sendKeyEvent("right", { shift: true })
        const text = await copySelectionForOracle(previousClipboard, 150)
        if (text === null) {
            noteSelectionGlitch()
            return null
        }
        if (text.length > 0) sendKeyEvent("left")
        return text
    } catch (err) {
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
        console.warn(`DocsKeys: ${type}${char} isn't available in this visual selection (visual line mode, or the selection has moved off the line) -- press v again to reset`)
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

// Entry point from eventHandler. IMPORTANT: this must be called with the raw,
// untranslated e.key, not the Dvorak-remapped `key` variable used for command
// letters elsewhere in this file. DVORAK_MODE's translateKey() exists to turn
// a physically-Dvorak-typed key back into its QWERTY *command* label (so 'd'
// means delete regardless of layout) -- but f/F/t/T's argument isn't a
// command, it's a literal character to search for in the document, and
// e.key already reflects the correct on-screen character under the active
// OS keyboard layout. Translating it would search for the wrong character.
// (This mirrors how the existing 'r' replace-character command sidesteps the
// same issue, by not consuming the translated `key` for its actual character
// either -- see the `mode == 'replaceChar'` branch in eventHandler.)
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
        console.warn("DocsKeys: ^/_ isn't available in this visual selection (visual line mode, or the selection has moved off the line) -- press v again to reset")
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

// --- word / WORD motions (w, e, b, and true W, E, B) ---
//
// The previous implementation approximated `e` by nudging the cursor a fixed
// 2 characters before a native Ctrl+Right word-jump, to dodge Ctrl+Right's
// "always lands on the start of the next word" behavior when `e` needed to
// land on a word's own end. That fixed nudge assumed the cursor was always
// exactly at a previous end-of-word position (the repeated-press case,
// `ee`/`2e`); on a *fresh* press from elsewhere in a word (e.g. from a
// word's start), the same nudge overshot backward past the real end --
// which is exactly what landing "between o and n" in "discussions" was.
//
// Now that DocsKeys can read line text (see f/F/t/T above), w/e/b/W/E/B are
// computed exactly against Vim's actual word/WORD definitions instead of
// guessed from Ctrl+Right/Ctrl+Left's behavior. This only knows about the
// current wrapped display line, though (same scope as f/t) -- so if a
// motion would need to continue onto the next line, these fall back to the
// old native-keystroke behavior for that one press, which handles crossing
// lines correctly (if not always with exact Vim word semantics right at the
// boundary). See MISSING_VIM_FEATURES.md for exactly what that fallback
// does and doesn't get right.

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
    sendKeyEvent(shift ? "right" : "right", { shift })
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

function fallbackToNativeWordMotion(kind, forward, operator, returnMode) {
    const shift = !!operator || returnMode === "visual" || returnMode === "visualLine"
    if (kind === "e") {
        fallbackWordEnd(shift)
    } else {
        fallbackWordMotion(forward, shift)
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
        fallbackToNativeWordMotion(kind, forward, operator, returnMode)
        return
    }

    applyMotionSteps(forward, inclusive, steps, operator, returnMode)
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
            return deleteOrChangeSelection(reg, append, true, linewise)
        case "d":
            return deleteOrChangeSelection(reg, append, false, linewise)
        case "y":
            return yankSelection(reg, append)
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


// --- operator + text object: diw daw diW daW ciw yiw ... ---------------------
//
// The old implementation was "b, then dw", which is only right from the LAST
// character of a word: from the first character `b` jumps to the PREVIOUS
// word, so `diw` there deleted the previous word (and its spaces), and it
// mishandled punctuation and white space; `aw` was identical to `iw`. It now
// reads the line once and reuses textObjectRange() -- the same exact Vim
// rules charwise Visual mode uses (:help iw, aw):
//   iw  the run of same-class characters under the cursor (word chars,
//       punctuation, or white space each count as one "word")
//   aw  that plus trailing white space, or leading white space if there is
//       no trailing white space; on white space, the white space plus the
//       word after it
// A count extends the object by the following objects, as repeating iw/aw in
// Visual mode does. The caret is then walked to the start of the object with
// plain arrows (no selection exists yet) and the object is selected with
// shift+Right, so nothing depends on where a read leaves the selection.
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
    if (/[1-9]/.test(key) || (operatorCount > 0 && key === "0")) {
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
                console.warn("DocsKeys: iw/aw aren't available in this visual selection (visual line mode, or the selection has moved off the line) -- press v again to reset")
            }
            updateModeIndicator(mode)
            break
        case "p":
            visualModel = null
            goToStartOfPara()
            goToEndOfPara(true)
            mode = "visualLine"
            visualLineOrient = "fwd"
            visualLineRows = null
            updateModeIndicator(mode)
            break
        default:
            mode = returnMode
            updateModeIndicator(mode)
            break
    }
}

function handleMultipleMotion(key) {
    if (/[0-9]/.test(key)) {
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

    if (targetMode === "normal" && (key === "D" || key === "C" || key === "Y")) {
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
    if (
        ["Shift","Meta","Control","Alt",""].includes(e.key)
    ) return

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
    if (e.altKey || e.ctrlKey || e.metaKey) {
        handleModifiedKey(e)
        return;
    }

    // A document read is in flight and the selection is temporarily changed:
    // hold this key and replay it (in order) once the read finishes. Insert
    // mode is never queued -- typing goes straight to Docs.
    if (oracleBusy && mode != 'insert') {
        e.preventDefault()
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
    const key = translateKey(e.key)

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
    if (/[1-9]/.test(key)) {
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
            sendKeyEvent("down")
            break
        case "k":
            sendKeyEvent("up")
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
              selectLinesDown(lcount - 1)
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
            { const fn = () => { sendKeyEvent("delete") }
              fn(); recordChange(fn) }
            break
				case "s":
            { const fn = () => { sendKeyEvent("delete"); switchModeToInsert() }
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
        default:
            return;
    }
    if (tempnormal) {
        if (mode != 'visual' && mode != 'visualLine' && mode != 'replaceChar' && mode != 'waitForFindChar') {
            tempnormal = false
            switchModeToInsert()
        }
    }
    refreshCursorOverlayForCurrentMode()
}

function handleKeyEventVisualLine(key) {
    if (/[1-9]/.test(key)) {
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
        case "":
            break
        case "h":
            if (model) visualMoveCursor(model.c - 1)
            else sendKeyEvent("left", { shift: true })
            break
        case "l":
            if (model) visualMoveCursor(model.c + 1)
            else sendKeyEvent("right", { shift: true })
            break
        case "j":
            visualNativeMotion(true, () => sendKeyEvent("down", { shift: true }))
            break
        case "k":
            visualNativeMotion(false, () => sendKeyEvent("up", { shift: true }))
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
                console.warn("DocsKeys: ^/_ isn't available in this visual selection (visual line mode, or the selection has moved off the line) -- press v again to reset")
            }
            break
        case "0":
            if (model) visualMoveCursor(0)
            else selectToStartOfLine()
            break
        case "$":
            // Real Vim's `$` in Visual mode also selects the line break; this
            // stops at the last character (Docs' shift+End) -- documented
            // deviation, safer than accidentally joining lines.
            if (model) visualMoveCursor(model.text.length - 1)
            else selectToEndOfLine()
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
        mouseDownPos = { x: e.clientX, y: e.clientY }
        if (mode === "visual" || mode === "visualLine") {
            visualModel = null
            visualLineRows = null
        }
    }, true)
    document.addEventListener("mouseup", (e) => {
        const moved = mouseDownPos && Math.hypot(e.clientX - mouseDownPos.x, e.clientY - mouseDownPos.y) > 3
        mouseDownPos = null
        if (mode === "insert") return
        if (moved || e.shiftKey || e.detail >= 2) markSelectionCheck("user")
    }, true)
}

startOverlayFrameLoop()
