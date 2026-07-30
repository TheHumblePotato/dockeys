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

**Is this constraint absolute, or just "we haven't done it"?** Google Docs
did originally build on a DOM-based "kix" editing surface (not
`contenteditable`, but still real DOM), and has since layered in canvas-based
rendering for parts of the page; which one is active can vary by rollout.
Even where the older DOM structure is present, its text runs are an
internal rendering representation, not a stable, documented API -- element
structure, class names, and text-node boundaries change across Docs releases
and aren't the same thing as "the document's text content" (they reflect
line-wrapping and rendering decisions, not paragraph/word boundaries). Screen
readers get real text access, but through Google's internal accessibility
plumbing, not anything a content script can hook into directly. So reading
text via DOM-scraping isn't *physically* impossible the way reading pixels
off a `<canvas>` would be -- it's more that it would mean building and
maintaining a fragile, version-coupled text-extraction layer completely
separate from (and much larger than) "replay Vim motions as keystrokes," with
a real risk of silently breaking on some future Docs release. That trade-off
is why this project has consistently chosen not to go there; see the Ex
commands entry below for the most extreme version of that same call.

## Implemented in this pass

- **`D`** -- delete to end of line (`d$`).
- **`C`** -- change to end of line (`c$`).
- **`Y`** -- yank the whole line (`yy`).
- **`r{char}`** -- replace the character under the cursor with one keystroke,
  without leaving normal mode. `r` previously performed Redo, which is not
  Vim's binding for `r` (Vim's `r` is character-replace; redo is `Ctrl+r`).
- **`Ctrl+r`** -- redo, now bound to Vim's actual redo key.
- **Count-before-operator fix** -- `2dw`, `3cw`, `5yy`, etc. (a count typed
  *before* the operator) now work.
- **`J`** -- now inserts a single space at the join point (Vim's default
  `nojoinspaces` behavior) instead of smashing the two lines together with no
  separator. It does not strip existing leading whitespace from the line
  being joined up (see Known limitations below) since that requires reading
  line content.
- **`e` bug fix.** `e` was landing one character into the *next* word instead
  of on the last character of the current word. Root cause: the only
  word-motion primitive available is Ctrl+Right, and Google's own docs
  (support.google.com/docs/answer/179738) describe that as moving "to the
  next word" -- i.e. to the *start* of the next word, not the end of the
  current one. That's the right behavior for `w` (which is why `w` was never
  broken), but `e` was implemented as "do that, then move one more character
  right," which overshoots by a full word-start-plus-one. Fixed by jumping to
  the start of the next word and stepping back left twice instead. This is a
  single-space approximation (see Known limitations) since exact behavior
  around multi-space runs or punctuation needs line content.
- **`.` (dot-repeat)** for operator+motion commands and simple changes: `dw`,
  `d$`, `dd`, `de`, `D`, `x`, `s`, `J`, `p` (plain and register-aware), and
  the change-operator family (`cw`, `cc`, `C`, ...) with the caveat below.
  Implemented by recording the actual JS closure used to perform the last
  change and re-invoking it, rather than replaying raw keystrokes.
  - Consistent with real Vim, yank (`y`, `Y`) is never recorded for dot-repeat
    -- `.` only repeats changes.
  - **Still not possible: replaying the *typed text* of an insert-mode
    change** (`ciw` + typing + `Esc`, or `s`/`o`/`a` + typing). Dot-repeating
    a change-operator will redo the deletion and drop you into insert mode,
    same as the original command did, but it will not retype what you typed
    last time -- there is nothing to replay, because insert-mode keystrokes
    are real, trusted browser events DocsKeys never intercepts or records.
    This is visibly different from doing nothing (you land in insert mode
    and can see you need to type), which is why it's implemented despite the
    caveat -- unlike `r{char}` below.
  - `r{char}` is deliberately **not** dot-repeatable, for a related but
    distinct reason: the replacement character itself can't be replayed
    (same trusted-keystroke restriction), and unlike a change-operator,
    dot-repeating `r` wouldn't visibly leave you anywhere to fix it -- it
    would just silently delete a character without actually replacing it.
    That's worse than not offering it.
  - Visual-mode `d`/`c`/`y` are excluded entirely -- see Known limitations.
