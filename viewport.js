let viewportReturnMode = "normal"

function startViewportCommand() {
    viewportReturnMode = mode
    mode = "viewportPrefix"
    updateModeIndicator(mode)
}

function alignCursorViewport(where) {
    const el = getDocsScrollContainer(), caret = getCursorTop()
    if (!el || !caret) return
    const rect = caret.getBoundingClientRect()
    if (!rect.height) return
    const box = el.getBoundingClientRect ? el.getBoundingClientRect() : null
    const top = box && box.height ? box.top : 0
    const height = el.clientHeight || (box && box.height) || window.innerHeight || 600
    const target = where === "t" ? top : where === "b" ? top + height - rect.height : top + (height - rect.height) / 2
    viewportEpoch++
    cancelReadScrollSettlement()
    el.scrollTop += rect.top - target
}

function handleViewportCommand(key) {
    mode = viewportReturnMode
    if (["z", "t", "b"].includes(key)) alignCursorViewport(key)
    updateModeIndicator(mode)
}
