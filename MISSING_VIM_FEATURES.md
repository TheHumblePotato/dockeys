# Remaining Vim/Neovim compatibility work

DocsKeys controls Google Docs through synthetic keyboard events and menu actions. It has no editable buffer API. Precise reads use the clipboard and are scoped to the current wrapped display line. This boundary determines which features can be reliable.

## Implemented

- Normal, insert, charwise Visual, linewise Visual, and operator-pending commands.
- Counts, multiplied operator counts, word/WORD motions, `f/F/t/T`, and `;/,` repeats.
- Grapheme-aware motion calculations, including emoji and combining marks.
- `iw/aw/iW/aW`, paragraph approximations, registers, case toggling, and limited dot repeat.
- Neovim-style `Y` as `y$`, arrow/Home/End aliases, `Ctrl+[` escape, mode toggles, and temporary normal mode.
- Persistent controls for DVP, box cursor, mode badge, initial mode, and native/precise normal word jumps.
- Whole-line selection boundary handling, including short lines and an empty final line.
- Geometry-only cursor rendering, free viewport scrolling, and local-caret identification.

## Known approximations

| Area | Current behavior / constraint |
| --- | --- |
| Line semantics | Home/End define display lines. Wrapped paragraphs do not behave like unwrapped Vim buffer lines. |
| Fast word mode | Normal `w/b` use Docs word boundaries. Operators and other text-based motions still read text. |
| Cross-line words | Native fallbacks can differ from Vim punctuation and whitespace rules. Counts are preserved. |
| Word operators | Some `cw`, end-of-line `dw`, and cross-line operator cases still follow Docs selection behavior. |
| Visual snapshots | Exact only within the original display-line snapshot; collaborative text changes can invalidate it. |
| Native selection repair | Uses local caret geometry, and may copy a selection when crossing the anchor. Docs must expose a measurable local caret. |
| Visual line mode | Only vertical/document/paragraph motions move it. Word/horizontal motions are ignored. |
| Visual `$` | Stops before the line break. |
| Visual conversions | Switching a multiline charwise selection to `V` starts at the first selected line. |
| Document navigation | Single `g` is retained as a document-start shortcut; full `g` prefix/count semantics are not implemented. |
| Paragraphs | Docs paragraph jumps differ from Vim's blank-line-based paragraphs. |
| Cursor width | Estimated from the input font and caret height; no cosmetic text reads. |
| Page motions | Screen size and line counts are estimated; Docs wrapping/page layout can alter the result. |
| Clipboard | Text only. Reading can briefly replace and then restore plain text; rich content is not preserved. External clipboard writes during that window may conflict. |
| Dot repeat | Cannot replay insert-mode text, Visual changes, or `r{char}`. |
| Replace | A replacement character queued during an asynchronous read cannot be retyped as a trusted native event; the replacement is cancelled. |
| Registers | Explicit/named and cut registers are supported, but automatic numbered-register rotation and Vim's full unnamed-register semantics are not. |

## Practical follow-up work

1. Add browser integration coverage against real Docs pages, especially wrapped paragraphs, tables, page boundaries, selection caret geometry, and multiple collaborators.
2. Refine word-operator edge cases and preserve preferred columns through varying display-line widths.
3. Implement a proper `g` prefix parser before adding `ge`, `gE`, `gj/gk`, or counted document-line jumps.
4. Preserve full-line spans when converting existing multiline charwise selections to linewise mode.
5. Add richer clipboard preservation when browser permissions and supported formats allow it.
6. Improve document/iframe replacement handling for Docs navigation without a full reload.

## Features needing a stronger document model

- `%` bracket matching and nested bracket/quote/sentence text objects.
- True marks, jump lists, and persistent document positions.
- Search motions and `n/N` with Neovim-compatible operator integration.
- Reliable macros and insert-text dot repeat.
- Visual block mode and rectangular edits.
- Ex commands such as `:s`/`:g`, ranges, and command-line editing.
- Full undo grouping, indentation operators, and document-aware formatting.

A document model must stay correct under collaborators' edits, preserve formatting, and avoid private Docs internals that could change without notice. Clipboard snapshots alone do not solve those problems.

Behavior references: [Neovim motions](https://neovim.io/doc/user/motion/), [Visual mode](https://neovim.io/doc/user/visual/), and [default mappings](https://neovim.io/doc/user/quickref/).