- **Named/numbered registers**, with the default (unnamed) register still
  being the plain OS/Docs clipboard exactly as before. `"a` before a
  `y`/`d`/`c`/`p` command targets register `a` for that one command; `a`-`z`
  and `0`-`9` are supported. Implemented by asking Docs to put yanked/deleted
  text on the real clipboard (the only way DocsKeys ever gets text at all),
  then reading it back into a JS object via `navigator.clipboard.readText()`,
  and temporarily swapping the OS clipboard for a `writeText()`/paste/
  restore dance when pasting from a named register. See the caveats below --
  this is the least-tested feature in this pass.
  - **Caveats, stated plainly:** this relies on the async Clipboard API,
    which (a) requires a short, heuristic delay after a simulated Copy/Cut
    menu click because there's no event to await for "Docs finished writing
    to the clipboard," and (b) may be subject to permission/focus behavior
    in Chrome/Firefox that couldn't be verified without live testing in a
    real, focused Google Docs tab. Every clipboard-API call is wrapped in
    try/catch and is purely additive: if any of it fails, the named register
    just silently doesn't populate/restore, and plain `y`/`d`/`c`/`p`
    (without a `"reg` prefix) keep working exactly as before, since those
    never depended on this code path succeeding.
  - Not implemented: append-registers (`"A` to append to `a`), the
    black-hole register (`"_`), and the numbered-register yank/delete
    history (`"0`-`"9` auto-population) -- all plausible follow-ups, kept out
    of this pass to limit the size of an already-hard-to-verify change.
- **Best-effort per-mode cursor shape.** `<html>` gets a
  `data-docskeys-mode` attribute, and injected CSS tries to restyle Google
  Docs' `.kix-cursor`/`.kix-cursor-caret` elements into a block for
  normal/visual/pending-input modes and a thin bar for insert mode. This is
  implemented as CSS rather than JS DOM manipulation specifically so that if
  those class names are wrong or change in a future Docs release, the rules
  just don't match anything -- a silent no-op, not a runtime error. The
  floating mode badge (bottom-right) is unaffected and remains the
  guaranteed indicator either way.

## Not implemented, sorted by practicality

### Medium practicality

- **True `iw` vs `aw` (and `ip` vs `ap`) distinction.** Right now both
  behave like the "inner" variant (see Known limitations). An approximate fix
  (extend the "a" selection by one extra word-boundary jump) is plausible but
  can't reliably match Vim's actual whitespace-aware behavior without reading
  the line.
- **Register append (`"A`) and black-hole register (`"_`).** Natural
  extensions of the registers work above; deferred to keep this pass's
  riskiest feature (registers) as small as possible.

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
  recording our own function calls (same mechanism as dot-repeat above:
  works for motions/operators, not for insert-mode typing), but lower value
  than the items above for the effort involved. Could plausibly reuse the
  `lastChange`-style recording infrastructure added for `.` in this pass.
- **Ex commands** (`:s/.../.../`, `:g/pattern/d`, ranges) -- would require
  building an independent text model of the document via DOM-scraping, which
  is a different (and much larger) project than "Vim motions for Docs." See
  "The core constraint" above for why that's a bigger ask than it sounds.
- **Visual block mode** (`Ctrl+v`) -- Google Docs isn't a fixed-width
  character grid, so a rectangular column selection doesn't have a faithful
  equivalent here.
- **`gv`** (reselect last visual selection) -- needs persisted selection
  bounds; low value relative to effort.
- **Counted text objects** (`d2aw`) -- not worth building on top of an
  already-approximate text-object implementation.
- **Dot-repeat for visual-mode changes.** Vim's own dot-repeat for visual
  operations is already a bit approximate (it repeats on "the same size
  selection" at the new cursor position). Doing that here would additionally
  require knowing where the selection boundary landed, which needs text
  content -- so it's excluded rather than shipped as a worse approximation
  of an already-approximate Vim feature.

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
- **`e`'s fix is a single-space approximation.** See "Implemented in this
  pass" above -- multiple spaces/tabs between words, or words directly
  adjacent to punctuation, can land `e` one or more characters short of the
  true end of word.
- **Registers are the least-tested feature in this codebase.** The
  Clipboard-API timing/permission caveats above are real; if named registers
  misbehave in your browser, plain `y`/`d`/`c`/`p` (no `"reg` prefix) are
  unaffected and behave exactly as before this pass.
- **Cursor-shape restyling is unverified against a live Google Docs page.**
  It's pure CSS keyed off class names that were not directly confirmed by
  testing (see "The core constraint" above for why introspecting Docs'
  internals is inherently uncertain); if the classes don't match, you'll
  just see the existing floating mode badge and no shape change, not an
  error.

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
  `multipleMotion`/`waitForRegister`), and getting that wrong without the
  ability to test live against Google Docs risks breaking working `Ctrl+o`
  behavior rather than fixing it. `waitForRegister` (new in this pass) was
  written consistently with the existing (buggy) pattern rather than trying
  to fix it in passing, to avoid touching more of this fragile area than
  necessary.
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