// Read-only annotated-canvas support. Chromium's Reading Mode also consumes
// Docs SVG aria-label text. This adapter accepts only a measurable text run
// with an unambiguous caret boundary; it never invents whitespace between runs.
let renderedReaderRevision = 0
let renderedRunCache = null
let renderedReaderCanvas = null
let cursorTextHint = null

function invalidateRenderedReader() {
    renderedReaderRevision++
    renderedRunCache = null
    cursorTextHint = null
}

function renderedRunAtCaret() {
    const caret = getCursorTop()
    if (!caret) return null
    const rect = caret.getBoundingClientRect()
    if (!rect.height) return null
    const key = `${rect.left}|${rect.top}|${rect.height}|${renderedReaderRevision}`
    const maxAge = settings.wordMotion === "native" ? 2500 : 500
    if (renderedRunCache && renderedRunCache.key === key && Date.now() - renderedRunCache.created <= maxAge) return renderedRunCache.value
    const candidates = Array.from(document.querySelectorAll(
        ".kix-canvas-tile-content rect[aria-label], .kix-canvas-tile-selection rect[aria-label]"))
    let best = null
    for (const node of candidates) {
        const label = node.getAttribute("aria-label")
        if (!label || /[\r\n\u000b\u2028\u2029\p{Script=Arabic}\p{Script=Hebrew}]/u.test(label)) continue
        const box = node.getBoundingClientRect()
        if (!box.width || !box.height || rect.left < box.left - 1.5 || rect.left > box.right + 1.5) continue
        if (rect.top + rect.height / 2 < box.top - 2 || rect.top + rect.height / 2 > box.bottom + 2) continue
        const font = node.getAttribute("data-font-css")
        if (!font) continue
        try {
            if (!renderedReaderCanvas) renderedReaderCanvas = document.createElement("canvas")
            const context = renderedReaderCanvas.getContext("2d")
            context.font = font
            const text = toGraphemes(label)
            const measured = context.measureText(label).width
            if (!measured) continue
            const scale = box.width / measured
            const widths = [0]
            let prefix = ""
            for (const ch of text) { prefix += ch; widths.push(context.measureText(prefix).width * scale) }
            let at = 0
            for (let i = 1; i < widths.length; i++) {
                if (Math.abs(box.left + widths[i] - rect.left) < Math.abs(box.left + widths[at] - rect.left)) at = i
            }
            const error = Math.abs(box.left + widths[at] - rect.left)
            if (error > Math.max(1.5, rect.height * 0.12)) continue
            const value = { text, at, partial: true, rendered: true, node,
                char: text[at], glyphWidth: at < text.length ? widths[at + 1] - widths[at] : null,
                previousChar: text[at - 1], previousWidth: at > 0 ? widths[at] - widths[at - 1] : null,
                font, advances: widths, left: box.left, point: cursorDocumentPoint(), revision: textRevision, created: Date.now() }
            if (!best || error < best.error || (error === best.error && value.char && !best.value.char)) best = { error, value }
        } catch (err) { /* Unknown font/geometry: use the bounded fallback. */ }
    }
    const value = best ? best.value : null
    renderedRunCache = { key, value, created: Date.now() }
    return value
}

