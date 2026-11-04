// Linewise selection has an ordinary native caret. Its highlight is separate
// from Docs' anchor/focus range, which is materialized only for an operator.
let linewiseState = null
let linewiseHighlight = null

function clearLinewiseSelection() {
    linewiseState = null
    if (linewiseHighlight) linewiseHighlight.style.display = "none"
}

function linewiseUnit() {
    if (linewiseState && linewiseState.unit !== settings.visualVertical) {
        linewiseState.unit = settings.visualVertical
        linewiseState.goal = null
        linewiseState.bands = new Map()
    }
    return settings.visualVertical
}

function linewiseCursorRow() {
    const caret = getCursorTop(), point = cursorDocumentPoint()
    return point && { point, height: caret?.getBoundingClientRect().height || 20 }
}

function sameDisplayRow(a, b) {
    return !!a && !!b && Math.min(a.point.y + a.height, b.point.y + b.height) - Math.max(a.point.y, b.point.y) > Math.min(a.height, b.height) / 4
}

async function seekLinewiseRow(target, shift = false) {
    let previousDirection = 0
    for (let n = 0; n < 500; n++) {
        if (oracleAbort?.signal.aborted) return false
        const before = linewiseCursorRow()
        if (sameDisplayRow(before, target)) return true
        if (!before) return false
        const direction = target.point.y > before.point.y ? 1 : -1
        if (previousDirection && direction !== previousDirection) return false
        previousDirection = direction
        sendKeyEvent(direction > 0 ? "down" : "up", { shift })
        await waitForEditorPaint()
        if (sameDisplayRow(before, linewiseCursorRow())) return false
    }
    return false
}

async function seekLinewisePoint(target) {
    if (!await seekLinewiseRow(target)) return false
    const row = linewiseCursorRow()
    for (let n = 0; n < 1000; n++) {
        if (oracleAbort?.signal.aborted) return false
        const point = cursorDocumentPoint()
        if (!point) return false
        if (Math.abs(point.x - target.point.x) <= 1) return true
        const right = point.x < target.point.x
        sendKeyEvent(right ? "right" : "left")
        await waitForEditorPaint()
        const next = linewiseCursorRow()
        if (!sameDisplayRow(row, next)) {
            sendKeyEvent(right ? "left" : "right")
            if (right) sendKeyEvent("end")
            await waitForEditorPaint()
            return comparePoints(cursorDocumentPoint(), target.point) === 0
        }
        if (comparePoints(next.point, point) === 0) return false
        if (Math.abs(next.point.x - target.point.x) > Math.abs(point.x - target.point.x)) {
            sendKeyEvent(right ? "left" : "right")
            return false
        }
    }
    return false
}

function linewiseStillValid(state) {
    if (state !== linewiseState || oracleAbort?.signal.aborted) return false
    if (state.revision !== documentRevision) {
        showSearchLine("Document changed; restart the line selection")
        return false
    }
    return true
}

