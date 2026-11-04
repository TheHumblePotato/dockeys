let gPrefixState = null
let operatorPrefixCount = 1

function startGPrefix(count = 1, operator = null, returnMode = mode) {
    gPrefixState = { count, operator, returnMode }
    mode = "gPrefix"
    updateModeIndicator(mode)
}

function handleGPrefix(key) {
    const state = gPrefixState
    gPrefixState = null
    mode = state.returnMode
    if (mode === "visualLine" && key !== "g") { updateModeIndicator(mode); return }
    if (key === "e" || key === "E") {
        if (mode === "visual") visualSnapshotWord("ge", key === "E", state.count)
        else snapshotWordMotion("ge", key === "E", state.count, state.operator)
    } else if (key === "g") gotoTextLine(state.count, state.operator, state.returnMode)
    else if (key === "_") lastNonblankMotion(state.count, state.operator, state.returnMode)
    else if (key === "j" || key === "k") {
        if (mode === "visual") visualNativeMotion(key === "j", () => {
            repeatMotion(() => nativeVerticalStep(key === "j", true), state.count)
        })
        else if (!state.operator) repeatMotion(() => nativeVerticalStep(key === "j"), state.count)
    } else {
        pendingRegister = null
        pendingRegisterAppend = false
        if (state.operator) switchModeToNormal()
    }
    updateModeIndicator(mode)
}

async function gotoTextLine(count, operator = null, returnMode = mode) {
    if (returnMode === "visualLine") {
        if (count === 1) vlGoto(false)
        else if (count === null) vlGoto(true)
        return
    }
    if (!beginOracle()) return
    try {
        const snapshot = returnMode === "visual"
            ? (visualModel || await recoverVisualSnapshot()) : await getTextSnapshot(!!operator)
        if (!snapshot) return
        const text = snapshot.text, at = returnMode === "visual" ? snapshot.c : snapshot.at
        const starts = [0]
        for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1)
        const targetStart = count === null ? starts[starts.length - 1] : starts[Math.min(starts.length, Math.max(1, count)) - 1]
        const bounds = DocsKeysVim.line(text, targetStart)
        // Neovim defaults to 'nostartofline': gg/G preserve the column.
        const column = at - DocsKeysVim.line(text, at).start
        const target = Math.min(bounds.start + column, Math.max(bounds.start, bounds.end - 1))
        if (operator) {
            const current = DocsKeysVim.line(text, at)
            const first = Math.min(current.start, bounds.start)
            const last = Math.max(current.end, bounds.end)
            const end = operator === "c" ? last : Math.min(text.length, last + 1)
            const start = operator === "d" && last === text.length && first > 0 ? first - 1 : first
            if (operator !== "y") recordChange(() => gotoTextLine(count, operator))
            await applySnapshotRange(snapshot, { start, end }, operator)
        } else if (returnMode === "visual") visualMoveCursor(target)
        else { moveSnapshotCaret(snapshot, target); switchModeToNormal() }
    } finally { releaseOracle() }
}

async function lastNonblankMotion(count, operator, returnMode) {
    if (!beginOracle()) return
    try {
        const snapshot = returnMode === "visual" ? (visualModel || await recoverVisualSnapshot()) : await getTextSnapshot(!!operator)
        if (!snapshot) return
        const at = returnMode === "visual" ? snapshot.c : snapshot.at
        let bounds = DocsKeysVim.line(snapshot.text, at)
        for (let n = 1; n < count && bounds.end < snapshot.text.length; n++) bounds = DocsKeysVim.line(snapshot.text, bounds.end + 1)
        let end = bounds.end
        while (end > bounds.start && DocsKeysVim.blank(snapshot.text[end - 1])) end--
        const target = Math.max(bounds.start, end - 1)
        if (operator) {
            if (bounds.start === bounds.end) { switchModeToNormal(); return }
            if (operator !== "y") recordChange(() => lastNonblankMotion(count, operator, "normal"))
            await applySnapshotRange(snapshot, { start: Math.min(at, target), end: Math.min(snapshot.text.length, Math.max(at, target) + 1) }, operator)
        } else if (returnMode === "visual") visualMoveCursor(target)
        else { moveSnapshotCaret(snapshot, target); switchModeToNormal() }
    } finally { releaseOracle() }
}
