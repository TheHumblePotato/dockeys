# Reading Docs without disruptive selections

Research and implementation notes for DocsKeys 1.8, checked November 3, 2026.

## Evidence

Google moved Docs from HTML rendering to canvas and warned that this affects extensions which depend on document HTML. A normal DOM text traversal is therefore not a complete buffer reader. [Google's canvas-rendering announcement](https://workspaceupdates.googleblog.com/2021/05/Google-Docs-Canvas-Based-Rendering-Update.html)

Chromium's Reading Mode has explicit support for Docs' annotated canvas: it reads SVG accessibility names supplied through `aria-label`. This establishes a useful local text source; it does **not** establish a public extension API or guarantee every run has text and font metadata. [Chromium implementation](https://chromium.googlesource.com/chromium/src/+/e1d1d5298b169855b4cc044c3de0305b01eda122/chrome/renderer/accessibility/read_anything/read_anything_node_utils.cc)

The supported Docs API can retrieve document content and requires OAuth scopes. Its response is a document representation, not the browser editor's live caret/selection. It would need a separate position/revision mapping for keyboard motions. [documents.get reference](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/get)

Chrome supports page-world content scripts at `document_start`, before page scripts run. That makes early focus/scroll guards possible. `focus({preventScroll:true})` suppresses focus-induced scrolling; `overflow-anchor` only controls browser scroll anchoring, so disabling anchoring alone cannot stop an editor explicitly scrolling its caret. [Chrome content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts), [focus options](https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/focus), [scroll anchoring](https://developer.mozilla.org/en-US/docs/Web/CSS/overflow-anchor)

## Implemented approach

1. Request annotated canvas during startup using DocsKeys' own extension ID. `_docs_annotate_canvas_by_ext` is an **undocumented compatibility flag**, not a Google-supported API. The reader remains optional and falls back when unavailable.
2. Read measurable labeled SVG text runs around the caret. Require font metadata and a nearby grapheme boundary. Use run geometry to account for zoom; do not join runs or invent intervening whitespace. Unsupported or ambiguous runs fall back, including bidirectional text.
3. For ordinary word motions without usable annotations, copy a small display-line window. Expand from two to at most 32 lines before requesting a full snapshot for unusually large spans. Existing Vim motion rules determine destinations in either reader.
4. While probing, set opacity to zero only on Docs' temporary selection layer. Layout and Copy continue to work; the document text remains visible. A native `::selection` rule alone would not cover Docs' custom highlight elements.
5. Keep the genuine Visual highlight visible as fixed rectangle copies while Docs rebuilds the selection. Mask intermediate collapse/extend states and retain the text model across selection/tile redraws. Cleanup uses animation frames with a timeout fallback.
6. During probes, guard editor programmatic scroll methods/setters and focus in the page world, including the input iframe. Preserve scroll continuously in the content world, retain newer wheel/touch intent, and restore after late layout work. The page guard has a short lease if a completion event is lost.
7. Size the cursor from passive rendered geometry or text already obtained by a command. Cursor rendering never initiates selection/clipboard probes.

Auto combines these paths. Rendered only disables automatic clipboard document probes and declines commands requiring unknown text, including current global search/full-snapshot operators. Clipboard retains the fallback independently. Explicit register and clipboard editing commands retain their normal behavior.

## Alternatives considered

| Approach | Assessment |
| --- | --- |
| Hide the whole editor during Copy | Would replace the blue flash with a document flash. Only the temporary selection layer is masked. |
| Restore scroll only after copying | Too late to prevent visible intermediate jumps. Early page guards plus continuous restoration address the read interval. |
| Intercept canvas drawing | Would modify the rendering path and still require ordering, whitespace, caret, and revision mapping. Not implemented. |
| Docs API / Drive export | Supported content retrieval, but adds authorization/network work and still lacks the live caret mapping. Not implemented. |
| Inspect private application state | Would depend on minified internals and version-specific offsets. Not implemented. |
| Native Ctrl+Arrow word movement | Fast, but Docs word/paragraph boundaries differ from Vim. Both speed modes keep the shared Vim engine. |

## Verification and remaining uncertainty

### Changes in 1.10

The rendered context builder rejects unexplained geometric gaps, generated list markers, and uncertain wrapped joins. A generated bullet before the next paragraph's text reproduces the one-character second-`w` bug in the Chromium fixture. Normal word movement now waits for caret paint and rebinds its context to the actual rendered caret.

Linewise mode uses a normal native caret and a separate highlight; it does not repeatedly place Docs' focus at the selected line's outer boundary. Supported operators materialize an exact snapshot range. Native formatting/accessibility selection integration and unannotated wrapped highlighting remain limitations.

Search keeps one viewport transaction through its final move and explicit reveal, measuring only after restoring the intended scroll position. The page bridge also guards ancestor/window scrolling and scroll/focus work in timers/animation callbacks scheduled during the read. These callbacks still execute; only their probe-associated viewport effects are suppressed.

Clipboard promises are bounded and active reads are abortable. Escape bypasses queued input. Cancellation keeps selection cleanup/restoration bounded and prevents stale cleanup from moving a newly clicked caret; overflow and a watchdog recover stalled commands.

### Changes in 1.9

The local reader now accepts contiguous explicit paragraph siblings, concatenating their labeled runs verbatim and inserting only semantic paragraph breaks. A run/tile boundary alone still supplies no inferred whitespace. Fallback windows use vertical native movement to cross displayed rows. Probes wait for caret painting before capturing the origin and measure movement after Copy completes; unavailable Copy data is rejected and its temporary selection is collapsed back. A recovery path handles Copy/menu integrations that collapse a selection themselves, returning by the known grapheme count when needed.

Visual mode starts with bounded context. Promotion protects its whole collapse/read/reconstruction, and a failed promotion rebuilds the original selection. Page scroll guards and viewport restoration cover delayed layout frames; newer wheel/touch input, `Ctrl+e/y`, and viewport commands take priority. Default Visual vertical movement uses native displayed rows without a full-document promotion on every `j/k`, waiting for the painted row before resolving selection direction. Logical paragraph movement remains an option.

`npm test` covers the simulated adapter, bounded probes, cleanup on failure, rendered-only behavior, wrapped Visual rows/key volume, promotion viewport safety, delayed caret/Copy failure, viewport commands, and Neovim differential cases when installed. `npm run test:browser` runs real Chromium DOM/CSS/canvas checks in a disposable local fixture, including rendered cross-paragraph words/Visual selections, masked Copy, and proportional cursor widths after movement/find/search.

The fixture does not authenticate with Google Docs. Live Docs validation remains necessary for annotation availability, actual highlight markup, styled/wrapped text, asynchronous native scroll behavior, collaborative edits, and clipboard timing. Annotated runs may cover only rendered pages; full-document context still needs a fallback. Cached text is not a synchronized Docs buffer, and remote canvas-only changes may remain unseen until cache expiry.
