// Undocumented Docs compatibility request. Readers must still handle its
// absence; the flag is not a supported Google Docs API.
(() => {
    const id = document.currentScript && document.currentScript.dataset.docskeysExtension
    if (id && !window._docs_annotate_canvas_by_ext) window._docs_annotate_canvas_by_ext = id
})()
