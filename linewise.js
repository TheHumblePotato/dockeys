// Linewise selection has an ordinary native caret. Its highlight is separate
// from Docs' anchor/focus range, which is materialized only for an operator.
let linewiseState = null
let linewiseHighlight = null

function clearLinewiseSelection() {
    linewiseState = null
    if (linewiseHighlight) linewiseHighlight.style.display = "none"
}

function linewiseParagraphBand(point) {
    const key = `${point.x}|${point.y}`
    const cache = linewiseState && (linewiseState.bands || (linewiseState.bands = new Map()))
    if (cache && cache.has(key)) return cache.get(key)
    const scroller = getDocsScrollContainer()
    const offsetY = scroller?.scrollTop || 0, offsetX = scroller?.scrollLeft || 0
    let best = null
    const current = renderedRunAtCaret()?.node?.closest('[role="paragraph"]')
    const currentBox = current?.getBoundingClientRect()
    const inCurrent = currentBox && point.y >= currentBox.top + offsetY - 1 && point.y <= currentBox.bottom + offsetY + 1 &&
        point.x >= currentBox.left + offsetX - 2 && point.x <= currentBox.right + offsetX + 2
    const nodes = inCurrent ? [current] : document.querySelectorAll('.kix-canvas-tile-content [role="paragraph"], .kix-canvas-tile-selection [role="paragraph"]')
    for (const node of nodes) {
        const rect = node.getBoundingClientRect()
        if (!rect.height || point.y < rect.top + offsetY - 1 || point.y > rect.bottom + offsetY + 1 ||
            point.x < rect.left + offsetX - 2 || point.x > rect.right + offsetX + 2) continue
        if (!best || rect.height < best.height) best = { top: rect.top + offsetY, bottom: rect.bottom + offsetY, height: rect.height }
    }
    if (cache) { if (cache.size > 300) cache.clear(); cache.set(key, best) }
    return best
}

async function startLinewiseSelection() {
    if (!beginOracle()) return
    try {
        let snapshot, anchorPoint, anchor
        if (mode === "visual") {
            const model = await completeVisualSnapshot()
            if (!model) return
            anchor = model.a
            anchorPoint = model.boundaries && model.boundaries.get(anchor)
            leaveVisualSelectionForEscape()
            snapshot = { text: model.text, at: model.c }
        } else snapshot = settings.readStrategy === "rendered" ? renderedContextAtCaret() : await getTextSnapshot()
        if (!snapshot && !(oracleAbort && oracleAbort.signal.aborted)) snapshot = renderedContextAtCaret() || { text: [], at: 0, partial: true }
        if (!snapshot || (oracleAbort && oracleAbort.signal.aborted)) return
        const at = DocsKeysVim.cursor(snapshot.text, snapshot.at)
        if (snapshot.text.length) moveSnapshotCaret(snapshot, at)
        await waitForEditorPaint()
        linewiseState = { text: snapshot.text, anchor: anchor === undefined ? at : anchor,
            point: anchorPoint || cursorDocumentPoint(), height: getCursorTop()?.getBoundingClientRect().height || 20 }
        visualModel = null
        mode = "visualLine"
        updateModeIndicator(mode)
    } finally { releaseOracle() }
}

function renderLinewiseSelection() {
    if (!linewiseState || !["visualLine", "multipleMotion", "gPrefix", "waitForFindChar", "search", "waitForRegister"].includes(mode)) {
        if (linewiseHighlight) linewiseHighlight.style.display = "none"
        return
    }
    if (readPresentationDepth) return
    const point = cursorDocumentPoint(), anchor = linewiseState.point
    if (!point || !anchor) return
    const scroller = getDocsScrollContainer()
    const box = scroller && scroller.getBoundingClientRect ? scroller.getBoundingClientRect() : null
    const scrollTop = scroller ? scroller.scrollTop : 0
    const anchorBand = linewiseParagraphBand(anchor), cursorBand = linewiseParagraphBand(point)
    const top = Math.max(box?.top || 0, Math.min(cursorBand?.top ?? point.y, anchorBand?.top ?? anchor.y) - scrollTop)
    const bottom = Math.min(box?.bottom || window.innerHeight || Infinity,
        Math.max(cursorBand?.bottom ?? point.y + (getCursorTop()?.getBoundingClientRect().height || linewiseState.height),
            anchorBand?.bottom ?? anchor.y + linewiseState.height) - scrollTop)
    if (!linewiseHighlight) {
        linewiseHighlight = document.createElement("div")
        linewiseHighlight.className = "docskeys-linewise-highlight"
        Object.assign(linewiseHighlight.style, { position: "fixed", pointerEvents: "none", zIndex: "9996",
            background: "rgba(26,115,232,0.2)" })
        document.body.appendChild(linewiseHighlight)
    }
    Object.assign(linewiseHighlight.style, { display: bottom > top ? "block" : "none", top: `${top}px`,
        left: `${box?.left || 0}px`, width: `${box?.width || scroller?.clientWidth || window.innerWidth || 600}px`, height: `${Math.max(0, bottom - top)}px` })
}

