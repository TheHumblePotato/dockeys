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

chrome.storage.local.get(key, (result) => {
    if (chrome.runtime.lastError) {
        status.textContent = "Could not load settings. Reopen this popup to try again."
        return
    }
    render(result[key])
    form.disabled = false
    status.textContent = "Changes save automatically."
})

form.addEventListener("change", () => {
    const value = {}
    for (const name of Object.keys(DocsKeysSettings.defaults)) {
        const input = form.elements.namedItem(name)
        value[name] = input.type === "checkbox" ? input.checked : input.value
    }
    chrome.storage.local.set({ [key]: normalize(value) }, () => {
        status.textContent = chrome.runtime.lastError ? "Could not save settings. Try again." : "Saved. Open documents update automatically."
    })
})

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[key]) render(changes[key].newValue)
})
