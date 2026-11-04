// Request Docs' annotated-canvas layer before the editor initializes. The
// request uses this extension's own ID and does not impersonate another one.
(() => {
    window.dispatchEvent(new CustomEvent("docskeys-annotation-request", { detail: chrome.runtime.id }))
    const script = document.createElement("script")
    script.src = chrome.runtime.getURL("annotate.js")
    script.dataset.docskeysExtension = chrome.runtime.id
    script.onload = () => script.remove()
    const attach = () => {
        if (!document.documentElement) return false
        document.documentElement.appendChild(script)
        return true
    }
    if (!attach()) {
        const observer = new MutationObserver(() => {
            if (attach()) observer.disconnect()
        })
        observer.observe(document, { childList: true })
    }
})()
