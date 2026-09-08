// Set to true and reload the extension to log how long each phase of a
// text-oracle read (f/F/t/T/w/e/b) actually takes, in the DevTools console.
// Useful for finding out where remaining latency is actually going, instead
// of guessing -- e.g. whether it's the clipboard round-trip itself, or
// something else like Docs' own Copy-click handler being slow on a large
// document.
const DEBUG_TIMING = false

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
        // `display` between "none"/"inline" for the blink) -- likely the
        // real fix for the box cursor showing up as a "tail" near, but not
        // exactly at, kix-cursor-top's position. Falls back to
        // kix-cursor-top (what this used before) in case the class name
        // varies by Docs version/rollout -- unverified against a live page,
        // same as everything else about Docs' internal structure in this
        // file.
        cursorTop = document.getElementsByClassName("kix-cursor-caret")[0]
            || document.getElementsByClassName("kix-cursor-top")[0]
            || null
    }
    return cursorTop
}

// Box cursor: an independent overlay element, positioned/sized to match
// kix-cursor-top's location, rather than resizing kix-cursor-top itself.
//
// This replaces an earlier version that set `width` directly on
// kix-cursor-top, which showed up as a "tail" behind the real cursor
// instead of a proper block -- most likely because Docs sizes/positions
// that element with its own CSS (possibly a transform, going by this
// project's history with a previous, separately-reverted cursor-styling
// attempt that used `transform: scaleY`), and stacking our own `width`
// change on top of whatever that is doesn't compose the way a plain CSS
// property normally would. Rather than guess again at exactly what Docs
// does internally -- risking actually breaking the native cursor's
// *position*, not just its cosmetic size, if a blind fix happens to clear
// or fight a transform Docs relies on -- this sidesteps the question
// entirely: kix-cursor-top's own style is never modified, only *read*
// (its position and height, via getBoundingClientRect()), and a completely
// separate `position: fixed` div is drawn on top of it at that location.
// Nothing about Docs' own cursor element or its behavior is touched.
let cursorBoxOverlay = null
function getCursorBoxOverlay() {
    if (!cursorBoxOverlay || !cursorBoxOverlay.isConnected) {
        cursorBoxOverlay = document.createElement("div")
        cursorBoxOverlay.style.position = "fixed"
        cursorBoxOverlay.style.pointerEvents = "none"
        cursorBoxOverlay.style.backgroundColor = "black"
        cursorBoxOverlay.style.zIndex = "9998"
        cursorBoxOverlay.style.display = "none"
        document.body.appendChild(cursorBoxOverlay)
    }
    return cursorBoxOverlay
}

// Font info comes from the docs-texteventtarget-iframe's contenteditable
// element -- the same hidden keystroke-capture target page_script.js
// already reads from -- which was confirmed to carry live font-family/
// font-size/font-weight in its inline style.
//
// Two-tier sizing, because measuring the *actual* character under the
// cursor needs an oracle read (Copy + clipboard round-trip), and doing that
// on every single cursor-moving keystroke would reintroduce exactly the
// per-keystroke latency the last two passes removed, and would also flash
// the selection highlight on plain h/l/j/k presses that currently never
// touch the clipboard at all:
//   1. updateCursorBoxWidth() -- instant, synchronous, no oracle read.
//      Measures a stand-in character ("0") so there's *something*
//      reasonably sized immediately, called right when normal/visual mode
//      is (re-)entered.
//   2. scheduleBoxWidthRefresh() -- debounced (waits for a short pause in
//      keystrokes), reads the actual character under the cursor via the
//      oracle, and re-measures using that specific character instead of the
//      "0" stand-in. Called after every normal/visual-mode keystroke, but
//      the debounce means it only actually runs once you pause, not on
//      every single press -- so navigation stays instant and the highlight
//      doesn't flash while actively moving, and the box corrects to the
//      exact width shortly after you stop.
let measureCanvas = null
function getCursorFontInfo() {
    try {
        const iframe = document.querySelector(".docs-texteventtarget-iframe")
        const doc = iframe && iframe.contentDocument
        const el = doc && (doc.activeElement || doc.querySelector('[contenteditable="true"]'))
        if (!el) return null
        const cs = el.ownerDocument.defaultView.getComputedStyle(el)
        if (!cs.fontSize || !cs.fontFamily) return null
        return { fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight || "400" }
    } catch (err) {
        return null
    }
}

