const form = document.getElementById("settings")
const status = document.getElementById("settings-status")
const { key, normalize } = DocsKeysSettings

function render(value) {
    const settings = normalize(value)
    for (const [name, value] of Object.entries(settings)) {
        const input = form.elements.namedItem(name)
        if (input.type === "checkbox") input.checked = value
        else input.value = value
    }
}

try {
    const storage = DocsKeysSettings.storage()
    if (!storage) throw new Error("Storage unavailable")
    storage.get(key, (result) => {
        if (DocsKeysSettings.storageError()) {
            status.textContent = "Could not load settings. Reopen this popup to try again."
            return
        }
        render(result?.[key])
        form.disabled = false
        status.textContent = "Changes save automatically."
    })
} catch {
    status.textContent = "Settings unavailable. Reload the extension and reopen this popup."
}

form.addEventListener("change", () => {
    const value = {}
    for (const name of Object.keys(DocsKeysSettings.defaults)) {
        const input = form.elements.namedItem(name)
        value[name] = input.type === "checkbox" ? input.checked : input.value
    }
    try {
        const storage = DocsKeysSettings.storage()
        if (!storage) throw new Error("Storage unavailable")
        storage.set({ [key]: normalize(value) }, () => {
            status.textContent = DocsKeysSettings.storageError() ? "Could not save settings. Try again." : "Saved. Open documents update automatically."
        })
    } catch { status.textContent = "Could not save settings. Reopen this popup to try again." }
})

try { chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === "local" && changes[key]) render(changes[key].newValue)
}) } catch { /* The popup may outlive an extension reload. */ }
