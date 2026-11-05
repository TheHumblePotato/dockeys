# Vim/Neovim compatibility and feature backlog

DocsKeys drives keyboard events and menu commands. It has no supported Google Docs buffer API. The motion engine operates on temporary plain-text snapshots; the browser adapter realizes its ranges with native selection events. Verification must cover both layers.

## Implemented in 1.7

- One word/WORD engine for Fast and Precise, including punctuation, empty lines, paragraph crossings, counts, and EOF rules.
- A one-sided first read for forward word motions; motion bursts reuse snapshots. Fast allows 2.5 seconds of reuse, Precise 0.5 seconds. Operators refresh before editing.
- Whole-document Visual motion state instead of native-word fallbacks. Anchor crossings stay inclusive; the box follows the cursor character rather than the selection's outer boundary.
- Visual vertical motions preserve their preferred column. `$` includes a paragraph break in the modeled selection; virtual EOF selections do not delete adjacent characters.
- `cw/cW` whitespace behavior, operator-`w` at EOL, backward exclusive boundaries, and count multiplication (`2d3w` = six words).
- A proper `g` prefix: `gg`, counted `gg/G`, `ge/gE`, `g_`, and native display-line `gj/gk`. `gg/G` follow Neovim's default `nostartofline` column preservation.
- Custom literal `/` and `?`, `n/N`, `*/#`, wrapping, counts, overlapping matches, case flags, query editing/paste, and operator integration such as `d/hi` + Enter or `dn`.
- No idle clipboard reads. Explicit reads preserve viewport position and newer wheel/touch intent, including late layout callbacks and motions completing after a scroll gesture.
- Existing DVP/cursor/startup settings, registers, text objects, limited dot repeat, linewise selections, and grapheme handling remain supported.

## Implemented in 1.8

- Prefer read-only annotated SVG runs for local word/find motions and entering Visual mode. Unknown run boundaries promote to a clipboard snapshot rather than inventing spaces or paragraph breaks.
- Auto, Rendered only (no document probes), and Clipboard compatibility reader settings. The annotation request is undocumented and requires refreshing Docs after updating.
- Bounded word probes begin with two display lines instead of selecting a document tail. Temporary probe highlights are masked; page-world focus/scroll calls are guarded during reads.
- Preserve Visual models across tile/selection redraws. Freeze the existing highlight during selection batches; clear temporary masks even when animation frames are throttled.
- Passive proportional glyph sizing from rendered geometry or existing text hints, including normal hjkl/find/search destinations, without cosmetic clipboard reads.
- Normal-mode `zz`, `zt`, `zb` position the viewport without moving the cursor or reading text. Counts on these commands are not implemented; use a line motion followed by `zz`.
- A real Chromium fixture covers masking, Copy, focus/scroll guards, glyph sizing, and Visual redraw stability. See [READING_RESEARCH.md](READING_RESEARCH.md) for the reading design and evidence.

## Verification boundaries

`npm test` runs the browser-adapter simulator and a headless Neovim comparison when available. The differential suite checks ASCII word motions, punctuation, blank lines, counts, delete/change results, Visual endpoints, selected g commands, and literal-search operators. It is evidence for these cases, not a claim that every Vim rule has been implemented.

Live Google Docs testing is still required for paragraph/text extraction, formatting, tables, lists, page boundaries, proportional fonts, zoom, permissions, IME, and collaborating users. Clipboard text and arrow movement may disagree around non-text content. Undo history and trusted-key handling are controlled by Docs.

## Implemented in 1.9

