// Shared by the popup and content script. Only validated preferences are stored.
const DocsKeysSettings = (() => {
    const key = "docskeys-settings"
    const defaults = Object.freeze({
        dvorak: true,
        boxCursor: true,
        modeIndicator: true,
        wordMotion: "native",
        startInInsert: false,
    })

    function normalize(value) {
        const out = { ...defaults }
        if (!value || typeof value !== "object") return out
        for (const name of ["dvorak", "boxCursor", "modeIndicator", "startInInsert"]) {
            if (typeof value[name] === "boolean") out[name] = value[name]
        }
        if (["native", "precise"].includes(value.wordMotion)) out.wordMotion = value.wordMotion
        return out
    }

    return { key, defaults, normalize }
})()
