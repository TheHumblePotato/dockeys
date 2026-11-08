// On-demand plain-text snapshots. No background reads or native-word
// guesses: both speed modes use the same Vim rules and differ only in cache age.
let textSnapshot = null
let textRevision = 0
let documentRevision = 0
let managedTextMotion = 0
let viewportRead = null
let viewportEpoch = 0
let scrollIntentRevision = 0
let editViewport = null
let editViewportTimer = null

// Editing has its own viewport lease: it must cover native selection, Copy,
// Backspace, browser anchoring, and delayed Docs layout without hiding text.
function cancelEditViewport() {
    if (!editViewport && !editViewportTimer) return
    editViewport = null
    clearTimeout(editViewportTimer)
    editViewportTimer = null
    window.dispatchEvent(new CustomEvent("doc-keys-edit-phase", { detail: { active: false } }))
}

function restoreEditViewport() {
    if (!editViewport) return
    for (const saved of editViewport.positions) {
        saved.el.scrollTop = saved.top
        saved.el.scrollLeft = saved.left
    }
}

function preserveEditViewport() {
    if (editViewport) { editViewport.until = Date.now() + 500; return }
    const el = getDocsScrollContainer()
    if (!el) return
    const nodes = new Set([el])
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        if (parent.scrollHeight > parent.clientHeight || parent.scrollWidth > parent.clientWidth) nodes.add(parent)
    }
    if (document.scrollingElement) nodes.add(document.scrollingElement)
    const token = editViewport = { until: Date.now() + 500, deadline: Date.now() + 8500,
        positions: Array.from(nodes, (node) => ({ el: node,
            top: node === viewportRead?.el ? viewportRead.top : node.scrollTop || 0,
            left: node === viewportRead?.el ? viewportRead.left : node.scrollLeft || 0 })) }
    window.dispatchEvent(new CustomEvent("doc-keys-edit-phase", { detail: { active: true } }))
    const tick = () => {
        if (editViewport !== token) return
        if (Date.now() >= token.deadline || (!oracleBusy && Date.now() >= token.until)) { cancelEditViewport(); return }
        if (oracleBusy) token.until = Date.now() + 500
        restoreEditViewport()
        if (typeof requestAnimationFrame !== "function") editViewportTimer = setTimeout(tick, 16)
        else {
            let done = false
            const next = () => { if (!done) { done = true; clearTimeout(timer); tick() } }
            const timer = editViewportTimer = setTimeout(next, 32)
            requestAnimationFrame(next)
        }
    }
    tick()
}

function invalidateTextSnapshot() {
    textSnapshot = null
    textRevision++
    invalidateRenderedReader()
}

function invalidateExternalText() {
    documentRevision++
    invalidateTextSnapshot()
    if (typeof mode !== "undefined" && mode === "visual") visualModel = null
}

function trackDocumentChanges() {
    if (typeof MutationObserver !== "function") return
    const editor = document.querySelector(".kix-appview-editor")
    if (!editor) return
    const observer = new MutationObserver((records) => {
        if (oracleBusy) return
        const relevant = records.some((record) => {
            const node = record.target.nodeType === 3 ? record.target.parentElement : record.target
            const owner = node && node.closest && node.closest(".kix-cursor")
            if (record.type === "attributes") {
                const name = owner && owner.querySelector(".kix-cursor-name")
                if (!name || !name.textContent.trim()) return false
                // Blink/opacity changes do not invalidate text. A remote
                // cursor moving is a conservative signal of a possible edit.
                const before = record.oldValue || "", after = record.target.getAttribute("style") || ""
                const positions = (style) => (style.match(/(?:^|;)\s*(?:left|top|transform)\s*:[^;]*/g) || []).join(";")
                return positions(before) !== positions(after)
            }
            if (owner) return false
            if (node && node.closest && node.closest(".kix-selection-overlay, [aria-live], .kix-accessibility")) return false
            // Tile recycling and selection DOM updates are rendering, not
            // evidence that the document changed. Invalidating here made
            // every visual motion trigger another whole-document read.
            if (record.type === "childList") return false
            return record.type === "characterData" && !!(node && node.closest && node.closest(".kix-lineview-content, .kix-wordhtmlgenerator-word-node"))
        })
        if (relevant) invalidateExternalText()
    })
    observer.observe(editor, { subtree: true, characterData: true, childList: true,
        attributes: true, attributeFilter: ["style"], attributeOldValue: true })
}

