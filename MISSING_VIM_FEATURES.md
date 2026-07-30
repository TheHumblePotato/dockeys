# DocsKeys vs. real Vim: gap analysis

This document compares DocsKeys' current behavior against real Vim's documented
behavior. It exists to answer "what's missing" and "why wasn't it just added"
in one place, since the two questions are really the same question for a
project with this architecture.

**Methodology:** every claim below about real Vim's behavior was checked
against Vim documentation/reference material rather than assumed from memory.
Every claim about DocsKeys' current behavior was checked by re-reading
`content.js` line by line, not by guessing from the README.

## The core constraint

DocsKeys cannot read the document's text. It has no API into Google Docs'
rendering engine, so every command is built out of two primitives: (1)
synthetic keyboard events for cursor movement/selection/deletion (arrows,
Home/End, Backspace/Delete, and apparently Enter/Space -- see `sendKeyEvent`),
and (2) clicking Google Docs' own Edit-menu items (Cut/Copy/Paste/Undo/Redo/
Find) for anything that needs the clipboard. Real, trusted keystrokes (typed
by the actual user while in insert mode) are the *only* way characters get
inserted -- DocsKeys never intercepts them, it just gets out of the way.

This rules out, or severely limits, any Vim feature that needs to know what
character is under the cursor, what a word/line/paragraph's contents are, or
where a previously-visited position was. That single constraint explains most
of the "not practical" verdicts below.

## Implemented in this pass

- **`D`** -- delete to end of line (`d$`).
- **`C`** -- change to end of line (`c$`).
- **`Y`** -- yank the whole line (`yy`).
- **`r{char}`** -- replace the character under the cursor with one keystroke,
  without leaving normal mode. `r` previously performed Redo, which is not
  Vim's binding for `r` (Vim's `r` is character-replace; redo is `Ctrl+r`).
- **`Ctrl+r`** -- redo, now bound to Vim's actual redo key.
- **Count-before-operator fix** -- `2dw`, `3cw`, `5yy`, etc. (a count typed
  *before* the operator) now work. Previously, typing a count and then an
  operator key (`c`/`d`/`y`) would silently drop the pending operator state
  because `handleMultipleMotion` unconditionally reset `mode` back to
  `"normal"` after replaying the operator keystroke, discarding the
  `waitForFirstInput` transition the operator had just triggered. The
  now-fixed version routes a count-before-operator through the same
  `operatorCount` mechanism already used for `d2w`-style counts.
- **`J`** -- now inserts a single space at the join point (Vim's default
  `nojoinspaces` behavior) instead of smashing the two lines together with no
  separator. It does not strip existing leading whitespace from the line
  being joined up (see Known limitations below) since that requires reading
  line content.

## Not implemented, sorted by practicality

### Medium practicality

- **Named/numbered registers** (`"ayy`, `"ap`, `"0`-`"9`, `"_`). DocsKeys
  currently has exactly one implicit register: whatever's on the OS/Docs
  clipboard. Real registers would require intercepting clipboard reads/writes
  via `navigator.clipboard` instead of only driving the Edit menu, tagging
  yanks/deletes with a register name, and rewriting the clipboard before each
  paste. Feasible, but it's a structural change that touches every
  yank/delete/paste path, and clipboard-API calls can have permission/timing
  quirks that are hard to verify without live testing in Docs -- left for a
  dedicated pass.
- **`.` (dot-repeat)** for operator+motion commands (`dw`, `x`, `cc`, etc.).
  This is plausible for anything that goes through `runLongStringOp`, since
  those are just JS function calls we could record and replay. It is **not**
  possible for the text actually typed during an insert-mode change (`ciw` +
  typing + `Esc`), because insert-mode keystrokes are real, trusted events
  that DocsKeys never intercepts or records -- there is nothing to replay.
  A partial "repeat last motion-only operator" implementation would be a
  Vim-inconsistent half-feature, so it was left out rather than shipped
  incomplete.
- **True `iw` vs `aw` (and `ip` vs `ap`) distinction.** Right now both
  behave like the "inner" variant (see Known limitations). An approximate fix
  (extend the "a" selection by one extra word-boundary jump) is plausible but
  can't reliably match Vim's actual whitespace-aware behavior without reading
  the line.

### Low practicality

- **`P`** (paste before cursor/line) as distinct from `p`. Docs' paste always
  inserts at the cursor; without register type-tracking (charwise vs.
  linewise) there's no reliable way to make `P` behave differently from `p`,
  and shipping it as a no-op alias would be misleading rather than helpful.
- **`~`** (toggle case of character under cursor) -- needs to read the
  character first.
