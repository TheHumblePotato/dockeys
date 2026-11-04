// Runs in the page's world so Docs sees legacy keyCode/which properties.
// Based on https://github.com/philc/sheetkeys/blob/master/page_scripts/page_script.js
const simulatedKeys = {
    8: ["Backspace", "Backspace"], 13: ["Enter", "Enter"],
    27: ["Escape", "Escape"], 32: [" ", "Space"],
    33: ["PageUp", "PageUp"], 34: ["PageDown", "PageDown"],
    35: ["End", "End"], 36: ["Home", "Home"],
    37: ["ArrowLeft", "ArrowLeft"], 38: ["ArrowUp", "ArrowUp"],
    39: ["ArrowRight", "ArrowRight"], 40: ["ArrowDown", "ArrowDown"],
    46: ["Delete", "Delete"],
}

function simulateKeyEvent(type, el, args) {
    const [key, code] = simulatedKeys[args.keyCode]
    const mods = args.mods || {}
    const event = new KeyboardEvent(type, {
        key, code, bubbles: true, cancelable: true,
        view: el.ownerDocument.defaultView,
        ctrlKey: !!mods.control, altKey: !!mods.alt,
        shiftKey: !!mods.shift, metaKey: !!mods.meta,
    })
    for (const property of ["keyCode", "which"]) {
        Object.defineProperty(event, property, { get: () => args.keyCode })
    }
    el.dispatchEvent(event)
}

function getEditorEl() {
    const iframe = document.querySelector(".docs-texteventtarget-iframe")
    const doc = iframe && iframe.contentDocument
    return doc && (doc.activeElement || doc.body)
}

window.addEventListener("doc-keys-simulate-keypress", (event) => {
    const args = event.detail
    if (!args || !Object.hasOwn(simulatedKeys, args.keyCode)) return
    const editor = getEditorEl()
    if (!editor) return // Docs may still be creating/replacing its input iframe.
    simulateKeyEvent("keydown", editor, args)
    simulateKeyEvent("keyup", editor, args)
})
