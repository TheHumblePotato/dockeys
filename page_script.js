// Install once, early in the page world. The late script loader remains a
// compatibility fallback for browsers that ignore the manifest world field.
(() => {
if (window.__docskeysBridgeInstalled) return
window.__docskeysBridgeInstalled = true
window.addEventListener("docskeys-annotation-request", (event) => {
    if (typeof event.detail === "string" && /^[a-p]{32}$/.test(event.detail) && !window._docs_annotate_canvas_by_ext) {
        window._docs_annotate_canvas_by_ext = event.detail
    }
})
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

let prepareEditorDocument = () => {}
function getEditorEl() {
    const iframe = document.querySelector(".docs-texteventtarget-iframe")
    const doc = iframe && iframe.contentDocument
    if (doc) prepareEditorDocument(doc)
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

// Docs schedules focus/scroll work independently of its selection updates.
// Suppress page-world programmatic scrolling only during explicit probes.
// Native wheel/touch scrolling and content-world viewport restoration remain
// available. A short lease prevents a lost completion from locking scrolling.
;(() => {
    if (typeof Element !== "function" || typeof HTMLElement !== "function") return
    let blockedUntil = 0
    window.addEventListener("doc-keys-read-phase", (event) => {
        blockedUntil = event.detail && event.detail.active ? Date.now() + 4000 : 0
    })
    const active = () => Date.now() < blockedUntil
    const editorNode = (node) => node === document.scrollingElement ||
        !!(node && node.closest && node.closest(".kix-appview-editor, .kix-appview-editor-container, .docs-texteventtarget-iframe"))
    for (const name of ["scrollTop", "scrollLeft"]) {
        const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, name)
        if (!descriptor || !descriptor.configurable || !descriptor.set) continue
        Object.defineProperty(Element.prototype, name, { ...descriptor,
            set(value) { if (!active() || !editorNode(this)) descriptor.set.call(this, value) },
        })
    }
    for (const name of ["scrollIntoView", "scrollIntoViewIfNeeded", "scroll", "scrollTo", "scrollBy"]) {
        const original = Element.prototype[name]
        if (typeof original !== "function") continue
        Element.prototype[name] = function(...args) {
            if (!active() || !editorNode(this)) return original.apply(this, args)
        }
    }
    const guardedFocus = new WeakSet()
    function protectFocus(prototype) {
        if (!prototype || guardedFocus.has(prototype)) return
        guardedFocus.add(prototype)
        const focus = prototype.focus
        prototype.focus = function(options) {
            const frame = this.ownerDocument && this.ownerDocument.defaultView && this.ownerDocument.defaultView.frameElement
            if (active() && (editorNode(this) || (frame && editorNode(frame)))) {
                return focus.call(this, { ...(options || {}), preventScroll: true })
            }
            return focus.call(this, options)
        }
    }
    protectFocus(HTMLElement.prototype)
    prepareEditorDocument = (doc) => protectFocus(doc.defaultView && doc.defaultView.HTMLElement && doc.defaultView.HTMLElement.prototype)
})()

})()