async function resolveLinewiseAnchor(snapshot) {
    const state = linewiseState
    if (!linewiseStillValid(state)) return null
    if (state.anchorIndex !== undefined) return state.anchorIndex
    if (!await seekLinewisePoint({ point: state.point, height: state.height })) return null
    const before = await withClipboardSaved((previous) => readDocumentSide(false, previous))
    if (before === null || !linewiseStillValid(state)) return null
    const at = toGraphemes(before).length
    if (snapshot.text.slice(0, at).join("") !== before) return null
    state.anchorIndex = at
    snapshot.at = at
    snapshot.point = cursorDocumentPoint()
    return at
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
        await withViewportPreserved(async () => {
            let anchorPoint, anchorIndex
            const cached = snapshotUsable() && !textSnapshot.partial ? textSnapshot : null
            if (mode === "visual") {
                const model = visualModel
                anchorPoint = model?.boundaries?.get(model.a) || visualAnchorPoint
                if (model?.fullDocument) anchorIndex = model.a
                if (model && !anchorPoint) {
                    visualRealizeDocs(model.a, model.a)
                    await waitForEditorPaint()
                    anchorPoint = cursorDocumentPoint()
                    visualMoveCaret(model.a, model.c)
                    await waitForEditorPaint()
                } else leaveVisualSelectionForEscape()
            } else if (cached) anchorIndex = cached.at
            await waitForEditorPaint()
            if (oracleAbort?.signal.aborted) return
            const row = linewiseCursorRow()
            if (!row) return
            linewiseState = { point: anchorPoint || row.point, height: row.height,
                anchorIndex, unit: settings.visualVertical, revision: documentRevision }
            visualModel = null
            mode = "visualLine"
            updateModeIndicator(mode)
        }, 500)
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
    const logical = linewiseUnit() === "logical"
    const anchorBand = logical ? linewiseParagraphBand(anchor) : null, cursorBand = logical ? linewiseParagraphBand(point) : null
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

function linewiseRange(snapshot, op, anchor, cursor) {
    const a = DocsKeysVim.line(snapshot.text, anchor)
    const c = DocsKeysVim.line(snapshot.text, DocsKeysVim.cursor(snapshot.text, cursor))
    let start = Math.min(a.start, c.start), end = Math.max(a.end, c.end)
    if (op !== "c") {
        if (end < snapshot.text.length) end++
        else if (op === "d" && start > 0) start--
    }
    return { start, end }
}

async function realizeDisplayLinewiseRange(state, op) {
    const cursor = linewiseCursorRow(), anchor = { point: state.point, height: state.height }
    if (!cursor) return null
    const first = cursor.point.y < anchor.point.y ? cursor : anchor
    const last = first === cursor ? anchor : cursor
    sendKeyEvent("home")
    await waitForEditorPaint()
    if (!await seekLinewiseRow(first)) return null
    const start = cursorDocumentPoint()
    activeProbeRestore = () => restoreAbortedProbe(start, true)
    if (!await seekLinewiseRow(last, true)) return null
    if (op === "c") sendKeyEvent("end", { shift: true })
    else {
        // Starting in column zero, Shift+Down reaches the following displayed
        // row without treating a soft wrap as an extra character/newline.
        sendKeyEvent("down", { shift: true })
        await waitForEditorPaint()
        if (sameDisplayRow(linewiseCursorRow(), last)) sendKeyEvent("end", { shift: true })
        else sendKeyEvent("home", { shift: true })
    }
    await waitForEditorPaint()
    return { empty: comparePoints(start, cursorDocumentPoint()) === 0 }
}

async function linewiseMoveVertical(down, count = 1) {
    if (!linewiseState) return
    if (linewiseUnit() === "display") {
        repeatMotion(() => normalNavigation(down ? "j" : "k"), count)
        return
    }
    if (!beginOracle()) return
    try {
        const state = linewiseState
        await withViewportPreserved(async () => {
            const snapshot = await getTextSnapshot()
            if (!snapshot || !linewiseStillValid(state)) return
            let at = snapshot.at
            if (state.goal === null || state.goal === undefined) state.goal = at - DocsKeysVim.line(snapshot.text, at).start
            for (let n = 0; n < count; n++) {
                const row = DocsKeysVim.line(snapshot.text, at)
                if ((down && row.end === snapshot.text.length) || (!down && row.start === 0)) break
                const next = DocsKeysVim.line(snapshot.text, down ? row.end + 1 : row.start - 1)
                at = Math.min(next.start + state.goal, Math.max(next.start, next.end - 1))
            }
            moveSnapshotCaret(snapshot, at)
            await waitForEditorPaint()
            snapshot.point = cursorDocumentPoint()
            textSnapshot = snapshot
            revealReadDestination()
        }, 500)
    } finally { releaseOracle() }
}

async function linewiseOperator(op) {
    if (!linewiseState || !beginOracle()) return
    try {
        const state = linewiseState
        let empty, range, snapshot
        await withViewportPreserved(async () => {
            if (!linewiseStillValid(state)) return
            if (linewiseUnit() === "display") {
                const result = await realizeDisplayLinewiseRange(state, op)
                if (!result) return
                empty = result.empty
            } else {
                snapshot = await getTextSnapshot(true)
                if (!snapshot || !linewiseStillValid(state)) return
                const cursor = snapshot.at, anchor = await resolveLinewiseAnchor(snapshot)
                if (anchor === null) return
                range = linewiseRange(snapshot, op, anchor, cursor)
                moveSnapshotCaret(snapshot, range.start)
                repeatMotion(() => sendKeyEvent("right", { shift: true }), range.end - range.start)
                empty = range.start === range.end
            }
        }, 500)
        if (empty === undefined || !linewiseStillValid(state)) return
        clearLinewiseSelection()
        mode = "visual"
        visualModel = range ? { text: snapshot.text, a: range.start, c: Math.max(range.start, range.end - 1), dA: range.start, dF: range.end, fullDocument: true } : null
        nativeVisualFocusAfter = true
        activeProbeRestore = empty ? null : () => sendKeyEvent("left")
        if (op === "p") { mode = "normal"; await pasteRegister(pendingRegister); pendingRegister = null; switchModeToNormal() }
        else if (empty) {
            if (op === "c") switchModeToInsert()
            else switchModeToNormal()
        } else await runLongStringOp(op)
    } finally { activeProbeRestore = null; releaseOracle() }
}

async function linewiseToCharwise() {
    if (!linewiseState || !beginOracle()) return
    try {
        const state = linewiseState
        await withViewportPreserved(async () => {
            const snapshot = await getTextSnapshot()
            if (!snapshot || !linewiseStillValid(state)) return
            const at = DocsKeysVim.cursor(snapshot.text, snapshot.at), anchor = await resolveLinewiseAnchor(snapshot)
            if (anchor === null) return
            const nativeAt = snapshot.at
            clearLinewiseSelection()
            mode = "visual"
            visualModel = { text: snapshot.text, a: anchor, c: at, dA: nativeAt, dF: nativeAt, fullDocument: true }
            visualSetSelection(anchor, at)
            updateModeIndicator(mode)
        }, 500)
    } finally { releaseOracle() }
}

async function swapLinewiseCursor() {
    if (!linewiseState || !beginOracle()) return
    try {
        const state = linewiseState, row = linewiseCursorRow()
        if (!row) return
        await withViewportPreserved(async () => {
            if (!linewiseStillValid(state) || !await seekLinewisePoint({ point: state.point, height: state.height })) return
            state.anchorIndex = undefined
            state.point = row.point
            state.height = row.height
            revealReadDestination()
        }, 500)
    } finally { releaseOracle() }
}

function handleLinewiseKey(key) {
    const edge = linewiseState && linewiseState.edge
    if ((key === "h" && edge === "start") || (key === "l" && edge === "end")) return
    if (linewiseState) linewiseState.edge = null
    if (linewiseState && key !== "j" && key !== "k") linewiseState.goal = null
    if (key === "V") { clearLinewiseSelection(); switchModeToNormal(); return }
    if (key === "v") { linewiseToCharwise(); return }
    if (key === "o" || key === "O") { swapLinewiseCursor(); return }
    if (key === "j" || key === "k") { linewiseMoveVertical(key === "j"); return }
    if (key === "h" || key === "l") { normalNavigation(key); return }
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