// Paragraph roles supply actual logical boundaries. Adjacent annotated runs
// are concatenated verbatim; only explicit paragraph siblings add a newline.
// A tile/run boundary by itself never implies a space or a line break.
function renderedContextAtCaret() {
    const run = renderedRunAtCaret()
    if (!run || !run.node || !run.node.closest) return run
    const paragraph = run.node.closest('[role="paragraph"]')
    if (!paragraph || !paragraph.parentElement) return run
    const siblings = Array.from(paragraph.parentElement.children)
    const center = siblings.indexOf(paragraph)
    if (center < 0) return run
    const isParagraph = (node) => node.getAttribute && node.getAttribute("role") === "paragraph"
    let first = center, last = center
    while (first > 0 && center - first < 32 && isParagraph(siblings[first - 1])) first--
    while (last + 1 < siblings.length && last - center < 32 && isParagraph(siblings[last + 1])) last++
    let at = null
    const text = []
    for (let i = first; i <= last; i++) {
        const nodes = Array.from(siblings[i].querySelectorAll('rect[aria-label]'))
        if (!nodes.length) return run
        if (i > first) text.push("\n")
        let previous = null
        for (const node of nodes) {
            const label = node.getAttribute("aria-label")
            if (label === null || !node.getAttribute("data-font-css") || /[\r\n\u000b\u2028\u2029\p{Script=Arabic}\p{Script=Hebrew}]/u.test(label)) return run
            if (node.closest('[role="listmarker"], [role="listitem"]') && /^[\s\d.)•◦▪‣⁃●○■□*-]+$/u.test(label)) return run
            const box = node.getBoundingClientRect()
            if (previous) {
                const sameRow = Math.abs(previous.box.top - box.top) < Math.min(previous.box.height, box.height) / 2
                // A geometric gap can be an omitted space or generated list
                // marker. Neither is a native arrow step we may invent.
                if (sameRow && Math.abs(box.left - previous.box.right) > 1.5) return run
                if (!sameRow && !/\s$/u.test(previous.label) && !/^\s/u.test(label)) return run
            }
            if (node === run.node) at = text.length + run.at
            text.push(...toGraphemes(label))
            previous = { box, label }
        }
    }
    return at === null ? run : { ...run, text, at, paragraphStart: true }
}

function renderedWordSnapshot(kind, WORD, count) {
    if (settings.readStrategy === "clipboard") return null
    const snapshot = renderedContextAtCaret()
    if (!snapshot || snapshot.at >= snapshot.text.length) return null
    return wordSnapshotCovers(snapshot, kind, WORD, count) ? snapshot : null
}

function rememberCursorText(snapshot) {
    if (!snapshot) { cursorTextHint = null; return }
    cursorTextHint = { char: snapshot.text[snapshot.at], point: cursorDocumentPoint(), revision: textRevision, context: snapshot }
}

function rememberCursorGlyph(char, context = null) {
    cursorTextHint = { char, point: cursorDocumentPoint(), revision: textRevision, context }
}

function cursorGlyphInfo() {
    const rendered = renderedRunAtCaret()
    if (rendered) return { char: rendered.char, width: rendered.glyphWidth, font: rendered.font,
        previousChar: rendered.previousChar, previousWidth: rendered.previousWidth }
    const point = cursorDocumentPoint()
    if (cursorTextHint && cursorTextHint.revision === textRevision && comparePoints(cursorTextHint.point, point) === 0) return cursorTextHint
    if (textSnapshot && snapshotUsable()) return { char: textSnapshot.text[textSnapshot.at] }
    return null
}

function normalNavigation(key) {
    const snapshot = snapshotUsable() ? textSnapshot : null
    const context = snapshot || (cursorTextHint && cursorTextHint.revision === textRevision ? cursorTextHint.context : null)
    const before = cursorDocumentPoint()
    if (snapshot && (key === "h" || key === "l")) {
        const line = DocsKeysVim.line(snapshot.text, snapshot.at)
        if (key === "h" && snapshot.at === line.start && (line.start > 0 || snapshot.completeStart || snapshot.paragraphStart || !snapshot.partial)) return
        const last = Math.max(line.start, line.end - (mode === "visualLine" ? 0 : 1))
        if (key === "l" && snapshot.at >= last && (line.end < snapshot.text.length || snapshot.completeEnd || !snapshot.partial)) return
        const target = snapshot.at + (key === "h" ? -1 : 1)
        if (target >= 0 && target < snapshot.text.length && snapshot.text[target] !== "\n") {
            moveSnapshotCaret(snapshot, target)
            return
        }
    }
    if (key === "j" || key === "k") nativeVerticalStep(key === "j")
    else sendKeyEvent(key === "h" ? "left" : "right")
    if (context) {
        const after = cursorDocumentPoint()
        let target = context.at
        if (comparePoints(before, after) !== 0) {
            if (key === "h" || key === "l") target += key === "h" ? -1 : 1
            else {
                const line = DocsKeysVim.line(context.text, context.at)
                const next = key === "j" ? line.end + 1 : line.start - 1
                if (next >= 0 && next <= context.text.length) {
                    const bounds = DocsKeysVim.line(context.text, next)
                    target = Math.min(bounds.start + context.at - line.start, Math.max(bounds.start, bounds.end - 1))
                }
            }
        }
        if (target >= 0 && target < context.text.length) rememberCursorGlyph(context.text[target], { ...context, at: target, point: after })
    }
}