function linewiseRange(snapshot, op) {
    const a = DocsKeysVim.line(snapshot.text, linewiseState.anchor)
    const c = DocsKeysVim.line(snapshot.text, DocsKeysVim.cursor(snapshot.text, snapshot.at))
    let start = Math.min(a.start, c.start), end = Math.max(a.end, c.end)
    if (op !== "c") {
        if (end < snapshot.text.length) end++
        else if (op === "d" && start > 0) start--
    }
    return { start, end }
}

async function linewiseOperator(op) {
    if (!linewiseState || !beginOracle()) return
    try {
        const state = linewiseState
        const snapshot = await getTextSnapshot(true)
        if (!snapshot || state !== linewiseState) return
        if (snapshot.text.join("") !== state.text.join("")) {
            console.warn("DocsKeys: document changed; restart the linewise selection")
            return
        }
        const range = linewiseRange(snapshot, op)
        await withViewportPreserved(async () => {
            moveSnapshotCaret(snapshot, range.start)
            repeatMotion(() => sendKeyEvent("right", { shift: true }), range.end - range.start)
        })
        clearLinewiseSelection()
        mode = "visual"
        visualModel = { text: snapshot.text, a: range.start, c: Math.max(range.start, range.end - 1), dA: range.start, dF: range.end, fullDocument: true }
        if (op === "p") { mode = "normal"; await pasteRegister(pendingRegister); pendingRegister = null; switchModeToNormal() }
        else if (range.start === range.end) {
            if (op === "c") switchModeToInsert()
            else switchModeToNormal()
        } else await runLongStringOp(op)
    } finally { releaseOracle() }
}

async function linewiseToCharwise() {
    if (!linewiseState || !beginOracle()) return
    try {
        const state = linewiseState
        const snapshot = await getTextSnapshot()
        if (!snapshot || state !== linewiseState) return
        const at = DocsKeysVim.cursor(snapshot.text, snapshot.at)
        clearLinewiseSelection()
        mode = "visual"
        visualModel = { text: snapshot.text, a: state.anchor, c: at, dA: at, dF: at, fullDocument: true }
        visualSetSelection(state.anchor, at)
        updateModeIndicator(mode)
    } finally { releaseOracle() }
}

async function swapLinewiseCursor() {
    if (!linewiseState || !beginOracle()) return
    try {
        const state = linewiseState, point = cursorDocumentPoint()
        await withViewportPreserved(async () => {
            const snapshot = await getTextSnapshot()
            if (!snapshot || state !== linewiseState || snapshot.text.join("") !== state.text.join("")) return
            const target = state.anchor
            state.anchor = snapshot.at
            state.point = point
            moveSnapshotCaret(snapshot, target)
            await waitForEditorPaint()
            snapshot.point = cursorDocumentPoint()
            revealReadDestination()
        })
    } finally { releaseOracle() }
}

function handleLinewiseKey(key) {
    const edge = linewiseState && linewiseState.edge
    if ((key === "h" && edge === "start") || (key === "l" && edge === "end")) return
    if (linewiseState) linewiseState.edge = null
    if (key === "V") { clearLinewiseSelection(); switchModeToNormal(); return }
    if (key === "v") { linewiseToCharwise(); return }
    if (key === "o" || key === "O") { swapLinewiseCursor(); return }
    if (["h", "j", "k", "l"].includes(key)) { normalNavigation(key); return }
    if (["w", "W", "b", "B", "e", "E"].includes(key)) { snapshotWordMotion(key.toLowerCase(), key === key.toUpperCase(), 1, null, "visualLine"); return }
    if (["d", "x", "c", "s", "y", "p"].includes(key)) { linewiseOperator(key === "x" ? "d" : key === "s" ? "c" : key); return }
    if (key === "0") { sendKeyEvent("home"); linewiseState.edge = "start" }
    else if (key === "$") { sendKeyEvent("end"); linewiseState.edge = "end" }
    else if (key === "^" || key === "_") goToFirstNonBlank(null, "visualLine")
    else if (key === "g") startGPrefix(1, null, "visualLine")
    else if (key === "G") gotoTextLine(null, null, "visualLine")
    else if (key === "{") goToStartOfPara()
    else if (key === "}") goToEndOfPara()
    else if (key === '"') switchModeToWaitForRegister()
    else if (key === "/" || key === "?") { startSearch(key === "/", null, pendingSearchCount, "visualLine"); pendingSearchCount = 1 }
    else if (key === "n" || key === "N") { repeatSearch(key === "N", pendingSearchCount, null, "visualLine"); pendingSearchCount = 1 }
    else if (key === "*" || key === "#") { searchWordUnderCursor(key === "*", pendingSearchCount, "visualLine"); pendingSearchCount = 1 }
    else if (["f", "F", "t", "T"].includes(key)) {
        pendingFindType = key; pendingFindOperator = null; pendingFindReturnMode = "visualLine"
        mode = "waitForFindChar"; updateModeIndicator(mode)
    } else if (key === ";" || key === ",") repeatLastFind(key === ",", null, "visualLine")
}