function measureCharWidth(fontInfo, char = "0") {
    try {
        if (!measureCanvas) measureCanvas = document.createElement("canvas")
        const ctx = measureCanvas.getContext("2d")
        ctx.font = `${fontInfo.fontWeight} ${fontInfo.fontSize} ${fontInfo.fontFamily}`
        // A newline/empty line has no character to measure -- fall back to
        // the stand-in width rather than a zero-width box.
        const target = (char && char !== "\n" && char !== "\r") ? char : "0"
        const width = ctx.measureText(target).width
        return width > 0 ? width : null
    } catch (err) {
        return null
    }
}

// Positions the overlay at kix-cursor-top's current location, sized to
// `widthPx` wide and as tall as kix-cursor-top itself already is (i.e.
// still not guessing at line-height -- just reading it, same as before).
function positionCursorBoxOverlay(widthPx) {
    const nativeCursor = getCursorTop()
    if (!nativeCursor || !widthPx) return false
    try {
        const rect = nativeCursor.getBoundingClientRect()
        if (!rect.height) return false
        const overlay = getCursorBoxOverlay()
        overlay.style.left = `${rect.left}px`
        overlay.style.top = `${rect.top}px`
        overlay.style.width = `${widthPx}px`
        overlay.style.height = `${rect.height}px`
        return true
    } catch (err) {
        return false
    }
}

function showCursorBoxOverlay() {
    const overlay = getCursorBoxOverlay()
    overlay.style.display = "block"
}

function hideCursorBoxOverlay() {
    if (cursorBoxOverlay) cursorBoxOverlay.style.display = "none"
}

// Called whenever normal/visual mode is (re-)entered. Best-effort and fully
// defensive: if the iframe/font/cursor lookup ever fails (e.g. Docs changes
// its internal structure, or hasn't created its cursor element yet -- see
// the waitForElement() call near the bottom of this file for page-load
// timing), this just leaves the overlay hidden rather than throwing or
// breaking anything else.
function updateCursorBoxWidth() {
    const fontInfo = getCursorFontInfo()
    if (!fontInfo) return
    const width = measureCharWidth(fontInfo)
    if (positionCursorBoxOverlay(width)) showCursorBoxOverlay()
}

