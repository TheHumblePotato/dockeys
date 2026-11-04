// A literal search command line that keeps focus in Docs' input iframe.
// Search text is raw OS-layout text, never translated through the command map.
let searchState = null
let lastSearch = null
let searchOverlay = null
let pendingSearchCount = 1

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
    searchState = { forward, operator, count, returnMode, query: "" }
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
        lastSearch = { pattern, forward: state.forward, wholeWord }
        performSearch(pattern, state.forward, state.count, state.operator, wholeWord, state.returnMode)
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

async function performSearch(pattern, forward, count = 1, operator = null, wholeWord = false, returnMode = "normal") {
    if (!beginOracle()) return
    const epoch = scrollIntentRevision
    try {
        let snapshot
        if (returnMode === "visual") {
            const model = visualModel || await recoverVisualSnapshot()
            if (!model) return
            snapshot = { text: model.text, at: model.c }
        } else snapshot = await getTextSnapshot(!!operator)
        if (!snapshot) {
            showSearchLine("Search unavailable: could not read document text")
            return
        }
        let at = DocsKeysVim.cursor(snapshot.text, snapshot.at)
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
            switchModeToNormal()
          }
        })
        if (match.wrapped) showSearchLine(forward ? "Search wrapped to top" : "Search wrapped to bottom")
        else hideSearchLine()
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
