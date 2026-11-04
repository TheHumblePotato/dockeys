// A literal search command line that keeps focus in Docs' input iframe.
// Search text is raw OS-layout text, never translated through the command map.
let searchState = null
let lastSearch = null
let searchOverlay = null
let pendingSearchCount = 1
const searchHistory = []

function rememberSearch(pattern) {
    const previous = searchHistory.indexOf(pattern)
    if (previous >= 0) searchHistory.splice(previous, 1)
    searchHistory.push(pattern)
    if (searchHistory.length > 50) searchHistory.shift()
}

function showSearchLine(text) {
    if (!searchOverlay) {
        searchOverlay = document.createElement("div")
        Object.assign(searchOverlay.style, {
            position: "fixed", bottom: "20px", left: "20px", maxWidth: "70vw",
            padding: "8px 12px", fontFamily: "monospace", whiteSpace: "pre-wrap",
            background: "#202124", color: "white", borderRadius: "4px",
            zIndex: "10000", pointerEvents: "none", overflowWrap: "anywhere",
        })
        if (searchOverlay.setAttribute) {
            searchOverlay.setAttribute("role", "status")
            searchOverlay.setAttribute("aria-live", "polite")
        }
        document.body.appendChild(searchOverlay)
    }
    searchOverlay.textContent = text
    searchOverlay.style.display = "block"
}

function hideSearchLine() {
    if (searchOverlay) searchOverlay.style.display = "none"
}

function startSearch(forward, operator = null, count = 1, returnMode = mode) {
    searchState = { forward, operator, count, returnMode, query: "", historyIndex: searchHistory.length, draft: "" }
    mode = "search"
    showSearchLine(forward ? "/" : "?")
    updateModeIndicator(mode)
}

function cancelSearch() {
    const state = searchState
    searchState = null
    hideSearchLine()
    pendingRegister = null
    pendingRegisterAppend = false
    mode = state && !state.operator ? state.returnMode : "normal"
    updateModeIndicator(mode)
    finishTemporaryNormal()
}

function handleSearchInput(event) {
    const state = searchState
    if (!state) return
    if (event.key === "Escape" || (event.ctrlKey && event.key === "[")) { cancelSearch(); return }
    if (event.key === "Enter") {
        const pattern = state.query || (lastSearch && lastSearch.pattern)
        searchState = null
        mode = state.returnMode
        hideSearchLine()
        if (!pattern) { pendingRegister = null; switchModeToNormal(); return }
        const wholeWord = !state.query && lastSearch ? lastSearch.wholeWord : false
        rememberSearch(pattern)
        lastSearch = { pattern, forward: state.forward, wholeWord }
        performSearch(pattern, state.forward, state.count, state.operator, wholeWord, state.returnMode)
        return
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        if (state.historyIndex === searchHistory.length) state.draft = state.query
        state.historyIndex = Math.max(0, Math.min(searchHistory.length, state.historyIndex + (event.key === "ArrowUp" ? -1 : 1)))
        state.query = state.historyIndex === searchHistory.length ? state.draft : searchHistory[state.historyIndex]
        showSearchLine((state.forward ? "/" : "?") + state.query)
        return
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") {
        readClipboardSettled().then((text) => {
            if (searchState !== state) return
            state.query += text.replace(/\r\n?/g, "\n")
            showSearchLine((state.forward ? "/" : "?") + state.query)
        }).catch(() => showSearchLine("Could not paste the search text"))
        return
    }
    if (event.ctrlKey && event.key.toLowerCase() === "u") state.query = ""
    else if (event.ctrlKey && event.key.toLowerCase() === "w") state.query = state.query.replace(/\s*\S+\s*$/, "")
    else if (event.ctrlKey || event.metaKey || event.altKey) return
    else if (event.key === "Backspace") state.query = toGraphemes(state.query).slice(0, -1).join("")
    else if (toGraphemes(event.key).length === 1) state.query += event.key
    else return
    showSearchLine((state.forward ? "/" : "?") + state.query)
}

async function settleSearchLanding(snapshot, match) {
    await waitForEditorPaint()
    if (oracleAbort && oracleAbort.signal.aborted) return
    const context = renderedContextAtCaret()
    if (!context) { snapshot.point = cursorDocumentPoint(); return }
    const wanted = snapshot.text.slice(match.target, match.target + match.length).join("")
    if (context.text.slice(context.at, context.at + match.length).join("") !== wanted) {
        const nearby = []
        for (let delta = -2; delta <= 2; delta++) {
            const at = context.at + delta
            if (at >= 0 && context.text.slice(at, at + match.length).join("") === wanted) nearby.push(at)
        }
        if (nearby.length === 1) {
            moveSnapshotCaret(context, nearby[0])
            await waitForEditorPaint()
        }
    }
    textSnapshot = renderedContextAtCaret()
}

