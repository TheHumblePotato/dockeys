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

- **`e` bug fix (gets stuck on repeat).** `e` previously computed the exact
  same "next word start via Ctrl+Right" both on a fresh press and on a
  repeated press, so `ee`/`2e` never advanced past the first word -- visibly
  wrong, since Vim's own docs state "In Vim `ee` and `2e` are the same."
  Root cause and fix: Ctrl+Right always jumps to the start of the *next*
  word regardless of where inside the current word the cursor already sits,
  so "jump word, then step back 2" recomputes the same target if the cursor
  was already at an end-of-word position. Fixed by nudging the cursor
  forward two plain characters *before* the word-jump, which forces the
  jump to skip past the current word's boundary on a repeated press while
  leaving a fresh in-word press unaffected. Still a single-space
  approximation around multi-space runs / punctuation directly touching a
  word (e.g. hyphens) -- that part needs line content and isn't fixed here.
- **`d<Esc>` (and any operator-cancel, and every yank) moving the cursor
  left by one character.** `switchModeToNormal()` unconditionally sent an
  extra `left` arrow whenever `mode == "waitForFirstInput"`. The only
  legitimate reason for this appears to have been compensating cursor
  position for whole-line deletes -- but the `dd`/`d`-operator call site
  already explicitly sets `mode = 'normal'` *before* calling
  `switchModeToNormal()`, specifically to dodge this exact branch. That left
  the branch dead for its one intended case and live for three unintended
  ones: cancelling an operator with Escape, cancelling with an invalid key,
  and completing any yank (`yw`, `yy`, `y$`, ...) -- all of which reach
  `switchModeToNormal()` while `mode` is still `"waitForFirstInput"`. Fixed
  by removing the branch entirely (the `visualLine` branch is untouched and
  still needed).
- **Unconditional extra-Backspace bug on every non-linewise `d`-motion.**
  Previously flagged here but left unfixed: `runLongStringOp`'s `"d"` case
  did `Cut` and then an *unconditional* extra `Backspace`. That backspace is
  only correct for whole-line deletes, where Home-to-End selection
  deliberately excludes the trailing newline and needs one more Backspace to
  merge the resulting empty line away. Every other `d`-motion's selection
  (e.g. `selectToEndOfWord`'s Ctrl+Shift+Right, which already includes the
  trailing space) doesn't leave anything to merge, so the same unconditional
  backspace was silently deleting one extra, unrelated character before the
  target on `dw`, `D`, `diw`, `d$`, and friends. Fixed by adding a
  `linewise` parameter to `runLongStringOp`, defaulting to `false`, and only
  passing `true` from the actually-linewise call sites (`dd`/`2dd`-style
  repeated-operator deletes, and the new `dj`/`dk` below). This also
  incidentally fixes `D`, which shares this code path and was getting the
  bogus extra backspace before.
- **`dh`, `dl`, `dj`, `dk`, `db`/`dB`** (and the `c`/`y` equivalents) as
  operator-pending motions -- previously, only `w`/`e`/paragraph/line-start/
  line-end/`g`/`G`/the doubled-operator (`dd`) were recognized after an
  operator, so e.g. `dl`, despite `l` being a perfectly normal motion, did
  nothing. `dh`/`dl` are implemented charwise (select `count` characters
  left/right, then cut/copy/change) matching Vim's `dl` ≡ `x` and `dh` ≡
  Backspace equivalence. `dj`/`dk` are implemented **linewise**, matching
  real Vim exactly: `dj` deletes the current line and the line below (2
  lines total), `dk` deletes the current line and the line above (2 lines
  total), and a leading count extends this the same way `dd`'s count does
  (`d2j` deletes 3 lines: current + 2 below).