const BOX_WIDTH_REFRESH_DEBOUNCE_MS = 150
let boxWidthRefreshTimer = null
function scheduleBoxWidthRefresh() {
    if (mode !== "normal" && mode !== "visual" && mode !== "visualLine") return
    clearTimeout(boxWidthRefreshTimer)
    boxWidthRefreshTimer = setTimeout(async () => {
        // Re-check: mode may have changed, or another oracle read may have
        // started, during the debounce wait.
        if (mode !== "normal" && mode !== "visual" && mode !== "visualLine") return
        if (wordMotionBusy || findBusy) return
        const after = await readAfterCursor()
        if (mode !== "normal" && mode !== "visual" && mode !== "visualLine") return // could have changed while awaiting
        if (after === null || after.length === 0) return
        const fontInfo = getCursorFontInfo()
        if (!fontInfo) return
        const width = measureCharWidth(fontInfo, after[0])
        if (width) positionCursorBoxOverlay(width)
    }, BOX_WIDTH_REFRESH_DEBOUNCE_MS)
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

function updateModeIndicator(currentMode) {
    modeIndicator.textContent = currentMode.toUpperCase()
    switch(currentMode) {
        case 'normal':
            modeIndicator.style.backgroundColor = '#1a73e8'
            modeIndicator.style.color = 'white'
            updateCursorBoxWidth()
            break
        case 'insert':
            modeIndicator.style.backgroundColor = '#34a853'
            modeIndicator.style.color = 'white'
            break
        case 'visual':
        case 'visualLine':
            modeIndicator.style.backgroundColor = '#fbbc04'
            modeIndicator.style.color = 'black'
            updateCursorBoxWidth()
            break
        case 'waitForFirstInput':
        case 'waitForSecondInput':
        case 'waitForVisualInput':
        case 'waitForRegister':
        case 'replaceChar':
            modeIndicator.style.backgroundColor = '#ea4335'
            modeIndicator.style.color = 'white'
            break
    }
}

function repeatMotion(motion, times, key) {
  for (let i = 0; i < times; i++) {
      motion(key)
  }
}

// Signed count of characters currently selected between the visual-mode
// anchor and the current focus/cursor: positive means focus is that many
// characters to the right of the anchor (selection growing forward),
// negative means focus is to the left (growing backward). DocsKeys is the
// only thing that ever extends a visual-mode selection, so it can just keep
// its own running count instead of trying to ask Docs/the browser for it --
// which matters because Shift+End/Shift+Home (used by readAfterCursor()/
// readBeforeCursor() below) always extend relative to the *anchor*, not the
// current focus, so the raw copied text needs this offset sliced off before
// it represents "text relative to where the cursor actually is now". See
// readAfterCursor()'s comment for the rest of the story.
//
// Known gap: this only stays correct while a visual selection keeps growing
// in the same direction. Reversing direction (e.g. "b" enough times to pass
// back through the anchor while extending forward) isn't tracked, and the
// native cross-line fallback in performWordMotionInner() also can't update
// this precisely (it doesn't know how many characters Ctrl+Right/Left
// actually moved). Both are documented in MISSING_VIM_FEATURES.md.
let visualSelectionChars = 0

function switchModeToVisual() {
    mode = 'visual'
    updateModeIndicator(mode)
    sendKeyEvent('right', { shift: true })
    visualSelectionChars = 1
    updateCursorBoxWidth()
}

async function switchModeToVisualLine() {
    mode = 'visualLine'
    updateModeIndicator(mode)
    sendKeyEvent('home')
    sendKeyEvent('down', { shift: true })
    updateCursorBoxWidth()
    // Learn exactly how many characters this initial line-based selection
    // spans, so a later w/e/b/f/t extension in visual-line mode can
    // correctly account for what's already selected. One-time read -- V is
    // a discrete action, not a hot loop, so this doesn't cost anything on
    // the path the latency complaints were actually about.
    const text = await withClipboardSaved(async (previousClipboard) => {
        clickMenu(menuItems.copy)
        return await pollClipboardForChange(previousClipboard)
    })
    visualSelectionChars = (text !== null) ? text.length : 0
}

function switchModeToNormal() {
    if (mode == "visualLine") sendKeyEvent("left")
    mode = 'normal'
    updateModeIndicator(mode)
    visualSelectionChars = 0

    const ct = getCursorTop()
    if (ct) {
        ct.style.opacity = 1
        ct.style.display = "block"
        ct.style.backgroundColor = "black"
    }
    updateCursorBoxWidth()
}

function switchModeToInsert() {
    mode = 'insert'
    updateModeIndicator(mode)
    visualSelectionChars = 0
    hideCursorBoxOverlay()
    const ct = getCursorTop()
    if (ct) ct.style.opacity = 0
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
let findBusy = false             // re-entrancy guard around the async clipboard read

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
            previousClipboard = await navigator.clipboard.readText()
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

async function yankSelection(reg, append) {
    if (!reg) {
        clickMenu(menuItems.copy) // straight to the OS clipboard, exactly as before -- no added latency
        switchModeToNormal()
        return
    }
    let previousClipboard = null
    try {
        previousClipboard = await navigator.clipboard.readText()
    } catch (err) {
    }
    clickMenu(menuItems.copy)
    switchModeToNormal()
    queueRegisterCapture(reg, append, previousClipboard)
}


async function pasteRegister(name) {
    if (!name) {
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
        previousClipboard = await navigator.clipboard.readText()
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
// pattern pasteRegister() established. Used by every oracle read and by the
// register-capture functions below. `fn` receives the saved previous
// clipboard value so callers can also use it to detect when their own
// Copy/Cut has actually landed (see pollClipboardForChange below), instead
// of re-reading the clipboard a second time just to get the same value.
//
// The restore write is intentionally NOT awaited: the caller only cares
// about `fn`'s result (the read text) and shouldn't have to wait on a
// second clipboard round-trip just to get it back. The restore still
// happens, just in the background. Tradeoff: if another oracle read fires
// fast enough to read the clipboard's "previous" value before this one's
// background restore has landed, it could see this call's temporary copied
// text instead of the true original, and end up restoring that instead a
// moment later. Rare in practice (would need two reads within single-digit
// milliseconds of each other) and self-correcting-ish (the next read after
// that would just treat this pass's contents as its own baseline), but
// worth knowing about -- the alternative (fully serializing every oracle
// read so this can never happen) reintroduces exactly the latency this is
// trying to remove, so speed was prioritized here.
async function withClipboardSaved(fn) {
    let previousClipboard = null
    try {
        previousClipboard = await navigator.clipboard.readText()
    } catch (err) {
        // Best-effort: if we can't read/save the existing clipboard we can't
        // restore it later, but we can still run the action itself.
    }
    try {
        return await fn(previousClipboard)
    } finally {
        if (previousClipboard !== null) {
            navigator.clipboard.writeText(previousClipboard).catch((err) => {
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
async function pollClipboardForChange(previousText, maxWaitMs = 250, intervalMs = 8) {
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

// Reads the text from the cursor to the end of the current wrapped display
// line (same "line" $/0/D/C already use), via a temporary selection + Copy +
// clipboard read. Returns null on any failure. This is a live, on-demand
// read every time -- never a cached snapshot -- so it stays correct even
// while a collaborator is editing elsewhere in the doc.
//
// Split into single-direction reads (this, and readBeforeCursor() below)
// rather than one function that always reads both: every current caller
// (f/t, w/e, F/T, b) only ever needs one side, so this roughly halves the
// number of clipboard round-trips compared to always reading both.
//
// Two things make this correct during an active visual-mode selection,
// where a plain shift+End can't just be read at face value:
//
// 1. Shift+End extends the *focus* while leaving the *anchor* (where v/V
//    was pressed) fixed, so the raw copied text starts at the anchor, not
//    at wherever the cursor currently is. Sliced off below using
//    `visualSelectionChars` (see its comment above), so what this function
//    returns always represents "from the actual cursor forward".
// 2. The temporary extension is undone with shift+Left -- never a plain
//    (non-shift) Left, which would collapse to an edge and drop the anchor
//    entirely -- but critically, only for exactly as many characters as
//    this function's *own* extension added (`after.length`, i.e. after
//    slicing), not the full raw text's length. Retracting the full raw
//    length would also retract back through whatever was already selected
//    before this call started, overshooting all the way back to the
//    anchor every time instead of back to where the cursor actually was.
async function readAfterCursor() {
    const t0 = DEBUG_TIMING ? performance.now() : 0
    return withClipboardSaved(async (previousClipboard) => {
        try {
            const t1 = DEBUG_TIMING ? performance.now() : 0
            sendKeyEvent("end", { shift: true })
            clickMenu(menuItems.copy)
            const t2 = DEBUG_TIMING ? performance.now() : 0
            const raw = await pollClipboardForChange(previousClipboard)
            const t3 = DEBUG_TIMING ? performance.now() : 0
            if (raw === null) return null
            const alreadySelected = ((mode === "visual" || mode === "visualLine") && visualSelectionChars > 0)
                ? Math.min(visualSelectionChars, raw.length)
                : 0
            const after = raw.slice(alreadySelected)
            // Retract only the NEW extension this shift+End just made
            // (after.length), NOT the full raw.length. raw also includes
            // whatever was already selected before this read started; in
            // visual mode, retracting that much too overshoots all the way
            // back to the anchor instead of back to where the cursor
            // actually was -- which is what caused w/e/b/f/t/;/, to appear
            // to jump around randomly instead of advancing normally
            // (verified with a standalone simulation before this fix: the
            // buggy version's tracked position and the real selection
            // length diverge from the very first press; this version keeps
            // them in exact lockstep across repeated presses). In normal
            // mode alreadySelected is 0, so after.length === raw.length and
            // this is unchanged from before.
            repeatMotion(() => sendKeyEvent("left", { shift: true }), after.length)
            if (DEBUG_TIMING) {
                const t4 = performance.now()
                console.log(`DocsKeys timing: save-clipboard=${(t1 - t0).toFixed(1)}ms select+click=${(t2 - t1).toFixed(1)}ms poll-for-copy=${(t3 - t2).toFixed(1)}ms retract=${(t4 - t3).toFixed(1)}ms TOTAL=${(t4 - t0).toFixed(1)}ms`)
            }
            return after
        } catch (err) {
            console.warn("DocsKeys: couldn't read text after cursor (best-effort feature; falling back to no-op)", err)
            return null
        }
    })
}

// Same as readAfterCursor(), but for the text from the start of the line to
// the cursor. See readAfterCursor()'s comment for why the retraction uses
// shift+Right `before.length` times (not the full raw length) and why the
// already-selected portion needs to be sliced off in visual mode.
async function readBeforeCursor() {
    const t0 = DEBUG_TIMING ? performance.now() : 0
    return withClipboardSaved(async (previousClipboard) => {
        try {
            const t1 = DEBUG_TIMING ? performance.now() : 0
            sendKeyEvent("home", { shift: true })
            clickMenu(menuItems.copy)
            const t2 = DEBUG_TIMING ? performance.now() : 0
            const raw = await pollClipboardForChange(previousClipboard)
            const t3 = DEBUG_TIMING ? performance.now() : 0
            if (raw === null) return null
            const alreadySelected = ((mode === "visual" || mode === "visualLine") && visualSelectionChars < 0)
                ? Math.min(-visualSelectionChars, raw.length)
                : 0
            const before = raw.slice(0, raw.length - alreadySelected)
            repeatMotion(() => sendKeyEvent("right", { shift: true }), before.length)
            if (DEBUG_TIMING) {
                const t4 = performance.now()
                console.log(`DocsKeys timing: save-clipboard=${(t1 - t0).toFixed(1)}ms select+click=${(t2 - t1).toFixed(1)}ms poll-for-copy=${(t3 - t2).toFixed(1)}ms retract=${(t4 - t3).toFixed(1)}ms TOTAL=${(t4 - t0).toFixed(1)}ms`)
            }
            return before
        } catch (err) {
            console.warn("DocsKeys: couldn't read text before cursor (best-effort feature; falling back to no-op)", err)
            return null
        }
    })
}

// `after` is the text from the cursor to end-of-line, so after[0] is the
// character currently under the cursor. Real f/t search *starts* at the next
// character, matching Vim's ":help f": "the count'th occurrence of {char} to
// the right", not counting the character the cursor is already on.
function findForward(text, char, count) {
    let idx = 0
    for (let n = 0; n < count; n++) {
        idx = text.indexOf(char, idx + 1)
        if (idx === -1) return { found: false }
    }
    return { found: true, matchIndex: idx } // matchIndex = steps to land ON char (plain f)
}

// `before` is the text from start-of-line to the cursor (not including the
// cursor's own character), so before[before.length-1] is the character
// immediately to the left of the cursor -- distance 1 for F/T's search.
function findBackward(text, char, count) {
    let idx = text.length
    for (let n = 0; n < count; n++) {
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
        repeatMotion(() => sendKeyEvent(dirKey, { shift: true }), steps)
        visualSelectionChars += forward ? steps : -steps
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

async function performFind(type, char, count, operator, returnMode) {
    const forward = (type === "f" || type === "t")
    const text = forward ? await readAfterCursor() : await readBeforeCursor()
    if (text === null) {
        finishFind(returnMode)
        return
    }
    const isTill = (type === "t" || type === "T")
    const result = forward
        ? findForward(text, char, count)
        : findBackward(text, char, count)

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
    if (findBusy) return
    if (rawKey.length !== 1) {
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

    findBusy = true
    performFind(type, rawKey, count, operator, returnMode).finally(() => {
        findBusy = false
    })
}

function repeatLastFind(reverse, operator = null, returnMode = "normal") {
    if (!lastFind) return
    let { type, char } = lastFind
    if (reverse) {
        type = { f: "F", F: "f", t: "T", T: "t" }[type]
    }
    performFind(type, char, 1, operator, returnMode)
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
    const before = await readBeforeCursor()
    const after = await readAfterCursor()
    if (before === null || after === null) {
        finishFind(returnMode)
        return
    }
    const full = before + after
    const match = full.search(/\S/)
    const firstNonBlank = (match === -1) ? 0 : match // an all-blank line: approximate as column 0 rather than real Vim's "last character" -- documented gap
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

function classifyWordChar(ch) {
    if (/\s/.test(ch)) return "blank"
    if (/[A-Za-z0-9_]/.test(ch)) return "keyword"
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
let wordMotionBusy = false
let pendingWordCount = 1
let pendingLineCount = 1

async function performWordMotion(kind, classify, count, operator, returnMode) {
    if (wordMotionBusy) return
    wordMotionBusy = true
    try {
        await performWordMotionInner(kind, classify, count, operator, returnMode)
    } finally {
        wordMotionBusy = false
    }
}

async function performWordMotionInner(kind, classify, count, operator, returnMode) {
    const forward = (kind === "e" || kind === "w")
    const inclusive = (kind === "e")
    const text = forward ? await readAfterCursor() : await readBeforeCursor()

    if (text === null) {
        finishFind(returnMode) // oracle read failed -- bail out to normal, same as f/t
        return
    }

    const finder = kind === "e" ? findWordEnd
        : kind === "w" ? findWordStart
        : findWordStartBackward // "b"
    const steps = countedWordSteps(text, classify, count, finder, !forward)

    if (steps === -1) {
        // Ran off the end of the current line -- fall back to the native
        // motion for this one press rather than silently doing nothing.
        const shift = !!operator || returnMode === "visual" || returnMode === "visualLine"
        if (kind === "e") {
            fallbackWordEnd(shift)
        } else {
            fallbackWordMotion(forward, shift)
        }
        if (operator) {
            runLongStringOp(operator, false)
        } else if (returnMode === "visual" || returnMode === "visualLine") {
            // Can't know exactly how far the native Ctrl+Right/Left jump
            // moved, so the running offset can't be updated precisely here.
            // Reset it rather than carry forward a count we know is wrong.
            visualSelectionChars = 0
            mode = returnMode
            updateModeIndicator(mode)
        } else {
            switchModeToNormal()
        }
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
            deleteOrChangeSelection(reg, append, true, linewise)
            break
        case "d":
            deleteOrChangeSelection(reg, append, false, linewise)
            break
        case "y":
            yankSelection(reg, append)
            break
        case "p":
            pasteRegister(reg)
            switchModeToNormal()
            break
        case "v":
            break
        case "g":
            goToTop()
            break
    }
}


async function waitForSecondInput(key) {
    switch (key) {
        case "w":
            await performWordMotion("b", classifyWordChar, 1, null, "normal")
            waitForFirstInput(key)
            break
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

async function waitForVisualInput(key) {
    switch (key) {
        case "w":
            sendKeyEvent("left", { control: true })
            await performWordMotion("b", classifyWordChar, 1, null, "normal")
            await performWordMotion("w", classifyWordChar, 1, null, "visual")
            break
        case "p":
            goToStartOfPara()
            goToEndOfPara(true)
            break
    }
    mode = "visualLine"
}

function handleMultipleMotion(key) {
    if (/[0-9]/.test(key)) {
        multipleMotion.times = Number(String(multipleMotion.times)+key)
        return
    }

    const times = multipleMotion.times || 1
    const targetMode = multipleMotion.mode

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
        clickMenu(menuItems.redo)
        return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key == 'Escape') {
        e.preventDefault()
        if (mode == 'visualLine' || mode == 'visual') {
            sendKeyEvent("right")
        }
        switchModeToNormal()
        return;
    }
    if (mode == 'replaceChar') {
        if (key.length === 1) {
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
    scheduleBoxWidthRefresh()
}

function handleKeyEventVisualLine(key) {
    if (/[1-9]/.test(key)) {
        mode = "multipleMotion"
        multipleMotion.mode = "visualLine"
        multipleMotion.times = Number(key)
        return
    }

    switch (key) {
        case "":
            break
        case "h":
            sendKeyEvent("left", { shift: true })
            visualSelectionChars -= 1
            break
        case "j":
            sendKeyEvent("down", { shift: true })
            visualSelectionChars = 0 // unknown delta (depends on line length) -- see comment on visualSelectionChars
            break
        case "k":
            sendKeyEvent("up", { shift: true })
            visualSelectionChars = 0
            break
        case "l":
            sendKeyEvent("right", { shift: true })
            visualSelectionChars += 1
            break
        case "\"":
            switchModeToWaitForRegister()
            break
        case "p":
            { const reg = pendingRegister
              pendingRegister = null
              pasteRegister(reg) }
            switchModeToNormal()
            break
        case "}":
            goToEndOfPara(true)
            visualSelectionChars = 0
            break
        case "{":
            goToStartOfPara(true)
            visualSelectionChars = 0
            break
        case "b":
        case "B":
            performWordMotion("b", key === "B" ? classifyWORDChar : classifyWordChar, 1, null, mode)
            break
        case "e":
        case "E":
            performWordMotion("e", key === "E" ? classifyWORDChar : classifyWordChar, 1, null, mode)
            break
        case "w":
        case "W":
            performWordMotion("w", key === "W" ? classifyWORDChar : classifyWordChar, 1, null, mode)
            break
        case "^":
        case "_":
            goToFirstNonBlank(null, mode)
            break
        case "0":
            selectToStartOfLine()
            visualSelectionChars = 0
            break
        case "$":
            selectToEndOfLine()
            visualSelectionChars = 0
            break
        case "G":
            goToDocEnd(true)
            visualSelectionChars = 0
            break
        case "g":
            goToDocStart(true)
            visualSelectionChars = 0
            break
        case "c":
        case "d":
        case "y":
            runLongStringOp(key)
            break
        case "i":
        case "a":
            mode = "waitForVisualInput"
            break
        case "f":
        case "F":
        case "t":
        case "T":
            // Counted f/t in visual mode (e.g. "3fx") isn't supported: a
            // count here would need to repeat this whole wait-for-a-char
            // flow, which handleMultipleMotion doesn't have a way to do
            // for a command with its own pending input. See
            // MISSING_VIM_FEATURES.md.
            pendingFindType = key
            pendingFindOperator = null
            pendingFindCount = 1
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
    scheduleBoxWidthRefresh()
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
    () => { if (mode === "normal") updateCursorBoxWidth() },
)