function restoreReadViewport(token = viewportRead) {
    if (!token || !token.el) return
    const edited = editViewport?.positions.find((saved) => saved.el === token.el)
    token.el.scrollTop = edited?.top ?? token.top
    token.el.scrollLeft = edited?.left ?? token.left
}

async function withViewportPreserved(fn, settleMs = 80) {
    if (viewportRead) return fn()
    const el = getDocsScrollContainer()
    const token = { el, top: el ? el.scrollTop : 0, left: el ? (el.scrollLeft || 0) : 0, epoch: viewportEpoch }
    viewportRead = token
    const keepView = () => {
        if (viewportRead !== token) return
        restoreReadViewport(token)
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(keepView)
    }
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(keepView)
    try { return await withReadPresentation(fn, settleMs) }
    finally {
        if (viewportRead === token) {
            restoreReadViewport(token)
            viewportRead = null
        }
        if (typeof requestAnimationFrame === "function") {
            const until = Date.now() + settleMs
            const settle = () => {
                // A newer key/wheel gesture owns its scrolling. Otherwise
                // protect more than one frame of delayed Docs layout work.
                if (viewportEpoch !== token.epoch || viewportRead) return
                restoreReadViewport(token)
                if (Date.now() < until) requestAnimationFrame(settle)
            }
            requestAnimationFrame(settle)
        }
    }
}

// Docs paints its caret/selection asynchronously. In particular, the rectangle
// immediately after Ctrl+Shift+End may still describe the original caret.
function waitForEditorPaint() {
    if (typeof requestAnimationFrame !== "function") return Promise.resolve()
    return new Promise((resolve) => {
        let done = false
        const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve() } }
        const timer = setTimeout(finish, 32)
        requestAnimationFrame(finish)
    })
}

async function readSelectedSide(origin, forward, previous) {
    const scrollIntent = scrollIntentRevision
    await waitForEditorPaint()
    const text = await copySelectionForOracle(previous)
    if (oracleAbort && oracleAbort.signal.aborted) return null
    // Measure after Copy settles, not before the editor updates its selection.
    const focus = cursorDocumentPoint()
    const moved = comparePoints(origin, focus)
    if ((text && text.length) || moved !== 0) {
        sendKeyEvent(forward ? "left" : "right")
        await waitForEditorPaint()
    }
    // A timed-out Copy is not proof of an empty buffer. Never build a model
    // from it with the caret stranded at the probe's far endpoint.
    if (text === null || (text === "" && moved !== 0)) return null
    let restored = comparePoints(origin, cursorDocumentPoint())
    if (scrollIntent === scrollIntentRevision && restored !== null && restored !== 0) {
        if (!text) return null
        // Some menu paths collapse the selection themselves. In that case the
        // collapse arrow above was a character step. Undo it, then return from
        // the copied endpoint by its exact grapheme count if still necessary.
        sendKeyEvent(forward ? "right" : "left")
        await waitForEditorPaint()
        restored = comparePoints(origin, cursorDocumentPoint())
        if (restored !== 0 && comparePoints(focus, cursorDocumentPoint()) === 0) {
            repeatMotion(() => sendKeyEvent(forward ? "left" : "right"), toGraphemes(text).length)
            await waitForEditorPaint()
            restored = comparePoints(origin, cursorDocumentPoint())
        }
        if (restored !== null && restored !== 0) return null
    }
    return text.replace(/\r\n?|[\u000b\u2028\u2029]/g, "\n")
}

function withScrollPriority(epoch, fn) {
    // A wheel/touch gesture after the command began takes precedence over
    // that command's delayed caret scrolling. A later keypress can reveal
    // the cursor again normally.
    return epoch === scrollIntentRevision ? fn() : withViewportPreserved(fn)
}

async function readDocumentSide(forward, previous) {
    const origin = cursorDocumentPoint()
    activeProbeRestore = () => restoreAbortedProbe(origin, forward)
    if (forward) goToDocEnd(true)
    else goToDocStart(true)
    try { return await readSelectedSide(origin, forward, previous) }
    finally { activeProbeRestore = null }
}

