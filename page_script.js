// source- https://github.com/philc/sheetkeys/blob/master/page_scripts/page_script.js

// This script gets inserted into the page by our content script.
// It receives requests from the content script to simulate keypresses.
// Messages are passed to this script via "doc-keys-simulate-keypress" events, which are dispatched
// on the window object by the content script.

// How to simulate a keypress in Chrome: http://stackoverflow.com/a/10520017/46237
// Note that we have to do this keypress simulation in an injected script, because events dispatched
// by content scripts do not preserve overridden properties.
// - args: an object with keys keyCode, shiftKey
const simulateKeyEvent = function(eventType, el, args) {
    // How to do this in Chrome: http://stackoverflow.com/q/10455626/46237
    const event = document.createEvent("KeyboardEvent");
    Object.defineProperty(event, "keyCode", {
        get() {
            return this.keyCodeVal;
        },
    });
    Object.defineProperty(event, "which", {
        get() {
            return this.keyCodeVal;
        },
    });
    const mods = args.mods || {};
    event.initKeyboardEvent(
        eventType, // eventName
        true, // canBubble
        true, //canceleable
        document.defaultView, // view
        "", // keyIdentifier string
        false, // (not sure)
        !!mods.control, // control
        !!mods.alt, // alt
        !!mods.shift, // shift
        !!mods.meta, // meta
        args.keyCode, // keyCode
        args.keyCode, // (not sure)
    );
    event.keyCodeVal = args.keyCode;
    Object.defineProperty(event, "altKey", {
        get() {
            return !!mods.alt;
        },
    });
    Object.defineProperty(event, "metaKey", {
        get() {
            return !!mods.meta;
        },
    });
    el.dispatchEvent(event);
};

// Looked up fresh on every simulated keypress rather than cached once at
// script-load time. The original version did `const editorEl =
// document.querySelector(...).contentDocument.activeElement` here at the
// top level -- if Google Docs hadn't created its keystroke-capture iframe
// yet at the moment this script ran (a real, observed race on some page
// loads), that line throws, and since nothing after it in the file ever
// runs, the addEventListener() call below never registers at all -- so
// *no* DocsKeys command works, silently, for the rest of the page's life,
// with no way to recover short of reloading. Looking it up fresh each time
// avoids both that startup race and the possibility of a stale cached
// element if the iframe's active element ever changes later.
function getEditorEl() {
    const iframe = document.querySelector(".docs-texteventtarget-iframe");
    if (!iframe || !iframe.contentDocument) return null;
    return iframe.contentDocument.activeElement || iframe.contentDocument.body || null;
}

window.addEventListener("doc-keys-simulate-keypress", function(event) {
    const editorEl = getEditorEl();
    if (!editorEl) {
        console.warn("DocsKeys: couldn't find the Docs keystroke-capture element (page may still be loading, or no document is focused)");
        return;
    }
    const args = event.detail
    simulateKeyEvent("keydown", editorEl, args);
    simulateKeyEvent("keyup", editorEl, args);
});

