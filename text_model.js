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
            const owner = record.target.closest && record.target.closest(".kix-cursor")
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
            if (record.target.closest && record.target.closest(".kix-selection-overlay")) return false
            if (record.type === "childList") {
                const changed = [...record.addedNodes, ...record.removedNodes]
                return changed.some((node) => !node.closest || !node.closest(".kix-cursor, .kix-selection-overlay"))
            }
            return true
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
    try { return await fn() }
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

async function getWordSnapshot(kind) {
    if (snapshotUsable()) return textSnapshot
    if (kind === "b" || kind === "ge") return getTextSnapshot()
    // A forward motion needs only the suffix. Avoid copying an empty prefix
    // at BOD and halve the first-read clipboard work. Read a complete snapshot
    // lazily if a later backward motion reaches this suffix's unknown start.
    const after = await withViewportPreserved(() => withClipboardSaved((previous) => readDocumentSide(true, previous)))
    if (after === null) return null
    textSnapshot = { text: toGraphemes(after), at: 0, partial: true,
        created: Date.now(), revision: textRevision, point: cursorDocumentPoint() }
    return textSnapshot
}

function moveSnapshotCaret(snapshot, target) {
    managedTextMotion++
    try { visualMoveCaret(snapshot.at, target) }
    finally { managedTextMotion-- }
    snapshot.at = target
    snapshot.point = cursorDocumentPoint()
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
        let snapshot = operator ? await getTextSnapshot(true) : await getWordSnapshot(kind)
        if (!snapshot) { switchModeToNormal(); return }
        let at = DocsKeysVim.cursor(snapshot.text, snapshot.at)
        if (snapshot.partial && (kind === "b" || kind === "ge") &&
            DocsKeysVim.word(snapshot.text, at, kind, count, WORD).target === 0) {
            snapshot = await getTextSnapshot(true)
            if (!snapshot) { switchModeToNormal(); return }
            at = DocsKeysVim.cursor(snapshot.text, snapshot.at)
        }
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

async function recoverVisualSnapshot() {
    if (visualModel) return visualModel
    const selected = await withViewportPreserved(() => withClipboardSaved((previous) => copySelectionForOracle(previous)))
    if (selected === null) return null
    const length = toGraphemes(selected).length
    const forward = nativeVisualFocusAfter
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

async function visualSnapshotWord(kind, WORD, count = 1) {
    if (visualModel) {
        visualMoveCursor(DocsKeysVim.word(visualModel.text, visualModel.c, kind, count, WORD, true).target)
        return
    }
    if (!beginOracle()) return
    try {
        const model = await recoverVisualSnapshot()
        if (model) visualMoveCursor(DocsKeysVim.word(model.text, model.c, kind, count, WORD, true).target)
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