async function restoreAbortedProbe(origin, forward) {
    const revision = probeCleanupRevision
    if (comparePoints(origin, cursorDocumentPoint()) === 0) await waitForEditorPaint()
    if (revision !== probeCleanupRevision) return
    if (comparePoints(origin, cursorDocumentPoint()) !== 0) sendKeyEvent(forward ? "left" : "right")
}

function snapshotUsable() {
    if (!textSnapshot || textSnapshot.revision !== textRevision) return false
    const maxAge = settings.wordMotion === "native" ? 2500 : 500
    const point = cursorDocumentPoint()
    return Date.now() - textSnapshot.created <= maxAge &&
        !!point && comparePoints(textSnapshot.point, point) === 0
}

async function getTextSnapshot(force = false) {
    if (!force && snapshotUsable() && !textSnapshot.partial) return textSnapshot
    if (settings.readStrategy === "rendered") return null
    const result = await withViewportPreserved(() => withClipboardSaved(async (previous) => {
        if (previous === null) return null
        await waitForEditorPaint()
        const before = await readDocumentSide(false, previous)
        if (before === null) return null
        const after = await readDocumentSide(true, previous)
        if (after === null) return null
        return { text: toGraphemes(before + after), at: toGraphemes(before).length }
    }))
    if (!result) return null
    textSnapshot = { ...result, created: Date.now(), revision: textRevision, point: cursorDocumentPoint() }
    return textSnapshot
}

function knownParagraphStart(snapshot, kind, WORD, count) {
    if (kind !== "b" || !snapshot.paragraphStart || snapshot.at <= 0 ||
        (DocsKeysVim.blank(snapshot.text[0]) && !DocsKeysVim.emptyLine(snapshot.text, 0))) return false
    let at = snapshot.at
    for (let n = 0; n < count; n++) {
        const target = DocsKeysVim.word(snapshot.text, at, kind, 1, WORD).target
        if (target === 0) return n === count - 1
        if (target >= at) return false
        at = target
    }
    return false
}

function wordSnapshotCovers(snapshot, kind, WORD, count) {
    const result = DocsKeysVim.word(snapshot.text, snapshot.at, kind, count, WORD)
    return kind === "b" || kind === "ge"
        ? result.target > 0 || knownParagraphStart(snapshot, kind, WORD, count) || snapshot.completeStart || !snapshot.partial
        : result.boundary < snapshot.text.length || snapshot.completeEnd || !snapshot.partial
}

async function readBoundedSide(forward, previous, lines) {
    const origin = cursorDocumentPoint()
    activeProbeRestore = () => restoreAbortedProbe(origin, forward)
    const edge = forward ? "end" : "home"
    sendKeyEvent(edge, { shift: true })
    for (let i = 1; i < lines; i++) {
        // Native vertical movement crosses wrapped rows where Right/Left at
        // a rendered EOL can remain on the same visual boundary in Docs.
        sendKeyEvent(forward ? "down" : "up", { shift: true })
        sendKeyEvent(edge, { shift: true })
    }
    try { return await readSelectedSide(origin, forward, previous) }
    finally { activeProbeRestore = null }
}

async function getWordSnapshot(kind, WORD = false, count = 1) {
    if (snapshotUsable() && wordSnapshotCovers(textSnapshot, kind, WORD, count)) return textSnapshot
    const rendered = renderedWordSnapshot(kind, WORD, count)
    if (rendered) { textSnapshot = rendered; return rendered }
    if (settings.readStrategy === "rendered") return null
    const backwards = kind === "b" || kind === "ge"
    let previousBefore = null, previousAfter = null
    for (let lines = 2; lines <= 32; lines *= 2) {
        const snapshot = await withViewportPreserved(() => withClipboardSaved(async (previous) => {
            if (previous === null) return null
            await waitForEditorPaint()
            const before = backwards ? await readBoundedSide(false, previous, lines) : ""
            if (before === null) return null
            const after = await readBoundedSide(true, previous, lines)
            if (after === null) return null
            const value = { text: toGraphemes(before + after), at: toGraphemes(before).length,
                partial: true, completeStart: backwards && (before === "" || before === previousBefore),
                completeEnd: after === "" || after === previousAfter, windowLines: lines,
                created: Date.now(), revision: textRevision, point: cursorDocumentPoint() }
            previousBefore = before
            previousAfter = after
            return value
        }))
        if (!snapshot) return null
        if (wordSnapshotCovers(snapshot, kind, WORD, count)) { textSnapshot = snapshot; return snapshot }
    }
    // Very large counts may genuinely need more context. Keep the explicit
    // fallback masked; ordinary word motions never select the document tail.
    return getTextSnapshot(true)
}

