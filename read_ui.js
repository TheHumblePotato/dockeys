// Temporary probes are not user selections. Hide only the selection layer,
// retain its layout/Copy behavior, and keep the real visual highlight stable
// while Docs processes a batch of synthetic selection events.
let readPresentationDepth = 0
let selectionBatchGeneration = 0
let selectionFreezeLayer = null
let readPresentationStyle = null
let selectionFreezeScroll = null
let readPresentationGeneration = 0
let readScrollSettling = false

function cancelReadScrollSettlement() {
    if (!readScrollSettling) return
    readScrollSettling = false
    window.dispatchEvent(new CustomEvent("doc-keys-read-phase", { detail: { active: false } }))
}

// A formatting command owns subsequent focus/layout changes. In particular,
// opening comments must not inherit a probe's horizontal scroll lock.
function finishReadForNativeAction() {
    if (readPresentationDepth || viewportRead) return
    viewportEpoch++
    readPresentationGeneration++
    selectionBatchGeneration++
    readScrollSettling = false
    setReadAttribute("data-docskeys-reading", false)
    setReadAttribute("data-docskeys-selection-batch", false)
    removeSelectionFreeze()
    window.dispatchEvent(new CustomEvent("doc-keys-read-phase", { detail: { active: false } }))
}

function setReadAttribute(name, active) {
    const root = document.documentElement
    if (!root || !root.setAttribute) return
    if (active) root.setAttribute(name, "")
    else root.removeAttribute(name)
}

function ensureReadStyle() {
    if (readPresentationStyle) return
    readPresentationStyle = document.createElement("style")
    readPresentationStyle.textContent = `
        html[data-docskeys-reading] .kix-selection-overlay,
        html[data-docskeys-reading] .kix-selection-overlay *,
        html[data-docskeys-selection-batch] .kix-selection-overlay,
        html[data-docskeys-selection-batch] .kix-selection-overlay * {
            opacity: 0 !important;
        }
        html[data-docskeys-reading] .docs-texteventtarget-iframe { outline: none !important; }
    `
    document.documentElement.appendChild(readPresentationStyle)
}

function freezeVisualSelection() {
    if (selectionFreezeLayer || typeof mode === "undefined" ||
        (mode !== "visual" && mode !== "visualLine" && !(typeof visualModel !== "undefined" && visualModel))) return
    const overlays = Array.from(document.querySelectorAll(".kix-selection-overlay"))
    const rects = []
    for (const node of overlays) {
        const rect = node.getBoundingClientRect()
        const color = window.getComputedStyle ? window.getComputedStyle(node).backgroundColor : null
        if (rect.width > 0 && rect.height > 0) rects.push({ rect, color: color && color !== "rgba(0, 0, 0, 0)" && color !== "transparent" ? color : "rgba(26,115,232,0.3)" })
    }
    if (!rects.length) return
    selectionFreezeLayer = document.createElement("div")
    selectionFreezeLayer.className = "docskeys-selection-freeze"
    selectionFreezeLayer.style.pointerEvents = "none"
    selectionFreezeLayer.style.position = "fixed"
    selectionFreezeLayer.style.inset = "0"
    selectionFreezeLayer.style.zIndex = "9997"
    for (const { rect, color } of rects) {
        const block = document.createElement("div")
        Object.assign(block.style, { position: "fixed", left: `${rect.left}px`, top: `${rect.top}px`,
            width: `${rect.width}px`, height: `${rect.height}px`, background: color })
        selectionFreezeLayer.appendChild(block)
    }
    document.body.appendChild(selectionFreezeLayer)
    const el = getDocsScrollContainer()
    selectionFreezeScroll = el ? { el, top: el.scrollTop, left: el.scrollLeft || 0 } : null
}

function updateSelectionFreezePosition() {
    if (!selectionFreezeLayer || !selectionFreezeScroll) return
    const { el, top, left } = selectionFreezeScroll
    selectionFreezeLayer.style.transform = `translate(${left - (el.scrollLeft || 0)}px, ${top - el.scrollTop}px)`
}

function removeSelectionFreeze() {
    if (selectionFreezeLayer && selectionFreezeLayer.remove) selectionFreezeLayer.remove()
    selectionFreezeLayer = null
    selectionFreezeScroll = null
}

function afterSelectionPaint(fn) {
    if (typeof requestAnimationFrame !== "function") { fn(); return }
    let done = false
    const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        fn()
    }
    // Background tabs and headless Chromium may throttle animation frames.
    // A missed frame must not leave document selections permanently hidden.
    const timer = setTimeout(finish, 80)
    requestAnimationFrame(() => requestAnimationFrame(finish))
}

async function withReadPresentation(fn, settleMs = 80) {
    const outer = readPresentationDepth++ === 0
    const generation = outer ? ++readPresentationGeneration : readPresentationGeneration
    if (outer) {
        readScrollSettling = false
        ensureReadStyle()
        freezeVisualSelection()
        setReadAttribute("data-docskeys-reading", true)
        window.dispatchEvent(new CustomEvent("doc-keys-read-phase", { detail: { active: true } }))
    }
    try { return await fn() }
    finally {
        readPresentationDepth--
        if (outer) {
            readScrollSettling = true
            if (typeof requestAnimationFrame === "function") {
                setTimeout(() => {
                    if (!readPresentationDepth && generation === readPresentationGeneration) cancelReadScrollSettlement()
                }, settleMs)
            } else cancelReadScrollSettlement()
            afterSelectionPaint(() => {
                if (readPresentationDepth || generation !== readPresentationGeneration) return
                setReadAttribute("data-docskeys-reading", false)
                if (!document.documentElement.hasAttribute || !document.documentElement.hasAttribute("data-docskeys-selection-batch")) removeSelectionFreeze()
            })
        }
    }
}

function withStableSelection(fn) {
    ensureReadStyle()
    freezeVisualSelection()
    setReadAttribute("data-docskeys-selection-batch", true)
    const generation = ++selectionBatchGeneration
    const finish = () => {
        afterSelectionPaint(() => {
            if (generation !== selectionBatchGeneration) return
            setReadAttribute("data-docskeys-selection-batch", false)
            if (!readPresentationDepth) removeSelectionFreeze()
        })
    }
    try {
        const result = fn()
        if (result && typeof result.then === "function") return result.finally(finish)
        finish()
        return result
    } catch (err) { finish(); throw err }
}