function revealReadDestination() {
    const token = viewportRead, caret = getCursorTop()
    if (!token?.el || !caret) return
    // Native caret reveal can race the restoration frame. Measure against
    // the intended viewport, never a transient scroll to a probe endpoint.
    restoreReadViewport(token)
    const rect = caret.getBoundingClientRect(), box = token.el.getBoundingClientRect?.()
    const top = box?.top || 0, bottom = box?.bottom || top + (token.el.clientHeight || window.innerHeight || 600)
    if (rect.top < top) token.top += rect.top - top
    else if (rect.bottom > bottom) token.top += rect.bottom - bottom
    restoreReadViewport(token)
}

async function performSearch(pattern, forward, count = 1, operator = null, wholeWord = false, returnMode = "normal") {
    if (!beginOracle()) return
    const epoch = scrollIntentRevision
    try { await withViewportPreserved(async () => {
        let snapshot
        if (returnMode === "visual") {
            const model = await completeVisualSnapshot()
            if (!model) return
            snapshot = { text: model.text, at: model.c }
        } else snapshot = await getTextSnapshot(!!operator)
        if (oracleAbort && oracleAbort.signal.aborted) return
        if (!snapshot) {
            showSearchLine("Search unavailable: could not read document text")
            return
        }
        let at = returnMode === "visualLine" ? snapshot.at : DocsKeysVim.cursor(snapshot.text, snapshot.at)
        if (pattern === null) {
            const line = DocsKeysVim.line(snapshot.text, at)
            let i = at
            while (i < line.end && DocsKeysVim.classify(snapshot.text[i]) !== "keyword") i++
            if (i === line.end) i = at
            if (DocsKeysVim.blank(snapshot.text[i])) return
            const type = DocsKeysVim.classify(snapshot.text[i])
            let start = i, end = i + 1
            while (start > line.start && DocsKeysVim.classify(snapshot.text[start - 1]) === type) start--
            while (end < line.end && DocsKeysVim.classify(snapshot.text[end]) === type) end++
            pattern = snapshot.text.slice(start, end).join("")
            at = start // */# skip the current word, including from its middle
            wholeWord = type === "keyword"
            lastSearch = { pattern, forward, wholeWord }
        }
        const match = DocsKeysVim.search(snapshot.text, at, pattern, forward, count, true, wholeWord)
        if (!match) {
            showSearchLine("Pattern not found: " + pattern)
            pendingRegister = null
            pendingRegisterAppend = false
            mode = returnMode
            updateModeIndicator(mode)
            return
        }
        await withScrollPriority(epoch, async () => {
          if (operator) {
            if (operator !== "y") recordChange(() => performSearch(pattern, forward, count, operator, wholeWord))
            const range = DocsKeysVim.exclusiveRange(snapshot.text, at, match.target, operator)
            await applySnapshotRange(snapshot, range, operator)
          } else if (returnMode === "visual") {
            visualMoveCursor(match.target)
            mode = "visual"
            updateModeIndicator(mode)
          } else {
            moveSnapshotCaret(snapshot, match.target)
            await settleSearchLanding(snapshot, match)
            finishFind(returnMode)
          }
        })
        if (match.wrapped) showSearchLine(forward ? "Search wrapped to top" : "Search wrapped to bottom")
        else hideSearchLine()
        await waitForEditorPaint()
        if (epoch === scrollIntentRevision) revealReadDestination()
    }, 500)
    } finally {
        if (operator && mode !== "insert" && mode !== "visual") switchModeToNormal()
        releaseOracle()
    }
}

function repeatSearch(reverse, count = 1, operator = null, returnMode = mode) {
    if (!lastSearch) {
        pendingRegister = null
        if (operator) switchModeToNormal()
        showSearchLine("No previous search")
        return
    }
    performSearch(lastSearch.pattern, reverse ? !lastSearch.forward : lastSearch.forward,
        count, operator, lastSearch.wholeWord, returnMode)
}

function searchWordUnderCursor(forward, count = 1, returnMode = mode) {
    return performSearch(null, forward, count, null, true, returnMode)
}
