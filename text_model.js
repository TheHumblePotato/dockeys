// On-demand plain-text snapshots. No background reads or native-word
// guesses: both speed modes use the same Vim rules and differ only in cache age.
let textSnapshot = null
let textRevision = 0
let managedTextMotion = 0
let viewportRead = null
let viewportEpoch = 0
let scrollIntentRevision = 0

function invalidateTextSnapshot() {
    textSnapshot = null
    textRevision++
    invalidateRenderedReader()
}

function invalidateExternalText() {
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
    token.el.scrollTop = token.top
    token.el.scrollLeft = token.left
}

async function withViewportPreserved(fn) {
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
    try { return await withReadPresentation(fn) }
    finally {
        restoreReadViewport(token)
        viewportRead = null
        if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => {
            // A later intentional motion owns its scrolling. A read's final
            // layout pass may otherwise pull a freely scrolled view back.
            if (viewportEpoch === token.epoch) restoreReadViewport(token)
        })
    }
}

function withScrollPriority(epoch, fn) {
    // A wheel/touch gesture after the command began takes precedence over
    // that command's delayed caret scrolling. A later keypress can reveal
    // the cursor again normally.
    return epoch === scrollIntentRevision ? fn() : withViewportPreserved(fn)
}

async function readDocumentSide(forward, previous) {
    const origin = cursorDocumentPoint()
    if (forward) goToDocEnd(true)
    else goToDocStart(true)
    const moved = comparePoints(origin, cursorDocumentPoint())
    const text = await copySelectionForOracle(previous)
    if (text === null || (text === "" && moved !== null && moved !== 0)) {
        if (moved !== 0) sendKeyEvent(forward ? "left" : "right")
        return null
    }
    if (text.length) sendKeyEvent(forward ? "left" : "right")
    return text.replace(/\r\n?|[\u000b\u2028\u2029]/g, "\n")
}

function snapshotUsable() {
    if (!textSnapshot || textSnapshot.revision !== textRevision) return false
    const maxAge = settings.wordMotion === "native" ? 2500 : 500
    const point = cursorDocumentPoint()
    return Date.now() - textSnapshot.created <= maxAge &&
        (!point || comparePoints(textSnapshot.point, point) === 0)
}

async function getTextSnapshot(force = false) {
    if (!force && snapshotUsable() && !textSnapshot.partial) return textSnapshot
    if (settings.readStrategy === "rendered") return null
    const result = await withViewportPreserved(() => withClipboardSaved(async (previous) => {
        if (previous === null) return null
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

function wordSnapshotCovers(snapshot, kind, WORD, count) {
    const result = DocsKeysVim.word(snapshot.text, snapshot.at, kind, count, WORD)
    return kind === "b" || kind === "ge"
        ? result.target > 0 || snapshot.completeStart || !snapshot.partial
        : result.boundary < snapshot.text.length || snapshot.completeEnd || !snapshot.partial
}

async function readBoundedSide(forward, previous, lines) {
    const origin = cursorDocumentPoint()
    const edge = forward ? "end" : "home"
    sendKeyEvent(edge, { shift: true })
    for (let i = 1; i < lines; i++) {
        sendKeyEvent(forward ? "right" : "left", { shift: true })
        sendKeyEvent(edge, { shift: true })
    }
    const moved = comparePoints(origin, cursorDocumentPoint())
    const text = await copySelectionForOracle(previous)
    if (text === null) {
        if (moved !== 0) sendKeyEvent(forward ? "left" : "right")
        return null
    }
    if (text.length) sendKeyEvent(forward ? "left" : "right")
    return text.replace(/\r\n?|[\u000b\u2028\u2029]/g, "\n")
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
            const before = backwards ? await readBoundedSide(false, previous, lines) : ""
            if (before === null) return null
            const after = await readBoundedSide(true, previous, lines)
            if (after === null) return null
            const value = { text: toGraphemes(before + after), at: toGraphemes(before).length,
                partial: true, completeStart: backwards && before === previousBefore,
                completeEnd: after === previousAfter, windowLines: lines,
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
    try { visualMoveCaret(snapshot.at, target) }
    finally { managedTextMotion-- }
    snapshot.at = target
    snapshot.point = cursorDocumentPoint()
    rememberCursorText(snapshot)
}

async function applySnapshotRange(snapshot, range, operator) {
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

async function snapshotWordMotion(kind, WORD, count, operator) {
    if (!beginOracle()) return
    const epoch = scrollIntentRevision
    try {
        let snapshot = operator ? await getTextSnapshot(true) : await getWordSnapshot(kind, WORD, count)
        if (!snapshot) { switchModeToNormal(); return }
        let at = DocsKeysVim.cursor(snapshot.text, snapshot.at)
        await withScrollPriority(epoch, async () => {
          moveSnapshotCaret(snapshot, at)
          if (operator) {
            const range = DocsKeysVim.wordRange(snapshot.text, at, kind, count, WORD, operator)
            if (operator !== "y") recordChange(() => snapshotWordMotion(kind, WORD, count, operator))
            await applySnapshotRange(snapshot, range, operator)
          } else {
            moveSnapshotCaret(snapshot, DocsKeysVim.word(snapshot.text, at, kind, count, WORD).target)
            switchModeToNormal()
          }
        })
    } finally { releaseOracle() }
}

async function recoverVisualSnapshot(known = null) {
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
    if (!snapshot) return null
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
        const model = await completeVisualSnapshot()
        if (model) visualMoveCursor(DocsKeysVim.word(model.text, model.c, kind, count, WORD, true).target)
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
    visualMoveCursor(Math.min(target.start + goal, Math.max(target.start, target.end - 1)))
    m.goal = goal
}

// Wheel intent is accumulated independently of temporary caret auto-scrolling.
// Neither a text read nor its final layout may overwrite the user's scroll.
if (typeof document.addEventListener === "function") {
    document.addEventListener("wheel", (event) => {
        if (event.isTrusted === false || event.ctrlKey || event.metaKey) return
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
        touchY = event.touches && event.touches[0] ? event.touches[0].clientY : null
        if (!viewportRead) viewportEpoch++
    }, { passive: true, capture: true })
    document.addEventListener("touchmove", (event) => {
        const y = event.touches && event.touches[0] ? event.touches[0].clientY : null
        viewportEpoch++
        scrollIntentRevision++
        if (viewportRead && y !== null && touchY !== null) {
            viewportRead.top += touchY - y
            viewportRead.epoch = viewportEpoch
        }
        touchY = y
    }, { passive: true, capture: true })
    document.addEventListener("pointerdown", () => { if (!viewportRead) viewportEpoch++ }, true)
    document.addEventListener("beforeinput", (event) => {
        if (event.isTrusted !== false) invalidateExternalText()
    }, true)
}
