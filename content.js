// Google Docs has // G// Google Docs has // Google Docs has moved from using editable HTML elements (textbox with contenteditable=true)
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
    if (mode == "visualLine" || mode == "waitForFirstInput") sendKeyEvent("left")
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

let longStringOp = ""
let operatorCount = 0 // pending count typed between an operator (c/d/y) and its motion, e.g. the "2" in "c2w"


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

function runLongStringOp(operation = longStringOp) {
    switch (operation) {
        case "c":
            clickMenu(menuItems.cut)
            switchModeToInsert()
            break
        case "d":
            clickMenu(menuItems.cut)
            sendKeyEvent('backspace')
            mode = 'normal'
            switchModeToNormal()
            break
        case "y":
            clickMenu(menuItems.copy)
            switchModeToNormal()
            break
        case "p":
            clickMenu(menuItems.paste)
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

    switch (key) {
        case "i":
        case "a":
            switchModeToWait2()
            break
        case "w":
            repeatMotion(selectToEndOfWord, count)
            runLongStringOp()
            break
        case "p":
            repeatMotion(selectToEndOfPara, count)
            runLongStringOp()
            break
        case "^":
        case "_":
        case "0":
            selectToStartOfLine()
            runLongStringOp()
            break
        case "$":
            selectToEndOfLine()
            runLongStringOp()
            break
					case "G":
            goToDocEnd(true)
            runLongStringOp()
            break
        case "g":
            goToDocStart(true)
            runLongStringOp()
            break
        case longStringOp:
            goToStartOfLine()
            selectToEndOfLine()
            for (let i = 1; i < count; i++) {
                sendKeyEvent("down", { shift: true })
                sendKeyEvent("end", { shift: true })
            }
            runLongStringOp()
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
        case "e":
            goToEndOfWord()
            sendKeyEvent("right")
            break
        case "w":
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
            selectToEndOfLine()
            runLongStringOp("d")
            break
        case "C":
            // Change to end of line, equivalent to "c$".
            selectToEndOfLine()
            runLongStringOp("c")
            break
        case "Y":
            // Yank the whole line, equivalent to "yy".
            goToStartOfLine()
            selectToEndOfLine()
            runLongStringOp("y")
            break
        case "p":
            clickMenu(menuItems.paste)
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
        case "/":
            clickMenu(menuItems.find)
            break
        case "x":
            sendKeyEvent("delete")
            break
				case "s":
            sendKeyEvent("delete")
            switchModeToInsert()
            break
        case "J":
            goToEndOfLine()
            sendKeyEvent("delete")
            // Real Vim's J leaves a single space at the join point rather
            // than smashing the two lines together.
            sendKeyEvent("space")
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
        case "p":
            clickMenu(menuItems.paste)
            switchModeToNormal()
            break
        case "}":
            goToEndOfPara(true)
            break
        case "{":
            goToStartOfPara(true)
            break
        case "b":
            selectToStartOfWord()
            break
        case "e":
        case "w":
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