- Word/WORD context can cross explicitly annotated sibling paragraphs without Copy, including Visual mode and Rendered only. Unknown boundaries still require Auto/Clipboard fallback.
- Fallback windows cross displayed rows using native Up/Down and Home/End. Text probes wait for caret painting and measure after Copy; a failed Copy cannot masquerade as a successful empty snapshot at a document boundary.
- Entering Visual mode uses bounded context. Full promotions protect the entire collapse/read/reconstruction, including late layout frames; failed promotions restore the original selection.
- Default Visual `j/k` uses displayed rows with bounded key volume instead of selecting through a paragraph character by character. The Paragraphs setting retains modeled Vim logical-line behavior. Anchor crossing can still require a repair read.
- Configurable translucent box cursor color, blue by default, applied immediately to open tabs.
- In-tab search history with Up/Down, draft restoration, duplicate removal, and a 50-query limit; no reads while browsing.
- Regression coverage for wrapped Visual rows, promotion scroll jumps, fresh no-match searches, delayed caret painting/failed Copy, failed Visual promotion, color repainting, and rendered cross-paragraph words.

## Implemented in 1.10

- Reject ambiguous gaps/generated list-marker runs in combined rendered contexts. Rebind normal word snapshots after the native caret paints; the Chromium fixture reproduces the next-line/bullet `w` one-character error.
- Linewise highlighting is independent of Docs' selection endpoints. The native caret retains its column, supports horizontal/word/find/search/document motions and counts, and swaps endpoints with `o/O`. Operators realize whole-paragraph ranges on demand; character/linewise conversion preserves the span.
- Plain mouse clicks leave Visual without a clipboard check; drags keep native charwise ranges. Mouse replacement cancels pending reads without replaying cleanup onto the clicked caret.
- Search protects the entire read/move/reveal operation and measures against the intended viewport. Missing patterns retain the view; uniquely verified nearby rendered matches can correct native landing discrepancies.
- Editor ancestors, window scrolling, and late page timers/animation callbacks scheduled by a read participate in scroll/focus guards.
- Bounded clipboard I/O, abortable reads, prioritized Escape/Ctrl+[, bounded restoration, overflow recovery, and a command watchdog prevent a stalled clipboard promise from permanently capturing input.
- Expanded Neovim adapter comparisons include linewise cursor positions, selection ranges, word/find/document motions, EOL behavior, endpoint swaps, and operators.

## Implemented in 1.11

- The existing Displayed rows/Paragraphs preference now controls `V` movement, highlight units, and operators together. Entering `V` and swapping endpoints are read-free; paragraph anchors are resolved lazily. Range preparation remains inside viewport protection.
- Linewise highlights use annotated text/paragraph horizontal bounds instead of editor width. Formatting shortcuts, toolbar clicks, and right-clicks materialize a native range. Relative offsets restore the logical cursor/anchor after font reflow; changed range text invalidates the old state.
- Right-clicks, box clicks, and clicks outside the editor preserve Visual mode. Moving primary clicks leave it; native drags enter charwise Visual. Native editing/navigation shortcuts and explicitly hidden selection overlays clear stale Visual state.
- Fixed a queue deadlock caused by shifted formatting shortcuts scheduling a Normal-only selection check while Visual was active. Escape clears pending recovery. Registers and initialization tolerate unavailable extension storage and retain in-memory values.
- Visual vertical correction waits for painted geometry instead of synchronously walking a stale caret. Tests include 80ms caret delays, wrapped rows, short/blank rows, anchor crossings, and preferred columns.
- Forward literal search initially reads only the suffix, expanding missing context on demand. Repeats cache source text and compiled matches; binary search handles large counts. Document-edge anchors reduce long-distance arrow volume.
- Added search wrapping, ignore case, smart case, and match-counter preferences. `\c/\C` override case options; `*/#` follow Vim's smart-case exception. Partial counts are labeled explicitly.
- Added simulator/Chromium coverage for formatting/context/toolbar ranges, storage failure, font reflow, and Visual recovery. Neovim comparisons exercise both linewise settings on unwrapped rows; wrapped semantics are covered separately in the simulator.

## Implemented in 1.12

- A document-start page bridge blocks right pointerdown/mousedown/mouseup before Docs' window listeners. Context-menu hit-testing uses a point inside the original selection; both Visual modes retain their endpoints. Context Menu and Shift+F10 keys are supported too.
- Toolbar replay now includes pointer events, button state, control-centered coordinates, and Closure toolbar classes without ARIA roles. Native linewise bold/italic/underline/font-size/comment shortcuts prepare the range on modifier press, retain trusted keys when ready, and prefer toolbar actions for rapid fallback.
- Native formatting has priority over Ctrl+b/u scrolling in `V`. Empty range prefixes skip Copy instead of opening a disabled menu item. Preparing a range no longer focuses a toolbar button before replaying its pointer gesture.
- Comment/format actions release probe scroll/masking before opening UI. Page-relative geometry translates linewise anchor/cursor bookmarks when the comment panel shifts the paper; cached bounds are invalidated.
- Added read-free normal-mode `gI` to insert at column zero of the displayed row. Updated the popup reference for `gg`, configured linewise units, native formatting, and context menus.
- Added a CDP-driven fixture with trusted pointer/key input, actual per-character formatting effects, early-window right-click handlers, role-less toolbar controls, font inputs, rapid Ctrl+B, and comment-layout transitions. This still does not substitute for live Docs verification.

## Complete remaining backlog

The sections below are the current list of unfinished features, known approximations, and integration work. Live verification is part of the backlog, not evidence that a behavior is already correct in Docs.

## Search follow-ups

| Feature | Current gap / next step |
| --- | --- |
| Vim regex syntax | Queries are literal. Add a documented parser for magic/nomagic, character classes, groups, alternation, lookarounds, and backreferences; do not silently treat JavaScript regex as Vim regex. |
| Search options | Wrapping/case/count preferences are implemented. Add a result cap and richer count/status behavior for documents too large to index cheaply. |
| Incremental search / `hlsearch` | Show matching results without changing the document selection or running clipboard reads per keystroke. |
| Persistent search history and register | In-tab history is implemented. Add persistence, prefix filtering, richer command-line navigation, and the `"/` register; retain direction/flags correctly. |
| `gn/gN` | Select the current/next match as a text object, including operator counts and no-match behavior. |
| Search offsets | Implement `/pattern/e`, line/character offsets, and the resulting inclusive/exclusive motion rules. |
| Large-document navigation | Verified document-edge anchors reduce event volume. Extend exact mapping to intermediate rendered pages, without guessing native word boundaries. |

## Motion and selection follow-ups

- Unify line semantics across operators, text objects, `gg/G`, `V`, and the configurable Visual vertical modes. Displayed rows and logical paragraph lines are explicit options, but not every command shares the same abstraction.
- Support all column-preservation cases, tabs, variable-width graphemes, and virtual-column behavior. `gg/G` currently choose a grapheme column, not a tab-expanded screen column.
- Audit remaining aliases and boundaries: `_` counts, counted `$`, `g^/g0/g$`, and native `h/l` at paragraph boundaries. `gI` is implemented; `I` currently uses Home rather than first nonblank.
- Implement `H/M/L`, counted viewport commands, sentence motions, and reliable blank-line paragraph motions instead of Docs' paragraph shortcuts.
- Add `%` with bracket nesting and quote/escape handling.
- Add marks, the jump list, and normal-mode `Ctrl+o/Ctrl+i` with document positions that survive collaborator edits.
- Add `gv`, previous-selection restoration, and Visual block mode with rectangle-aware editing.
- Fully audit repeated `iw/aw/iW/aW` across blank paragraphs and indentation. Same-line cases are covered; cross-paragraph whitespace/object counts still need broader differential tests.
- Add quoted, paired-delimiter, sentence, and nested block text objects with counted selection.
- Distinguish mouse selection anchor/focus reliably, including reverse dragging and native selection replacement.
- Eliminate the remaining clipboard repair on native Visual anchor crossings and the snapshot rebuild when resuming modeled words after native vertical movement.
- Extend live verification of preferred-column retention and EOL/blank-row clamping to styled wraps, tables, tabs, and bidirectional text. Simulator tests include missing annotations and delayed caret paint.
- Improve linewise highlighting without annotation geometry and preserve paragraph bands across virtualized/page-split paragraphs. Verify disjoint text columns rather than merging unrelated runs at the same Y position.
- Verify native formatting, comments, and context menus in live Docs, including localization, disabled controls, suggestions, and selected spans across pages. Trusted CDP input and early pointer capture are covered in the local fixture; replay behavior and private selectors remain dependent on Docs.
- Expose custom linewise ranges to accessibility tools while an ordinary caret is active; the native selection currently exists during explicit formatting/clipboard/edit actions.

## Editing and register follow-ups

- Insert-text dot repeat, supported Visual-change repeat, counted replacement, macros, and repeatable undo groups.
- `P`, counted paste, `X`, `S`, `cc`, `gJ`, and exact counted `J` whitespace/indentation behavior.
- Clamp native `x/s` and replacement operations at logical EOL, and verify empty-line behavior for every command.
- Preserve linewise/charwise/blockwise register metadata and use it for paste placement. The current default clipboard paste is Docs' insertion behavior.
- Full unnamed-register semantics, yank register `0`, numbered delete rotation `1`-`9`, and correct small-delete register rules.
- Linewise uppercase-register append behavior and persistence metadata.
- Preserve HTML/images and other clipboard formats around reads; text-only save/restore does not retain rich clipboard content.
- Verify Copy/Cut/Paste completion timing against real Docs, including permission denial, menu localization, and external clipboard writes during transactions.
- Indentation/formatting operators (`>`, `<`, `=`, `gq`) and document-aware joins.
- Ex command line, ranges, substitutions, global commands, and buffer-like abstractions that do not damage formatting.

## Runtime and integration follow-ups

- Add an opt-in live-browser test fixture against real Docs, with a collaborator session and a disposable test document.
- Handle Docs SPA navigation and replacement of the input iframe element, not just reloading its document.
- Improve text revision signals for canvas-only remote edits. Mutation/cursor observation plus a bounded cache age is best effort, not a synchronized buffer.
- Bind cached positions robustly after asynchronous caret painting, so stale geometry cannot cause unnecessary cache misses or reuse at the wrong native position.
- Extend rendered-text mapping across adjacent styled runs, ligatures, bidirectional text, tables, and offscreen pages. Preserve exact whitespace and logical line boundaries; never concatenate runs speculatively.
- Extend context across tile/page boundaries without explicit adjacent paragraph siblings; handle empty annotated paragraphs and detect duplicate or incomplete annotations conservatively.
- Investigate a supported read path or stable revision/selection signal. The annotation flag and SVG/selectors are private implementation details, and a saved-file API does not expose the live caret.
- Reduce full-snapshot reads for global search/operators and very large counts; retain clipboard safety and exact Vim boundaries. Do not infer successful extraction solely from a transient caret rectangle.
- Improve cursor sizing without annotations, especially native wrapped-line vertical movement, ligatures, and bidirectional text; keep cosmetics free of document probes.
- Validate selection masks and page-world scroll guards against real Docs versions, browser scroll anchoring, trackpads, and asynchronous menu completion.
- Audit Mac modifiers, international keyboard layouts, IME composition, tables, lists, footnotes, headers, suggestions, and multi-tab Docs documents.
- Cover toolbar gestures interrupted by scrolling, document replacement, remote edits, or a second click while range preparation is still running.
- Recover an already-open tab completely after extension reload. Storage currently falls back safely in memory; reinjection/bridge version negotiation and full feature reattachment remain unfinished.
- Add accessibility labels and navigation for a richer search command line without stealing the editor's selection or typing focus.

References: [Neovim motion rules](https://neovim.io/doc/user/motion/), [Visual mode](https://neovim.io/doc/user/visual/), [search commands](https://neovim.io/doc/user/pattern/), and [default mappings](https://neovim.io/doc/user/quickref/).