function moveSnapshotCaret(snapshot, target) {
    managedTextMotion++
    try {
        const direct = Math.abs(target - snapshot.at)
        const fromStart = snapshot.completeStart || !snapshot.partial ? target + 1 : Infinity
        const fromEnd = snapshot.completeEnd || !snapshot.partial ? snapshot.text.length - target + 1 : Infinity
        if (fromStart + 32 < direct && fromStart <= fromEnd) {
            goToDocStart()
            visualMoveCaret(0, target)
        } else if (fromEnd + 32 < direct) {
            goToDocEnd()
            visualMoveCaret(snapshot.text.length, target)
        } else visualMoveCaret(snapshot.at, target)
    }
    finally { managedTextMotion-- }
    snapshot.at = target
    snapshot.point = cursorDocumentPoint()
    rememberCursorText(snapshot)
}

async function applySnapshotRange(snapshot, range, operator) {
    if (operator === "d" || operator === "c") preserveEditViewport()
    if (range.end <= range.start) {
        pendingRegister = null
        pendingRegisterAppend = false
        if (operator === "c") switchModeToInsert()
        else switchModeToNormal()
        return
    }
    moveSnapshotCaret(snapshot, range.start)
    repeatMotion(() => sendKeyEvent("right", { shift: true }), range.end - range.start)
    invalidateTextSnapshot()
    await runLongStringOp(operator)
}

async function snapshotWordMotion(kind, WORD, count, operator, returnMode = mode === "visualLine" ? "visualLine" : "normal") {
    if (!beginOracle()) return
    if (returnMode === "visualLine" && linewiseState) linewiseState.goal = null
    const epoch = scrollIntentRevision
    try {
        let snapshot = operator ? await getTextSnapshot(true) : await getWordSnapshot(kind, WORD, count)
        if (!snapshot) { finishFind(returnMode); return }
        let at = returnMode === "visualLine" ? snapshot.at : DocsKeysVim.cursor(snapshot.text, snapshot.at)
        await withScrollPriority(epoch, async () => {
          moveSnapshotCaret(snapshot, at)
          if (operator) {
            const range = DocsKeysVim.wordRange(snapshot.text, at, kind, count, WORD, operator)
            if (operator !== "y") recordChange(() => snapshotWordMotion(kind, WORD, count, operator))
            await applySnapshotRange(snapshot, range, operator)
          } else {
            moveSnapshotCaret(snapshot, DocsKeysVim.word(snapshot.text, at, kind, count, WORD, returnMode === "visualLine").target)
            await waitForEditorPaint()
            if (oracleAbort && oracleAbort.signal.aborted) return
            const rendered = settings.readStrategy !== "clipboard" && renderedContextAtCaret()
            if (rendered) textSnapshot = rendered
            else snapshot.point = cursorDocumentPoint()
            finishFind(returnMode)
          }
        })
    } finally { releaseOracle() }
}

async function recoverVisualSnapshot(known = null) {
    return withViewportPreserved(() => recoverVisualSnapshotCore(known))
}

async function recoverVisualSnapshotCore(known = null) {
    if (visualModel && !known) return visualModel
    if (settings.readStrategy === "rendered") return null
    const selected = known ? null : await withViewportPreserved(() => withClipboardSaved((previous) => copySelectionForOracle(previous)))
    if (!known && selected === null) return null
    const length = known ? Math.abs(known.c - known.a) + 1 : toGraphemes(selected).length
    const forward = known ? known.c >= known.a : nativeVisualFocusAfter
    visualModel = null
    if (length) {
        sendKeyEvent(forward ? "right" : "left")
        if (forward) sendKeyEvent("left")
    }
    const snapshot = await getTextSnapshot(true)
    if (!snapshot) {
        if (oracleAbort && oracleAbort.signal.aborted) return null
        if (known) {
            visualModel = { ...known, dA: known.c, dF: known.c }
            visualSetSelection(known.a, known.c)
        } else if (length) {
            // Reading failed after collapsing a native selection. Rebuild its
            // original orientation from the already-copied grapheme count.
            repeatMotion(() => sendKeyEvent(forward ? "left" : "right"), forward ? length - 1 : length)
            repeatMotion(() => sendKeyEvent(forward ? "right" : "left", { shift: true }), length)
        }
        return null
    }
    const at = DocsKeysVim.cursor(snapshot.text, snapshot.at)
    moveSnapshotCaret(snapshot, at)
    const anchor = at + (forward ? -1 : 1) * Math.max(0, length - 1)
    visualModel = { text: snapshot.text, a: at, c: at, dA: at, dF: at, fullDocument: true }
    visualSetSelection(anchor, at)
    return visualModel
}

