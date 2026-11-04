// Shared by the popup and content script. Only validated preferences are stored.
const DocsKeysSettings = (() => {
    const key = "docskeys-settings"
    const defaults = Object.freeze({
        dvorak: true,
        boxCursor: true,
        modeIndicator: true,
        wordMotion: "native",
        startInInsert: false,
        readStrategy: "auto",
        cursorColor: "#1a73e8",
        visualVertical: "display",
    })

    function normalize(value) {
        const out = { ...defaults }
        if (!value || typeof value !== "object") return out
        for (const name of ["dvorak", "boxCursor", "modeIndicator", "startInInsert"]) {
            if (typeof value[name] === "boolean") out[name] = value[name]
        }
        if (["native", "precise"].includes(value.wordMotion)) out.wordMotion = value.wordMotion
        if (["auto", "clipboard", "rendered"].includes(value.readStrategy)) out.readStrategy = value.readStrategy
        if (typeof value.cursorColor === "string" && /^#[0-9a-f]{6}$/i.test(value.cursorColor)) out.cursorColor = value.cursorColor.toLowerCase()
        if (["display", "logical"].includes(value.visualVertical)) out.visualVertical = value.visualVertical
        return out
    }

    return { key, defaults, normalize }
})()