- **`d{` / `d}`** added as operator motions, in addition to the pre-existing
  `p`/`ip` paragraph aliases (kept for backwards compatibility). Implemented
  the same way as the existing `p`-based paragraph select (charwise, not
  the special exclusive-to-linewise promotion real Vim applies to `}` when
  standing on a paragraph's first non-blank -- see the "Known limitations"
  entry below for why that specific edge case isn't replicated).
- **`W`, `E`, `B`** (WORD motions) added for normal mode, visual mode, and
  as operator-pending motions. **These are currently honest aliases of
  `w`/`e`/`b`.** Real Vim's WORD motions differ from word motions by
  ignoring punctuation and only treating whitespace as a boundary; telling
  that apart requires knowing what character is at the boundary, which this
  architecture cannot do (see "The core constraint" above). Rather than
  silently shipping W/E/B as identical without saying so, this is called out
  explicitly here and in the README.
- **Cursor sizing.** The block cursor's width was previously a flat `0.6em`,
  which doesn't track the actual character/font size and looked wrong across
  different font sizes (e.g. headings vs. body text). Switched to `1ch`, a
  CSS unit defined as the width of the "0" character in the element's own
  font -- still an approximation (not every character is exactly "0"-width),
  but one that actually responds to the surrounding font/size instead of
  being a constant. Still unverified against a live Docs page, same caveat
  as before.
- **Underscore cursor for pending-input modes.** Per user preference, all
  "waiting on one more keystroke" modes (`waitForFirstInput` after `d`/`c`/
  `y`, `waitForSecondInput` after the `i`/`a` text-object prefix,
  `replaceChar` after `r`, `waitForRegister` after `"`, `waitForVisualInput`
  after `i`/`a` in visual mode) now get a distinct underscore-shaped cursor
  (`transform: scaleY(0.18)` anchored to the bottom) instead of sharing the
  full block cursor with normal/visual mode. Implemented as a CSS transform
  on whatever height Docs' own element already has, rather than a hardcoded
  pixel height, so it doesn't need to know the actual line-height/font-size
  to look roughly right.

## Implemented in prior passes

- **`D`** -- delete to end of line (`d$`).
- **`C`** -- change to end of line (`c$`).
- **`Y`** -- yank the whole line (`yy`).
- **`r{char}`** -- replace the character under the cursor with one keystroke,
  without leaving normal mode.
- **`Ctrl+r`** -- redo, bound to Vim's actual redo key.
- **Count-before-operator fix** -- `2dw`, `3cw`, `5yy`, etc.
- **`J`** -- inserts a single space at the join point (Vim's default
  `nojoinspaces` behavior). Does not strip existing leading whitespace from
  the line being joined up (see Known limitations) since that requires
  reading line content.
- **`.` (dot-repeat)** for operator+motion commands and simple changes.
  Consistent with real Vim, yank (`y`, `Y`) is never recorded for dot-repeat.
  Still not possible: replaying the *typed text* of an insert-mode change.
  `r{char}` is deliberately not dot-repeatable.
- **Named/numbered registers**, with the default (unnamed) register still
  being the plain OS/Docs clipboard.

## Not implemented, sorted by practicality

### Medium practicality

- **True `iw` vs `aw` (and `ip` vs `ap`) distinction.** Right now both
  behave like the "inner" variant (see Known limitations). An approximate fix
  (extend the "a" selection by one extra word-boundary jump) is plausible but
  can't reliably match Vim's actual whitespace-aware behavior without reading
  the line.
- **Register append (`"A`) and black-hole register (`"_`).** Natural
  extensions of the existing registers work; deferred to keep that
  (already-least-tested) feature's surface area small.

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
  recording our own function calls (same mechanism as dot-repeat), but lower
  value than the items above for the effort involved.
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
  operations is already a bit approximate; doing that here would
  additionally require knowing where the selection boundary landed, which
  needs text content -- excluded rather than shipped as a worse
  approximation of an already-approximate Vim feature.
- **True word/WORD distinction for `w`/`W`, `e`/`E`, `b`/`B`.** See "W, E, B"
  above -- currently honest aliases, since this needs to read text to
  distinguish punctuation from whitespace boundaries.
- **`gg` as a true double-`g` prefix.** Real Vim's `gg` (go to top) requires
  two `g` presses, with a single `g` being a pending prefix for a family of
  `g`-commands (`ge`, `gE`, `g_`, ...). This project binds a single `g` press
  directly to "go to document start" as a simplification. Left as-is in this
  pass: changing it to a genuine two-key prefix is a bigger state-machine
  change than it looks (needs its own pending-input mode, interacts with
  operator-pending `dg`/`dgg`, counts like `42gg`, and dot-repeat) and isn't
  something that can be safely verified without live testing against Docs, so
  it wasn't touched to avoid trading a known, harmless simplification for an
  untested behavior change.
- **`d}`'s exclusive-to-linewise promotion.** Real Vim: if `}` is used with an
  operator and the cursor started at or before the first non-blank character
  of a paragraph that begins with blank lines, the motion is promoted from
  exclusive-charwise to linewise, sweeping up the leading blank lines too.
  This needs to know whether the cursor is at/before the first non-blank of
  the current line, which needs line content -- `d{`/`d}` here are plain
  charwise selects instead.

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
  adjacent to punctuation, can still land `e` one or more characters short of
  the true end of word.
- **`W`/`E`/`B` are aliases of `w`/`e`/`b`,** not true WORD motions. See
  above.
- **Registers are the least-tested feature in this codebase.** The
  Clipboard-API timing/permission caveats are real; if named registers
  misbehave in your browser, plain `y`/`d`/`c`/`p` (no `"reg` prefix) are
  unaffected and behave exactly as before.
- **Cursor-shape restyling is unverified against a live Google Docs page.**
  It's pure CSS keyed off class names that were not directly confirmed by
  testing (see "The core constraint" above for why introspecting Docs'
  internals is inherently uncertain); if the classes don't match, you'll
  just see the existing floating mode badge and no shape change, not an
  error. This includes the new `1ch` sizing and underscore transform.

## Known bugs found during review (flagged, not all fixed)

- **`tempnormal` (the `Ctrl+o` flag) can go stale.** `Ctrl+o` followed by `v`
  or `V` correctly stays in visual mode instead of snapping back to insert
  (the code special-cases `mode != 'visual' && mode != 'visualLine'`), but
  nothing ever clears the flag once the visual-mode session ends via `d`/`c`/
  `y`. The *next*, unrelated normal-mode keystroke will then unexpectedly
  trigger `switchModeToInsert()`. The same class of issue applies to
  `Ctrl+o` followed by an operator (`d`/`c`/`y`): entering `waitForFirstInput`
  isn't excluded from the tempnormal auto-revert, so `Ctrl+o` then `d` then a
  motion currently reverts to insert mode before the motion is even
  processed. Not fixed in this pass either, for the same reason as before: a
  correct general fix means threading "command actually completed" signals
  through every multi-keystroke mode, and doing that without the ability to
  test live against Google Docs risks breaking working `Ctrl+o` behavior
  rather than fixing it. The newly-added `h`/`j`/`k`/`l`/`b`/`B`/`W`/`E`/
  `{`/`}` operator-pending cases were written consistent with the existing
  pattern (they complete and return via `runLongStringOp`/`switchModeTo*`
  same as `w`/`e` did before), so they don't make this particular bug worse,
  but they don't fix it either.
- **`runLongStringOp`'s old unconditional `"d"`-case Backspace bug is now
  fixed** (see "Implemented in this pass" above) rather than just flagged --
  this entry is kept here as a historical note in case any custom mapping
  elsewhere still assumes the old (buggy) behavior.