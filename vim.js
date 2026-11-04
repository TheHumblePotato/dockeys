// Pure motion rules shared by the extension and Neovim differential tests.
const DocsKeysVim = (() => {
    const blank = (ch) => ch === undefined || /\s/u.test(ch)
    const newline = (ch) => ch === "\n"
    function classify(ch, WORD = false) {
        if (blank(ch)) return "blank"
        if (WORD) return "word"
        if (/^[\p{L}\p{N}\p{M}_]/u.test(ch)) return "keyword"
        if (/^\p{Extended_Pictographic}/u.test(ch)) return "emoji"
        return "punct"
    }
    function line(text, at) {
        let start = at, end = at
        while (start > 0 && !newline(text[start - 1])) start--
        while (end < text.length && !newline(text[end])) end++
        return { start, end }
    }
    function emptyLine(text, at) {
        return (at === 0 || newline(text[at - 1])) && (at === text.length || newline(text[at]))
    }
    function cursor(text, at) {
        at = Math.max(0, Math.min(text.length, at))
        if (emptyLine(text, at)) return at
        if (at === text.length || newline(text[at])) return Math.max(0, at - 1)
        return at
    }
    function word(text, at, kind, count = 1, WORD = false, visual = false) {
        let target = at, lastStart = at, boundary = at, failed = false
        const cls = (i) => classify(text[i], WORD)
        for (let n = 0; n < count; n++) {
            let i = target
            let terminal = false
            lastStart = i
            if (kind === "w") {
                if (i === text.length && emptyLine(text, i)) failed = true
                if (emptyLine(text, i) && i < text.length) i++
                else if (!blank(text[i])) {
                    const type = cls(i)
                    while (i < text.length && cls(i) === type) i++
                }
                while (i < text.length && blank(text[i]) && !emptyLine(text, i)) i++
            } else if (kind === "b") {
                if (i === 0) failed = true
                i--
                while (i > 0 && blank(text[i]) && !emptyLine(text, i)) i--
                if (i >= 0 && !blank(text[i])) {
                    const type = cls(i)
                    while (i > 0 && cls(i - 1) === type) i--
                    terminal = i === 0
                }
                if (i <= 0 && !emptyLine(text, 0)) terminal = true
            } else if (kind === "ge") {
                if (target === 0) failed = true
                i--
                if (i >= 0 && !blank(text[target]) && cls(i) === cls(target)) {
                    const type = cls(target)
                    while (i >= 0 && cls(i) === type) i--
                }
                while (i >= 0 && blank(text[i]) && !emptyLine(text, i)) i--
                terminal = i < 0 && target > 0
            } else { // e: the next word end, skipping blank lines
                i++
                while (i < text.length && blank(text[i])) i++
                if (i < text.length) {
                    const type = cls(i)
                    while (i + 1 < text.length && cls(i + 1) === type) i++
                }
            }
            boundary = Math.max(0, Math.min(text.length, i))
            target = visual && kind === "w" && i >= text.length ? text.length : cursor(text, i)
            if (terminal) break
        }
        return { target, lastStart, boundary, failed }
    }
    function wordRange(text, at, kind, count, WORD, op) {
        if (op === "c" && kind === "w" && count === 1 && emptyLine(text, at)) return { start: at, end: at }
        if (op === "c" && kind === "w" && !blank(text[at])) {
            let end = at
            const type = classify(text[at], WORD)
            while (end + 1 < text.length && classify(text[end + 1], WORD) === type) end++
            if (count > 1) end = word(text, end, "e", count - 1, WORD).target
            return { start: at, end: Math.min(text.length, end + 1) }
        }
        const result = word(text, at, kind, count, WORD)
        const target = result.target
        if ((kind === "ge" || kind === "b" || (kind === "w" && op === "c")) && result.failed) return { start: at, end: at }
        if (kind === "ge" && target === at) return { start: at, end: at }
        if (kind === "ge" && emptyLine(text, at) && target < at) {
            const first = line(text, target)
            let nonblank = first.start
            while (nonblank < first.end && blank(text[nonblank])) nonblank++
            if (target <= nonblank) return { start: op === "d" && at === text.length && first.start > 0 ? first.start - 1 : first.start,
                end: op === "c" ? at : Math.min(text.length, at + 1) }
            return { start: target, end: at }
        }
        if (kind === "w" && result.boundary > at) {
            // Operator-w stops at the final word's EOL instead of joining it.
            let end = result.boundary
            if (emptyLine(text, result.lastStart)) return exclusiveRange(text, at, line(text, target).start, op)
            if (!emptyLine(text, result.lastStart)) {
                for (let i = result.lastStart; i < result.boundary; i++) {
                    if (newline(text[i])) { end = i; break }
                }
            }
            return inclusiveRange(text, { start: at, end }, op)
        }
        if (kind === "b") return inclusiveRange(text, exclusiveRange(text, at, target, op), op)
        return inclusiveRange(text, { start: Math.min(at, target), end: Math.min(text.length, Math.max(at, target) + 1) }, op, Math.max(at, target))
    }
    function inclusiveRange(text, range, op, lastAt = Math.max(range.start, range.end - 1)) {
        if (op === "c") return range
        const first = line(text, range.start), last = line(text, lastAt)
        if (first.start === last.start) return range
        let leading = first.start, trailing = last.end
        while (leading < first.end && blank(text[leading])) leading++
        while (trailing > last.start && blank(text[trailing - 1])) trailing--
        if (range.start > leading || range.end < trailing) return range
        const end = Math.min(text.length, last.end + 1)
        return { start: last.end === text.length && first.start > 0 ? first.start - 1 : first.start, end }
    }
    function searchMatches(text, pattern, wholeWord = false, options = {}) {
        if (!pattern) return []
        let ignoreCase = !!options.ignoreCase, explicitCase = null
        pattern = pattern.replace(/\\([cC])/g, (_, c) => { explicitCase = c === "c"; return "" })
        if (pattern.startsWith("\\V")) pattern = pattern.slice(2)
        pattern = pattern.replace(/\\n/g, "\n")
        if (explicitCase !== null) ignoreCase = explicitCase
        else if (ignoreCase && options.smartCase && !wholeWord && /\p{Lu}/u.test(pattern)) ignoreCase = false
        if (!pattern) return []
        const offsets = [0]
        for (const ch of text) offsets.push(offsets[offsets.length - 1] + ch.length)
        const boundaries = new Map(offsets.map((offset, i) => [offset, i]))
        const source = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        const re = new RegExp(source, ignoreCase ? "giu" : "gu")
        const matches = []
        const fullText = text.join("")
        for (let match; (match = re.exec(fullText));) {
            // Vim searches can overlap: /aa in aaa also matches at column 2.
            re.lastIndex = match.index + String.fromCodePoint(fullText.codePointAt(match.index)).length
            const start = boundaries.get(match.index), end = boundaries.get(match.index + match[0].length)
            if (start === undefined || end === undefined) continue
            if (wholeWord && (classify(text[start - 1]) === "keyword" || classify(text[end]) === "keyword")) continue
            matches.push({ target: start, length: end - start })
        }
        return matches
    }
    function searchFromMatches(matches, at, forward, count = 1, wrap = true) {
        if (!matches.length) return null
        let lo = 0, hi = matches.length
        while (lo < hi) {
            const mid = Math.floor((lo + hi) / 2)
            if (matches[mid].target < at || (forward && matches[mid].target === at)) lo = mid + 1
            else hi = mid
        }
        count = Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.trunc(Number(count) || 1)))
        const first = forward ? lo : lo - 1, remaining = count - 1
        const wrapped = first < 0 || first >= matches.length || (forward ? remaining >= matches.length - first : remaining > first)
        if (wrapped && !wrap) return null
        const chosen = ((first % matches.length) + (forward ? remaining % matches.length : -(remaining % matches.length)) + matches.length) % matches.length
        return { ...matches[chosen], wrapped, index: chosen, total: matches.length }
    }
    function search(text, at, pattern, forward, count = 1, wrap = true, wholeWord = false, options = {}) {
        return searchFromMatches(searchMatches(text, pattern, wholeWord, options), at, forward, count, wrap)
    }
    function exclusiveRange(text, at, target, op) {
        const start = Math.min(at, target), end = Math.max(at, target)
        if (end > start && line(text, end).start === end && line(text, start).start < end) {
            const origin = line(text, start)
            let nonblank = origin.start
            while (nonblank < origin.end && blank(text[nonblank])) nonblank++
            if (start <= nonblank) return { start: origin.start, end: op === "c" ? end - 1 : end }
            return { start, end: end - 1 }
        }
        return { start: Math.min(at, target), end: Math.max(at, target) }
    }
    return { blank, classify, line, emptyLine, cursor, word, wordRange, search, searchMatches, searchFromMatches, exclusiveRange }
})()

if (typeof module !== "undefined") module.exports = DocsKeysVim
