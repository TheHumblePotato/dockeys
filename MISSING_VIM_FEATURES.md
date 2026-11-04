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

## Verification boundaries

`npm test` runs the browser-adapter simulator and a headless Neovim comparison when available. The differential suite checks ASCII word motions, punctuation, blank lines, counts, delete/change results, Visual endpoints, selected g commands, and literal-search operators. It is evidence for these cases, not a claim that every Vim rule has been implemented.

Live Google Docs testing is still required for paragraph/text extraction, formatting, tables, lists, page boundaries, proportional fonts, zoom, permissions, IME, and collaborating users. Clipboard text and arrow movement may disagree around non-text content. Undo history and trusted-key handling are controlled by Docs.

## Search follow-ups

| Feature | Current gap / next step |
| --- | --- |
| Vim regex syntax | Queries are literal. Add a documented parser for magic/nomagic, character classes, groups, alternation, lookarounds, and backreferences; do not silently treat JavaScript regex as Vim regex. |
| Search options | Add configurable `wrapscan`, `ignorecase`, `smartcase`, and result-limit behavior. `\c/\C` already work per query. |
| Incremental search / `hlsearch` | Show matching results without changing the document selection or running clipboard reads per keystroke. |
| Search history and register | Add command history, query navigation, and the `"/` register. Preserve direction and flags when reusing patterns. |
| `gn/gN` | Select the current/next match as a text object, including operator counts and no-match behavior. |
| Search offsets | Implement `/pattern/e`, line/character offsets, and the resulting inclusive/exclusive motion rules. |
| Large-document navigation | Reduce synthetic arrow-event volume without guessing Docs' word boundaries or losing exact ranges. |

## Motion and selection follow-ups

- Make logical paragraph lines versus rendered display lines explicit and consistent. Normal `j/k`, linewise `V`, and Home/End remain display based; modeled Visual motions and counted document jumps use paragraph breaks.
- Support all column-preservation cases, tabs, variable-width graphemes, and virtual-column behavior. `gg/G` currently choose a grapheme column, not a tab-expanded screen column.
- Audit remaining aliases and boundaries: `_` counts, counted `$`, `g^/g0/g$`, `gI`, and native `h/l` at paragraph boundaries. `I` currently uses Home rather than first nonblank.
- Implement `H/M/L`, `zt/zz/zb`, sentence motions, and reliable blank-line paragraph motions instead of Docs' paragraph shortcuts.
- Add `%` with bracket nesting and quote/escape handling.
- Add marks, the jump list, and normal-mode `Ctrl+o/Ctrl+i` with document positions that survive collaborator edits.
- Preserve the entire span when converting a multiline charwise selection to `V`.
- Make horizontal/word motions in `V` keep whole lines while moving the logical cursor, instead of ignoring them.
- Add `gv`, previous-selection restoration, and Visual block mode with rectangle-aware editing.
- Fully audit repeated `iw/aw/iW/aW` across blank paragraphs and indentation. Same-line cases are covered; cross-paragraph whitespace/object counts still need broader differential tests.
- Add quoted, paired-delimiter, sentence, and nested block text objects with counted selection.
- Distinguish mouse selection anchor/focus reliably, including reverse dragging and native selection replacement.

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
- Avoid expensive clipboard reads for empty prefixes through a reliable supported selection signal. Do not infer successful text extraction solely from a transient caret rectangle.
- Improve cursor font/zoom measurement when the hidden input font differs from rendered text; keep cosmetics free of document reads.
- Audit Mac modifiers, international keyboard layouts, IME composition, tables, lists, footnotes, headers, suggestions, and multi-tab Docs documents.
- Add accessibility labels and navigation for a richer search command line without stealing the editor's selection or typing focus.

References: [Neovim motion rules](https://neovim.io/doc/user/motion/), [Visual mode](https://neovim.io/doc/user/visual/), [search commands](https://neovim.io/doc/user/pattern/), and [default mappings](https://neovim.io/doc/user/quickref/).
