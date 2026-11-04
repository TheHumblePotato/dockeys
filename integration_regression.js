const assert = require("node:assert/strict")
const fs = require("node:fs")
const vm = require("node:vm")
const path = require("node:path")

function load(file, context) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, file), "utf8"), context)
}

// Exercise popup loading, saving, validation, and updates from another popup.
const inputs = Object.fromEntries(["dvorak", "boxCursor", "modeIndicator", "startInInsert", "wordMotion"]
    .map((name) => [name, { type: name === "wordMotion" ? "select-one" : "checkbox" }]))
let onChange, onStorage, saved
const fieldset = { disabled: true, elements: { namedItem: (name) => inputs[name] },
    addEventListener(type, fn) { onChange = fn } }
const status = { textContent: "" }
const popup = vm.createContext({
    document: { getElementById: (id) => id === "settings" ? fieldset : status },
    chrome: { runtime: {}, storage: {
        local: { get(key, cb) { cb({ [key]: { dvorak: false, boxCursor: "bad", wordMotion: "bad" } }) },
            set(value, cb) { saved = value; cb() } },
        onChanged: { addListener(fn) { onStorage = fn } },
    } },
})
load("settings.js", popup)
load("popup.js", popup)
assert.equal(fieldset.disabled, false)
assert.equal(inputs.dvorak.checked, false)
assert.equal(inputs.boxCursor.checked, true)
assert.equal(inputs.wordMotion.value, "native")
inputs.wordMotion.value = "precise"
inputs.startInInsert.checked = true
onChange()
assert.equal(saved["docskeys-settings"].wordMotion, "precise")
assert.equal(saved["docskeys-settings"].startInInsert, true)
assert.match(status.textContent, /Saved/)
onStorage({ "docskeys-settings": { newValue: { modeIndicator: false } } }, "local")
assert.equal(inputs.modeIndicator.checked, false)
assert.equal(inputs.wordMotion.value, "native")
popup.chrome.runtime.lastError = { message: "unavailable" }
onChange()
assert.match(status.textContent, /Could not save/)

// Check the injected bridge against a real event-shaped constructor, including
// startup without an iframe, replaced editors, modifiers, and legacy codes.
let listener, iframe = null
const events = []
const bridge = vm.createContext({
    document: { querySelector: () => iframe },
    window: { addEventListener(type, fn) { listener = fn } },
    KeyboardEvent: class {
        constructor(type, init) { this.type = type; Object.assign(this, init) }
    },
})
load("page_script.js", bridge)
listener({ detail: { keyCode: 39 } })
const editor = { ownerDocument: { defaultView: {} }, dispatchEvent: (e) => events.push(e) }
iframe = { contentDocument: { activeElement: editor } }
listener({ detail: { keyCode: 39, mods: { control: true, shift: true } } })
assert.deepEqual(events.map((e) => [e.type, e.key, e.code, e.keyCode, e.which, e.ctrlKey, e.shiftKey]), [
    ["keydown", "ArrowRight", "ArrowRight", 39, 39, true, true],
    ["keyup", "ArrowRight", "ArrowRight", 39, 39, true, true],
])
listener({ detail: { keyCode: 999 } })
assert.equal(events.length, 2)
const replacement = []
iframe.contentDocument.activeElement = { ...editor, dispatchEvent: (e) => replacement.push(e) }
listener({ detail: { keyCode: 37, mods: { alt: true, meta: true } } })
assert.equal(replacement.length, 2)
assert.equal(replacement[0].altKey, true)
assert.equal(replacement[0].metaKey, true)

console.log("Popup preferences and page event bridge passed")
