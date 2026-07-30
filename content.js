// Google Docs has /// Google Docs has moved from using editable HTML elements (textbox with contenteditable=true)
// to custom implementation with its own editing surface since 2015. (https://drive.googleblog.com/2010/05/whats-different-about-new-google-docs.html)
// This means that each keystroke is captured and then fed into layout engine which 
// then draws the text, cursor, selection, headings etc on seperate iframe.
// Such implementation deters any extensibility in terms of text manipulation because 
// there is no API to interact with Google Docs layout engine

// Thus only way (in my understanding) to achieve vim motions would be to capture keystrokes
// before sending to layout engine and interpret them into respective vim motion/command.
// Then implement those motions by sending relevant keystrokes. Essentially doing a keystroke to keystroke remapping. 

const iframe = document.getElementsByTagName('iframe')[0]   // https://stackoverflow.com/a/4388829
iframe.contentDocument.addEventListener('keydown', eventHandler, true)

const cursorTop = document.getElementsByClassName("kix-cursor-top")[0] // element to edit to show normal vs insert mode
let mode = 'normal'
let tempnormal = false // State variable for indicating temperory normal mode
let multipleMotion = {
    times:0,
    mode:"normal"
}

// How to simulate a keypress in Chrome: http://stackoverflow.com/a/10520017/46237
// Note that we have to do this keypress simulation in an injected script, because events dispatched
// by content scripts do not preserve overridden properties.
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

// --- Programmer Dvorak support ---------------------------------------------
// DocsKeys reads e.key, which already reflects whatever OS keyboard layout is
// active. If that layout is Programmer Dvorak, e.key for the physical h/j/k/l
// (etc.) keys will report Dvorak's characters, not "h"/"j"/"k"/"l", so none of
// the switch-case commands below would ever match.
//
// To fix this we translate e.key back to the QWERTY letter that lives at that
// same physical key position before it's used as a command, mirroring the
// `langmap` trick used for Neovim. The tables below are a direct port of the
// unshifted/shifted tables in the init.lua langmap config (label = QWERTY key,
// value = character Programmer Dvorak produces at that physical key).
//
// Set DVORAK_MODE to false to disable this and use raw QWERTY-style DocsKeys.
const DVORAK_MODE = true;

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

// Reverse map: character Dvorak actually produces -> QWERTY label DocsKeys expects.
// Programmer Dvorak puts symbols on the unshifted number row and digits on the
// shifted number row, so this table also takes care of digits: pressing the
// physical, unshifted "1" key produces "&" under Dvorak, and that reverse-maps
// back to "1" here -- which is exactly what's needed for DocsKeys' repeat counts.
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

