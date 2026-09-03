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
        cursorTop = document.getElementsByClassName("kix-cursor-top")[0] || null
    }
    return cursorTop
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
    if (mode == "visualLine") sendKeyEvent("left")
    mode = 'normal'
    updateModeIndicator(mode)

    const ct = getCursorTop()
    if (ct) {
        ct.style.opacity = 1
        ct.style.display = "block"
        ct.style.backgroundColor = "black"
    }
}

function switchModeToInsert() {
    mode = 'insert'
    updateModeIndicator(mode)
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
const REGISTER_READ_DELAY_MS = 80
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

function waitForRegisterInput(key) {
    if (/^[a-z0-9]$/i.test(key)) {
        pendingRegister = key.toLowerCase()
    }
    mode = waitForRegisterReturnMode
    updateModeIndicator(mode)
}

async function captureClipboardIntoRegister(name) {
    if (!name) return
    try {
        await new Promise((resolve) => setTimeout(resolve, REGISTER_READ_DELAY_MS))
        const text = await navigator.clipboard.readText()
        registers[name] = text
        saveRegisters()
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


// Reads the text of the current wrapped display line, split at the cursor,
// without ever touching the document: select cursor->end (Home/End key, same
// as $/0), Copy, read the clipboard, collapse the selection back to the
// original cursor position, then repeat for start->cursor. The user's real
// clipboard is saved beforehand and restored afterward, mirroring the
// save/restore pattern pasteRegister() already uses.
//
// Because this always reads the *live* selection at the moment it's called
// (never a cached snapshot), it stays correct even if a collaborator is
// editing elsewhere in the document -- there's no stale state to drift.
// The only risk window is the ~150-300ms this takes to run: a collaborator
// editing at this exact cursor position during that window could invalidate
// the read. Considered an acceptable, documented limitation for now.
async function readCursorLineContext() {
    let previousClipboard = null
    try {
        previousClipboard = await navigator.clipboard.readText()
    } catch (err) {
        // Best-effort: if we can't read the existing clipboard we can't restore
        // it later either, but we can still proceed with the find itself.
    }
    let before = null
    let after = null
    try {
        sendKeyEvent("end", { shift: true })
        clickMenu(menuItems.copy)
        await new Promise((resolve) => setTimeout(resolve, REGISTER_READ_DELAY_MS))
        after = await navigator.clipboard.readText()
        sendKeyEvent("left") // collapses the selection back to its start (the original cursor)

        sendKeyEvent("home", { shift: true })
        clickMenu(menuItems.copy)
        await new Promise((resolve) => setTimeout(resolve, REGISTER_READ_DELAY_MS))
        before = await navigator.clipboard.readText()
        sendKeyEvent("right") // collapses the selection back to its end (the original cursor)
    } catch (err) {
        console.warn("DocsKeys: couldn't read line text for f/F/t/T (best-effort feature; falling back to no-op)", err)
        return null
    } finally {
        if (previousClipboard !== null) {
            try {
                await navigator.clipboard.writeText(previousClipboard)
            } catch (err) {
                console.warn("DocsKeys: couldn't restore clipboard after f/F/t/T read", err)
            }
        }
    }
    return { before, after }
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
function applyFindResult(type, steps, operator, returnMode) {
    const forward = (type === "f" || type === "t")
    const inclusive = (type === "f" || type === "t")
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
        mode = returnMode
        updateModeIndicator(mode)
        return
    }

    repeatMotion(() => sendKeyEvent(dirKey), steps)
    switchModeToNormal()
}

async function performFind(type, char, count, operator, returnMode) {
    const ctx = await readCursorLineContext()
    if (!ctx) {
        finishFind(returnMode)
        return
    }
    const forward = (type === "f" || type === "t")
    const isTill = (type === "t" || type === "T")
    const result = forward
        ? findForward(ctx.after, char, count)
        : findBackward(ctx.before, char, count)

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

function repeatLastFind(reverse) {
    if (!lastFind) return
    let { type, char } = lastFind
    if (reverse) {
        type = { f: "F", F: "f", t: "T", T: "t" }[type]
    }
    performFind(type, char, 1, null, "normal")
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

function goToEndOfWord() {
    sendKeyEvent("right", wordMods())
}

function goToStartOfWord() {
    sendKeyEvent("left", wordMods())
}

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
            goToStartOfWord()
            break
        case "B":
            goToStartOfWord()
            break
        case "e":
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
            { const fn = () => { selectToEndOfLine(); runLongStringOp("d") }
              fn(); recordChange(fn) }
            break
        case "C":
            { const fn = () => { selectToEndOfLine(); runLongStringOp("c") }
              fn(); recordChange(fn) }
            break
        case "Y":
            goToStartOfLine()
            selectToEndOfLine()
            runLongStringOp("y")
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