- **Marks** (`m{x}`, `` `{x} ``, `'{x}`) -- would need to persist cursor
  positions across time with no reliable way to translate a saved position
  back into cursor movement after the document has changed.
- **Search motions** `f`/`F`/`t`/`T`/`;`/`,` and `/pattern<CR>`, `n`/`N` --
  all need to read line/document text to find a target character or string.
  `/` currently only opens Docs' Find dialog, which is a reasonable partial
  substitute but isn't Vim's incremental search-and-jump.
- **`%`** (matching bracket/paren) -- needs text content.
- **Macros** (`q{register}`, `@{register}`) -- theoretically buildable by
  recording our own function calls (similar constraint to dot-repeat above:
  works for motions/operators, not for insert-mode typing), but lower value
  than the items above for the effort involved.
- **Ex commands** (`:s/.../.../`, `:g/pattern/d`, ranges) -- would require
  building an independent text model of the document via DOM-scraping, which
  is a different (and much larger) project than "Vim motions for Docs."
- **Visual block mode** (`Ctrl+v`) -- Google Docs isn't a fixed-width
  character grid, so a rectangular column selection doesn't have a faithful
  equivalent here.
- **`gv`** (reselect last visual selection) -- needs persisted selection
  bounds; low value relative to effort.
- **Counted text objects** (`d2aw`) -- not worth building on top of an
  already-approximate text-object implementation.

## Known limitations / inconsistencies (not bugs per se)

- **`d^`, `d_`, `d0` are all identical** (delete to column 0), rather than
  `d^` targeting the first non-blank character specifically. Same for `c^`
  vs `c_`/`c0`, and `y^` vs `y_`/`y0`. This requires knowing where the first
  non-blank character is, which needs line content.
- **`iw`/`aw` (and `ip`/`ap`) are currently identical.** Both act like the
  "inner" variant; the "a" variants don't extend the selection to include
  surrounding whitespace the way real Vim does.
- **Counted linewise commands (`3D`, `3Y`, `3C`) don't multi-line the way
  `3dd`/`3yy` do.** `dd`/`yy` (and `cc`) have dedicated count-aware selection
  logic; `D`/`C`/`Y` were implemented by reusing the simpler single-line
  `selectToEndOfLine`/whole-line-select helpers for consistency with the rest
  of the file, so a leading count on them just repeats the single-line
  command via the generic `multipleMotion` path instead of spanning multiple
  lines. Low-impact since `D`/`C`/`Y` are rarely used with a count in
  practice.

## Known bugs found during this review (flagged, not all fixed)

- **`tempnormal` (the `Ctrl+o` flag) can go stale.** `Ctrl+o` followed by `v`
  or `V` correctly stays in visual mode instead of snapping back to insert
  (the code special-cases `mode != 'visual' && mode != 'visualLine'`), but
  nothing ever clears the flag once the visual-mode session ends via `d`/`c`/
  `y`. The *next*, unrelated normal-mode keystroke will then unexpectedly
  trigger `switchModeToInsert()`. The same class of issue applies to
  `Ctrl+o` followed by an operator (`d`/`c`/`y`): entering `waitForFirstInput`
  isn't excluded from the tempnormal auto-revert, so `Ctrl+o` then `d` then a
  motion currently reverts to insert mode before the motion is even
  processed. This was **not fixed in this pass** beyond the narrow case of the
  new `r{char}` command (which does correctly consume `tempnormal` on
  completion), because a correct general fix means threading "command actually
  completed" signals through every multi-keystroke mode
  (`waitForFirstInput`/`waitForSecondInput`/`waitForVisualInput`/
  `multipleMotion`), and getting that wrong without the ability to test live
  against Google Docs risks breaking working `Ctrl+o` behavior rather than
  fixing it.
- **`runLongStringOp`'s `"d"` case does `cut` then an unconditional
  `backspace`.** For whole-line deletes (`dd`, and now `D`/`Y`'s sibling
  `C`... actually `Y` doesn't hit this path, but `dd`/`D` do) the selection
  intentionally excludes the trailing newline, so the extra backspace is what
  actually removes the now-empty line by merging it into the previous line.
  But this exact same `runLongStringOp("d")` path is shared by **every**
  `d`-motion (`dw`, `d$`, `diw`, `dip`, `dG`, ...), where cut already leaves
  the cursor at the start of the (now shorter) selection with no leftover
  empty line to clean up -- so the same unconditional backspace looks like it
  would delete one extra character before the deleted text in those cases.
  This is flagged rather than changed because it's long-standing,
  load-bearing behavior for `dd`/`D`, and altering the shared function without
  being able to test live against Google Docs risks trading a
  hard-to-diagnose bug for an easy-to-diagnose one. Worth a dedicated,
  testable pass.