// Translates a single key character produced under Programmer Dvorak back into
// the QWERTY letter that occupies the same physical key. Multi-char key names
// (e.g. "Escape", "Shift") and untranslated characters pass through unchanged.
function translateKey(key) {
    if (!DVORAK_MODE || key.length !== 1) return key;
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

// Send request to injected page script to simulate keypress
// Messages are passed to page script via "doc-keys-simulate-keypress" events, which are dispatched
// on the window object by the content script.
function sendKeyEvent(key, mods = {}) {
    const keyCode = keyCodes[key]
    const defaultMods = { shift: false, control: false, alt: false, meta: false }
    window.dispatchEvent(new CustomEvent("doc-keys-simulate-keypress", { detail: { keyCode, mods: { ...defaultMods, ...mods } } }));
}

//Mode indicator thing (insert, visualline)
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

// --- Best-effort per-mode cursor shape --------------------------------------
// DocsKeys cannot read the document's text (see MISSING_VIM_FEATURES.md /
// README "Why can't you read the line?"), and for the same underlying reason
// -- Google Docs draws everything itself instead of using standard editable
// DOM/CSS primitives -- there is no guaranteed, documented way to reshape its
// native caret into a Vim-style block/underline. What follows is a *purely
// additive, best-effort* attempt: we set a data attribute on <html> for the
// current mode and ship CSS rules that try to restyle Google Docs' known
// "kix" caret classes (kix-cursor, kix-cursor-caret) when they exist.
//
// This is deliberately implemented as CSS, not JS DOM manipulation of
// unknown elements: an unmatched CSS selector is a silent no-op, never a
// runtime error, so if Google renames these classes tomorrow this feature
// just quietly stops doing anything instead of breaking the extension. The
// floating mode badge (bottom-right) is kept as-is and remains the
// guaranteed-to-work mode indicator; treat the caret restyling as a bonus.
//
// Sizing: earlier versions used a flat `0.6em` block width, which doesn't
// track the actual glyph under the cursor and looked wrong across different
// font sizes/headings. `1ch` is a standard CSS unit defined as the width of
// the "0" character in the element's *own* font, so as long as the caret
// element inherits Docs' real font-size/family (which it should, since we
// don't touch font-family/size ourselves), this scales far more sensibly
// with the surrounding text than a hardcoded em value did. It's still an
// approximation (an average character isn't exactly "0"-width) but it's a
// meaningfully better one, and -- like everything else here -- a no-op
// rather than a crash if Docs' markup doesn't cooperate.
//
// Pending-input modes (operator-pending, "waiting for a register name",
// "waiting for the replace character", the i/a text-object prefix) get a
// distinct underscore-shaped cursor instead of a full block, using
// `transform: scaleY()` anchored to the bottom -- this only needs to squash
// whatever height Docs' own element already has, so unlike a hardcoded
// pixel height it doesn't depend on knowing the line-height/font-size.
const cursorStyleEl = document.createElement('style')
cursorStyleEl.id = 'docskeys-cursor-style'
cursorStyleEl.textContent = `
html[data-docskeys-mode="normal"] .kix-cursor,
html[data-docskeys-mode="normal"] .kix-cursor-caret {
    width: 1ch !important;
    opacity: 0.55 !important;
    background-color: #1a73e8 !important;
}
html[data-docskeys-mode="visual"] .kix-cursor,
html[data-docskeys-mode="visual"] .kix-cursor-caret,
html[data-docskeys-mode="visualLine"] .kix-cursor,
html[data-docskeys-mode="visualLine"] .kix-cursor-caret {
    width: 1ch !important;
    opacity: 0.55 !important;
    background-color: #fbbc04 !important;
}
html[data-docskeys-mode="replaceChar"] .kix-cursor,
html[data-docskeys-mode="replaceChar"] .kix-cursor-caret,
html[data-docskeys-mode="waitForFirstInput"] .kix-cursor,
html[data-docskeys-mode="waitForFirstInput"] .kix-cursor-caret,
html[data-docskeys-mode="waitForSecondInput"] .kix-cursor,
html[data-docskeys-mode="waitForSecondInput"] .kix-cursor-caret,
html[data-docskeys-mode="waitForVisualInput"] .kix-cursor,
html[data-docskeys-mode="waitForVisualInput"] .kix-cursor-caret,
html[data-docskeys-mode="waitForRegister"] .kix-cursor,
html[data-docskeys-mode="waitForRegister"] .kix-cursor-caret {
    width: 1ch !important;
    opacity: 0.75 !important;
    background-color: #ea4335 !important;
    transform: scaleY(0.18) !important;
    transform-origin: bottom !important;
}
html[data-docskeys-mode="insert"] .kix-cursor,
html[data-docskeys-mode="insert"] .kix-cursor-caret {
    width: 2px !important;
    opacity: 1 !important;
    transform: none !important;
}
`
document.head.appendChild(cursorStyleEl)

function updateModeIndicator(currentMode) {
    modeIndicator.textContent = currentMode.toUpperCase()
    document.documentElement.setAttribute('data-docskeys-mode', currentMode)
    switch(currentMode) {
        case 'normal':
            modeIndicator.style.backgroundColor = '#1a73e8'
            modeIndicator.style.color = 'white'
            break
        case 'insert':
            modeIndicator.style.backgroundColor = '#34a853'
            modeIndicator.style.color = 'white'
            break
        case 'visual':
        case 'visualLine':
            modeIndicator.style.backgroundColor = '#fbbc04'
            modeIndicator.style.color = 'black'
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

function switchModeToVisual() {
    mode = 'visual'
    updateModeIndicator(mode)
    sendKeyEvent('right', { shift: true })
}

function switchModeToVisualLine() {
    mode = 'visualLine'
    updateModeIndicator(mode)
    sendKeyEvent('home')
    sendKeyEvent('down', { shift: true })
}

function switchModeToNormal() {
    // NOTE: this used to also send a spurious "left" arrow whenever mode was
    // "waitForFirstInput" (operator-pending). That was intended to correct
    // cursor position for whole-line deletes, but dd/dj/dk-style callers
    // already set `mode = 'normal'` themselves *before* calling this function
    // specifically to avoid it -- so the branch was dead for its one
    // legitimate case and only ever fired as a bug: it moved the cursor left
    // one character after cancelling an operator with Escape/an invalid key,
    // and after every yank (yw, yy, ...), since those paths reach here while
    // mode is still "waitForFirstInput". Removed; see MISSING_VIM_FEATURES.md.
    if (mode == "visualLine") sendKeyEvent("left")
    mode = 'normal'
    updateModeIndicator(mode)

    //caret indicating visual mode 
    cursorTop.style.opacity = 1
    cursorTop.style.display = "block"
    cursorTop.style.backgroundColor = "black"
}

function switchModeToInsert() {
    mode = 'insert'
    updateModeIndicator(mode)
    cursorTop.style.opacity = 0
}

function switchModeToWait() {
    mode = "waitForFirstInput"
    updateModeIndicator(mode)
    // define cursor style
}

function switchModeToWait2() {
    mode = "waitForSecondInput"
    updateModeIndicator(mode)
    // define cursor style
}

// Enters the mode that waits for exactly one more keystroke -- the
// replacement character for the "r" command (see handleKeyEventNormal).
function switchModeToReplaceChar() {
    mode = "replaceChar"
    updateModeIndicator(mode)
}

// Enters the mode that waits for exactly one more keystroke naming a
// register -- the character after `"`, e.g. the "a" in `"ayy`. See the
// Registers section below.
let waitForRegisterReturnMode = "normal"
function switchModeToWaitForRegister() {
    waitForRegisterReturnMode = mode
    mode = "waitForRegister"
    updateModeIndicator(mode)
}

let longStringOp = ""
let operatorCount = 0 // pending count typed between an operator (c/d/y) and its motion, e.g. the "2" in "c2w"

// --- Dot-repeat (`.`) -------------------------------------------------------
// Real Vim's `.` replays the last *change*. For everything DocsKeys builds
// out of plain cursor-movement + Edit-menu clicks (dw, d$, dd, D, x, J, p,
// ...) that's just "call the same JS function again", so we record a
// zero-arg closure for the last dot-repeatable command and replay it here.
//
// This intentionally does NOT cover insert-mode text (ciw, o, A, s, and c-
// family operators only repeat their *deletion*, not what you typed
// afterward) -- see MISSING_VIM_FEATURES.md for why: inserted characters are
// real, trusted keystrokes DocsKeys never intercepts or records, so there is
// nothing to replay. After a repeated change-operator you'll land in insert
// mode and need to type the replacement text again, same as if you'd typed
// the operator+motion yourself.
//
// Per real Vim semantics, yank (`y`, `Y`) is NOT a change and does not get
// recorded here, and visual-mode operations are excluded entirely (visual
// dot-repeat is approximate even in real Vim, and doubly so without the
// ability to read text to judge selection sizes at the new cursor position).
let lastChange = null

function recordChange(fn) {
    lastChange = fn
}

// Runs a (possibly operator-driven) change function and records it for `.`
// unless op is "y" (yank never gets recorded, matching real Vim).
function runDotRepeatable(fn, op) {
    fn()
    if (op !== "y") recordChange(fn)
}

// --- Registers ---------------------------------------------------------
// DocsKeys cannot read the document's text (see MISSING_VIM_FEATURES.md /
// README "Why can't you read the line?"), so the *only* way it ever gets
// yanked/deleted text into JS-land at all is by asking Google Docs to put it
// on the real OS clipboard (via its own Edit > Copy/Cut menu item) and then
// reading that clipboard back with the async Clipboard API. That read is
// inherently racy -- Docs performs the clipboard write asynchronously, off
// the back of a simulated menu click, and there's no event we can await, so
// we just wait a beat and hope -- and it depends on Clipboard API
// permissions/behavior we can't fully verify without testing against a
// live, focused Google Docs tab.
//
// Every clipboard-API call here is therefore wrapped in try/catch and
// treated as *purely additive*: if it fails, the named register just
// doesn't get populated/restored, and DocsKeys falls back to exactly its
// old behavior (one implicit register, backed directly by the OS clipboard
// via the Edit menu, which is what plain `y`/`d`/`c`/`p` without a `"reg`
// prefix always use). Nothing about the pre-existing y/d/c/p behavior is
// allowed to depend on the Clipboard API succeeding.
let registers = {}
let pendingRegister = null // register name captured via `"` prefix; applies to the NEXT y/d/c/p only
const REGISTER_READ_DELAY_MS = 80 // heuristic; Docs' clipboard write from a simulated menu click isn't synchronous

function waitForRegisterInput(key) {
    if (/^[a-z0-9]$/i.test(key)) {
        pendingRegister = key.toLowerCase()
    }
    // Any other key (Esc, punctuation, ...): silently cancel, matching Vim's
    // behavior of treating an invalid register name as a no-op.
    mode = waitForRegisterReturnMode
    updateModeIndicator(mode)
}

async function captureClipboardIntoRegister(name) {
    if (!name) return
    try {
        await new Promise((resolve) => setTimeout(resolve, REGISTER_READ_DELAY_MS))
        const text = await navigator.clipboard.readText()
        registers[name] = text
    } catch (err) {
        console.warn(`DocsKeys: couldn't read clipboard into register "${name}" (best-effort feature; the default clipboard-backed register is unaffected)`, err)
    }
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
        // We just won't be able to restore the clipboard afterward; the
        // paste itself can still proceed below.
    }
    try {
        await navigator.clipboard.writeText(text)
        clickMenu(menuItems.paste)
        if (previousClipboard !== null) {
            await new Promise((resolve) => setTimeout(resolve, REGISTER_READ_DELAY_MS))
            await navigator.clipboard.writeText(previousClipboard)
        }
    } catch (err) {
        console.warn(`DocsKeys: couldn't paste from register "${name}", falling back to a normal paste`, err)
        clickMenu(menuItems.paste)
    }
}


function goToStartOfLine() {
    sendKeyEvent("home")
}

function goToEndOfLine() {
    sendKeyEvent("end")
}

function selectToStartOfLine() {
    sendKeyEvent("home", { shift: true })
}

function selectToEndOfLine() {
    sendKeyEvent("end", { shift: true })
}

function selectToStartOfWord() {
    sendKeyEvent("left", wordMods(true))
}

function selectToEndOfWord() {
    sendKeyEvent("right", wordMods(true))
}

// NOTE: despite the name, this is Google Docs' Ctrl+Right (Alt+Right on Mac)
// behavior, which Google's own docs describe as moving "to the next word" --
// i.e. to the *beginning* of the next word, not the end of the current one.
// This is exactly right for Vim's `w`, which is why it's used unmodified for
// that. It is NOT the same as Vim's `e` -- see goToEndOfWordVim below.
//
// This is also used as the underlying primitive for `W` (WORD motion): see
// the "WORD (W/E/B)" note below goToEndOfWordVim for why W/E/B are currently
// honest aliases of w/e/b rather than true whitespace-only WORD motions.
function goToEndOfWord() {
    sendKeyEvent("right", wordMods())
}

function goToStartOfWord() {
    sendKeyEvent("left", wordMods())
}

// Real Vim's `e` moves the cursor to the last character of the current (or
// next, if already at a word's end) word, and pressing `e` again from an
// end-of-word position moves to the end of the *following* word ("In Vim
// `ee` and `2e` are the same" -- vim's own docs). The only word-motion
// primitive DocsKeys has is Ctrl+Right, which moves to the *start* of the
// next word regardless of where inside the current word the cursor already
// is -- so a naive "Ctrl+Right then step back twice" gets stuck: pressing it
// twice in a row computes the exact same "next word start" both times and
// therefore never advances past the first word.
//
// Fix: nudge the cursor forward two plain characters *before* the word-jump.
// This guarantees that if the cursor was already sitting at an end-of-word
// position (2 characters before some word's start), the nudge pushes it to
// or past that word's start, so the following Ctrl+Right is forced to skip
// to the *next* word instead of recomputing the same one -- while a cursor
// freshly placed anywhere inside a word still lands on that same word's end,
// since two characters forward doesn't leave the word (as long as words are
// longer than 2 characters. For 1-2 character words this still works out
// because Ctrl+Right's own "next word" boundary detection absorbs it -- see
// MISSING_VIM_FEATURES.md for the full derivation and remaining edge cases).
//
// This is still a single-space, whitespace-boundary approximation: runs of
// multiple spaces/tabs, or punctuation immediately adjacent to a word (e.g.
// hyphens), can land a character or two off from true Vim behavior, because
// resolving that exactly requires reading line content, which this
// architecture cannot do. What's fixed here is specifically the "gets stuck
// on repeat" bug, not the punctuation-adjacency approximation.
function goToEndOfWordVim() {
    sendKeyEvent("right")
    sendKeyEvent("right")
    sendKeyEvent("right", wordMods())
    sendKeyEvent("left")
    sendKeyEvent("left")
}

function selectToEndOfWordVim() {
    sendKeyEvent("right", { shift: true })
    sendKeyEvent("right", { shift: true })
    sendKeyEvent("right", wordMods(true))
    sendKeyEvent("left", { shift: true })
    sendKeyEvent("left", { shift: true })
}

// --- WORD motions (W/E/B) ---------------------------------------------------
// Real Vim distinguishes "word" (w/e/b: stops at punctuation too) from
// "WORD" (W/E/B: only whitespace counts as a boundary). Telling those apart
// requires knowing what character is actually at the boundary, which
// DocsKeys cannot do (see "The core constraint" in MISSING_VIM_FEATURES.md).
// Google Docs' own Ctrl+Right/Left word-jump is the only primitive available
// either way, so W/E/B are implemented here as honest aliases of w/e/b: they
// share goToEndOfWord/goToEndOfWordVim/goToStartOfWord (and their
// select-variants) below rather than pretending to have separate,
// more-correct behavior. This is called out explicitly in the README/
// MISSING_VIM_FEATURES.md rather than silently shipped as identical.

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

// --- Linewise selection helpers for j/k as operator motions -----------------
// Real Vim: `dj` deletes the current line and the line below (2 lines
// total), `dk` deletes the current line and the line above (2 lines total),
// and a count extends how far the motion reaches (`d2j` = 3 lines: current +
// 2 below), consistent with `dd`/`2dd`. These mirror the existing whole-line
// selection approach used for dd/yy/cc below, just extending up or down
// instead of only down.
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

// `linewise` controls whether the "d" case does the extra merge-Backspace
// after Cut. That backspace is only correct for whole-line deletes (dd,
// dj, dk, ...): Home-to-End selection deliberately excludes the trailing
// newline, so after cutting, an empty line remains and needs one more
// Backspace to merge it away. For every other d-motion (dw, D, diw, d$,
// dh, dl, ...) the selection already includes everything that needs to go
// (e.g. selectToEndOfWord's Ctrl+Shift+Right already grabs the trailing
// space), so that same unconditional backspace used to delete one extra,
// unrelated character before the target -- a real bug that was previously
// flagged in MISSING_VIM_FEATURES.md but left unfixed. Defaulting this to
// false and only passing `true` from the genuinely-linewise call sites
// fixes it (and, as a side effect, also fixes `D`, which shares this "d"
// case and was incorrectly getting the extra backspace before).
function runLongStringOp(operation = longStringOp, linewise = false) {
    const reg = pendingRegister
    pendingRegister = null
    switch (operation) {
        case "c":
            clickMenu(menuItems.cut)
            captureClipboardIntoRegister(reg)
            switchModeToInsert()
            break
        case "d":
            clickMenu(menuItems.cut)
            captureClipboardIntoRegister(reg)
            if (linewise) sendKeyEvent('backspace')
            mode = 'normal'
            switchModeToNormal()
            break
        case "y":
            clickMenu(menuItems.copy)
            captureClipboardIntoRegister(reg)
            switchModeToNormal()
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


function waitForSecondInput(key) {
    switch (key) {
        case "w":
            goToStartOfWord()
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
    // Accumulate a count before the motion (e.g. the "2" in "c2w"). A bare "0"
    // typed before any other digit is the "start of line" motion, not a count.
    if (/[1-9]/.test(key) || (operatorCount > 0 && key === "0")) {
        operatorCount = operatorCount * 10 + Number(key)
        return
    }
    const count = operatorCount || 1
    operatorCount = 0
    const op = longStringOp // captured now, so a later operator press can't retroactively change what a recorded dot-repeat replays

    switch (key) {
        case "i":
        case "a":
            switchModeToWait2()
            break
        case "w":
        case "W": // see "WORD motions (W/E/B)" note above goToDocStart
            runDotRepeatable(() => { repeatMotion(selectToEndOfWord, count); runLongStringOp(op) }, op)
            break
        case "e":
        case "E":
            runDotRepeatable(() => { repeatMotion(selectToEndOfWordVim, count); runLongStringOp(op) }, op)
            break
        case "b":
        case "B":
            runDotRepeatable(() => { repeatMotion(selectToStartOfWord, count); runLongStringOp(op) }, op)
            break
        case "h":
            // Charwise: deletes/yanks count characters to the left of cursor.
            runDotRepeatable(() => { repeatMotion(() => sendKeyEvent("left", { shift: true }), count); runLongStringOp(op) }, op)
            break
        case "l":
            // Charwise: deletes/yanks count characters starting at cursor (like `x`).
            runDotRepeatable(() => { repeatMotion(() => sendKeyEvent("right", { shift: true }), count); runLongStringOp(op) }, op)
            break
        case "j":
            // Linewise: current line + count lines below (dj = 2 lines total).
            runDotRepeatable(() => { selectLinesDown(count); runLongStringOp(op, true) }, op)
            break
        case "k":
            // Linewise: current line + count lines above (dk = 2 lines total).
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

function waitForVisualInput(key) {
    switch (key) {
        case "w":
            sendKeyEvent("left",{control:true})
            goToStartOfWord()
            selectToEndOfWord()
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

    // A count typed *before* an operator (e.g. "3dw") is equivalent, per Vim
    // semantics, to giving the same count to the motion that follows the
    // operator (e.g. "d3w"). Route it through the existing operatorCount
    // mechanism rather than literally replaying "d" three times, which would
    // just re-enter waitForFirstInput redundantly and (previously) get its
    // mode clobbered back to "normal" below before the motion ever arrived.
    if (targetMode === "normal" && (key === "c" || key === "d" || key === "y")) {
        operatorCount = times
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

    // Only fall back to the mode we started counting from if the repeated
    // action didn't itself transition to a new mode (e.g. an "i"/"a"/"o"
    // entering insert mode, or "v" entering visual mode). Unconditionally
    // resetting here used to clobber those transitions.
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

        // Turn on state variable to indicate temperory normal mode
        tempnormal = true
        return;
    }
    if (e.ctrlKey && mode=='normal' && key=='r') {
        // Vim's redo is Ctrl+r (bare "r" is reserved for the "replace
        // character" command, see handleKeyEventNormal).
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
            // Delete the character under the cursor, then let this real,
            // trusted keystroke fall through untouched so the browser's
            // native input pipeline types the replacement character --
            // exactly like normal insert-mode typing elsewhere in this file,
            // which is why we return instead of calling preventDefault().
            //
            // Note this is also why `r` is intentionally NOT dot-repeatable
            // (see the "Dot-repeat" section above): there is no live,
            // trusted keystroke available to supply the replacement
            // character when `.` is pressed later, and re-dispatching the
            // character as a synthetic event wouldn't actually insert it
            // (same restriction that keeps insert-mode typing itself from
            // being replayable). A dot-repeat that silently deleted a
            // character without actually replacing it would be more
            // confusing than not having one at all.
            sendKeyEvent('delete')
            switchModeToNormal()
            if (tempnormal) {
                tempnormal = false
                switchModeToInsert()
            }
            return;
        }
        // Any other key (Tab, arrows, etc.) cancels replace-mode without
        // making an edit, same as Escape.
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
            goToStartOfWord()
            break
        case "B":
            // See "WORD motions (W/E/B)" note above goToDocStart: honest
            // alias of `b`, since DocsKeys can't distinguish word/WORD
            // boundaries without reading text.
            goToStartOfWord()
            break
        case "e":
            // See goToEndOfWordVim's comment: Google Docs' Ctrl+Right moves
            // to the *start* of the next word, not the end of the current
            // one, so `e` needs its own helper rather than reusing
            // goToEndOfWord() (which is correct for `w`, not `e`).
            goToEndOfWordVim()
            break
        case "E":
            goToEndOfWordVim()
            break
        case "w":
            goToEndOfWord()
            break
        case "W":
            goToEndOfWord()
            break
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
            // Delete to end of line, equivalent to "d$".
            { const fn = () => { selectToEndOfLine(); runLongStringOp("d") }
              fn(); recordChange(fn) }
            break
        case "C":
            // Change to end of line, equivalent to "c$".
            { const fn = () => { selectToEndOfLine(); runLongStringOp("c") }
              fn(); recordChange(fn) }
            break
        case "Y":
            // Yank the whole line, equivalent to "yy". Not dot-repeatable
            // (yank is never a "change" in Vim's dot-repeat model).
            goToStartOfLine()
            selectToEndOfLine()
            runLongStringOp("y")
            break
        case "\"":
            // Register prefix: the next key names a register (a-z, 0-9) to
            // use for the following y/d/c/p. See the Registers section above.
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
            // Real Vim's "r" waits for exactly one more keystroke and uses it
            // to replace the character under the cursor, staying in normal
            // mode throughout. See the "replaceChar" handling in
            // eventHandler for the actual replacement.
            switchModeToReplaceChar()
            break
        case ".":
            // Dot-repeat: replay the last recorded change, if any. See the
            // "Dot-repeat" section above for exactly what is and isn't
            // recorded.
            if (lastChange) lastChange()
            break
        case "/":
            clickMenu(menuItems.find)
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
                // Real Vim's J leaves a single space at the join point rather
                // than smashing the two lines together.
                sendKeyEvent("space")
              }
              fn(); recordChange(fn) }
            break
        default:
            return;
    }
    // Check if operation is occuring in temperory normal mode after ctrl-o
    if (tempnormal) {
        // Don't snap back to insert mode while a command is still "in
        // progress" (waiting on a motion or another keystroke) -- only once
        // a command has actually run to completion. waitForFirstInput et al.
        // consume `tempnormal` themselves once *they* finish.
        if (mode != 'visual' && mode != 'visualLine' && mode != 'replaceChar') {
            tempnormal = false
            switchModeToInsert()
        }
    }
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
            break
        case "j":
            sendKeyEvent("down", { shift: true })
            break
        case "k":
            sendKeyEvent("up", { shift: true })
            break
        case "l":
            sendKeyEvent("right", { shift: true })
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
            break
        case "{":
            goToStartOfPara(true)
            break
        case "b":
        case "B":
            selectToStartOfWord()
            break
        case "e":
        case "E":
            selectToEndOfWordVim()
            break
        case "w":
        case "W":
            selectToEndOfWord()
            break
        case "^":
        case "_":
        case "0":
            selectToStartOfLine()
            break
        case "$":
            selectToEndOfLine()
            break
        case "G":
            goToDocEnd(true)
            break
        case "g":
            goToDocStart(true)
            break
        case "c":
        case "d":
        case "y":
            // Visual-mode changes are intentionally not recorded for
            // dot-repeat (see the "Dot-repeat" section above) -- selection
            // size at a new cursor position can't be reliably re-derived
            // without reading text, so a replay could easily delete/yank the
            // wrong amount.
            runLongStringOp(key)
            break
        case "i":
        case "a":
            mode = "waitForVisualInput"
            break


    }
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
    // Sometimes a toolbar button won't exist in the DOM until its parent has been clicked, so we
    // click all of its parents in sequence.
    for (const caption of Array.from(captionList)) {
        const els = document.querySelectorAll(`*[aria-label='${caption}']`);
        if (els.length == 0) {
            console.log(`Couldn't find the element for the button labeled ${caption}.`);
            console.log(captionList);
            return;
        }
        // Sometimes there are multiple elements that have the same label. When that happens, it's
        // ambiguous which one to click, so we log it so it's easier to debug.
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
// Returns the DOM element of the menu item with the given caption. Prints a warning if a menu
// item isn't found (since this is a common source of errors in SheetKeys) unless silenceWarning
// is true.

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
            true, // bubbles
            true, // cancelable
            window, //view
            1, // event-detail
            x, // screenX
            y, // screenY
            x, // clientX
            y, // clientY
            false, // ctrl
            false, // alt
            false, // shift
            false, // meta
            0, // button
            null, // relatedTarget
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
    // Unlike submenus, top-level menus can be hidden by clicking the button a second time to
    // dismiss the menu.
    simulateClick(button);
    simulateClick(button);
}

// Initiate to Normal Mode
switchModeToNormal()