async function completeVisualSnapshot() {
    if (visualModel && !visualModel.partial) return visualModel
    return recoverVisualSnapshot(visualModel)
}

async function visualSnapshotWord(kind, WORD, count = 1) {
    if (visualModel && (!visualModel.partial || wordSnapshotCovers({ ...visualModel, at: visualModel.c }, kind, WORD, count))) {
        visualMoveCursor(DocsKeysVim.word(visualModel.text, visualModel.c, kind, count, WORD, true).target)
        return
    }
    if (!beginOracle()) return
    try {
        await withViewportPreserved(async () => {
            const model = await completeVisualSnapshot()
            if (model) visualMoveCursor(DocsKeysVim.word(model.text, model.c, kind, count, WORD, true).target)
        })
    } finally { releaseOracle() }
}

async function completeVisualThen(key) {
    if (settings.readStrategy === "rendered" || !beginOracle()) return
    try {
        const model = await completeVisualSnapshot()
        if (model) handleKeyEventVisualLine(key)
    } finally { releaseOracle() }
}

function visualSnapshotVertical(down) {
    const m = visualModel
    const bounds = DocsKeysVim.line(m.text, m.c)
    if (m.goal === undefined) m.goal = m.c - bounds.start
    if ((down && bounds.end === m.text.length) || (!down && bounds.start === 0)) return
    const target = DocsKeysVim.line(m.text, down ? bounds.end + 1 : bounds.start - 1)
    const goal = m.goal
    // Visual permits the paragraph-break position on a short line. Normal
    // mode's last-character clamp would omit that valid inclusive endpoint.
    visualMoveCursor(Math.min(target.start + goal, target.end))
    m.goal = goal
}

async function visualLogicalVertical(down, count) {
    if (!beginOracle()) return
    try {
        const model = await completeVisualSnapshot()
        if (model) repeatMotion(() => visualSnapshotVertical(down), count)
    } finally { releaseOracle() }
}

// Wheel intent is accumulated independently of temporary caret auto-scrolling.
// Neither a text read nor its final layout may overwrite the user's scroll.
if (typeof document.addEventListener === "function") {
    document.addEventListener("wheel", (event) => {
        if (event.isTrusted === false || event.ctrlKey || event.metaKey) return
        cancelEditViewport()
        if (!viewportRead) cancelReadScrollSettlement()
        scrollIntentRevision++
        viewportEpoch++
        if (viewportRead && viewportRead.el) {
            viewportRead.epoch = viewportEpoch
            const unit = event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? (viewportRead.el.clientHeight || 600) : 1
            viewportRead.top += (event.deltaY || 0) * unit
            viewportRead.left += (event.deltaX || 0) * unit
        }
    }, { passive: true, capture: true })
    let touchY = null
    document.addEventListener("touchstart", (event) => {
        cancelEditViewport()
        touchY = event.touches && event.touches[0] ? event.touches[0].clientY : null
        if (!viewportRead) { viewportEpoch++; cancelReadScrollSettlement() }
    }, { passive: true, capture: true })
    document.addEventListener("touchmove", (event) => {
        if (!viewportRead) cancelReadScrollSettlement()
        const y = event.touches && event.touches[0] ? event.touches[0].clientY : null
        viewportEpoch++
        scrollIntentRevision++
        if (viewportRead && y !== null && touchY !== null) {
            viewportRead.top += touchY - y
            viewportRead.epoch = viewportEpoch
        }
        touchY = y
    }, { passive: true, capture: true })
    document.addEventListener("pointerdown", () => {
        if (!viewportRead) { viewportEpoch++; cancelReadScrollSettlement() }
    }, true)
    document.addEventListener("beforeinput", (event) => {
        if (event.isTrusted !== false) invalidateExternalText()
    }, true)
}
