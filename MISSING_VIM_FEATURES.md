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

- **Box cursor, real attempt.** `kix-cursor-top` (already used for the
  thin/hidden cursor bar in insert vs. normal mode) now also gets its width
  set to roughly a character's width whenever normal/visual/visual-line mode
  is (re-)entered or the mode indicator refreshes (i.e. on essentially every
  motion), instead of staying Docs' native thin insert-style bar. Deliberately
  does NOT read the actual character under the cursor to measure it
  precisely -- that would mean a Copy+clipboard round trip on every single
  cursor-moving keystroke, undoing the last two passes' latency work.
  Instead it measures one representative character ("0") with a
  `canvas.measureText()` call against whatever font is currently active
  (read from the confirmed-real `docs-texteventtarget-iframe`'s
  contenteditable element's computed style) -- a synchronous, sub-millisecond
  operation with no clipboard involved, so it costs nothing on the latency
  front. Uses `kix-cursor-top`'s own existing height rather than guessing at
  line-height. This is confirmed-real-element-based rather than guessed
  class names, unlike the earlier reverted attempt, but the actual visual
  result (whether Docs' own JS ever resets this inline style on its own
  blink/redraw cycle, and whether "0"'s width is a good stand-in for
  whatever character is actually there) is still unverified against a live
  page.
- **Selection-highlight hiding during f/t/w/e/b/etc.: investigated and
  confirmed not possible, not just "unverified."** A live-page diagnostic
  (scanning every element for a selection-colored background during an
  active selection) found zero matching DOM elements, only `<canvas>` tiles
  (`kix-canvas-tile-content`). This matches Google's own stated reason for
  moving Docs off DOM rendering in 2021: DOM couldn't provide the text-layout
  precision needed to correctly highlight a selection in mixed
  left-to-right/right-to-left text. The selection highlight is painted
  directly into the same canvas pixels as the document text itself -- there
  is no separate overlay to hide, and no CSS/DOM trick can hide "just the
  highlight" without also hiding the text underneath it. Older tools (e.g.
  google-docs-utils' `getSelectionOverlayElements`) relied on exactly the
  DOM overlay this migration removed, which is why they stopped working at
  the same time. Not revisiting this again barring some future change to how
  Docs renders selections.

- **Visual-mode `w`/`W`/`e`/`E`/`b`/`B`/`f`/`F`/`t`/`T`/`;`/`,` actually
  getting stuck after one motion, for real this time.** The previous pass's
  fix (retracting with shift+arrow instead of a plain arrow) correctly
  stopped the read from *destroying* the visual-mode anchor, but that wasn't
  the whole bug: Shift+End/Shift+Home always extend relative to the anchor
  (wherever `v`/`V` was pressed), not the current focus/cursor -- so the
  *text* those reads returned started at the anchor too. Every motion after
  the first one was computing "next word" relative to that fixed, stale
  anchor point instead of the actual cursor, which stops making forward
  progress once the real cursor has moved past what the anchor-relative text
  still showed -- exactly "moves once, then stuck." Confirmed this was the
  actual mechanism with a standalone simulation of the read logic before
  and after the fix: unfixed, four consecutive simulated `w` presses landed
  on the same position four times in a row; fixed, they advanced through
  four different word starts as expected.

  Fixed by having DocsKeys track its own running count of "how many
  characters are already selected between the anchor and the current
  focus" (`visualSelectionChars`) -- straightforward since DocsKeys is the
  only thing that ever extends a visual-mode selection here -- and slicing
  that many characters off the front of whatever Shift+End/Shift+Home
  reads back, so the text handed to the word/find logic always represents
  "from the actual cursor", never "from the anchor". `V` additionally does
  one one-time Copy+read when first entering visual-line mode, to learn
  exactly how many characters its initial line-based selection spans
  (unlike the fixed 1-character selection `v` starts with).

  Known remaining gap, not fixed this pass: this tracking assumes the
  selection keeps growing in the *same direction*. Reversing direction
  mid-selection (e.g. extending forward with `w` a few times, then pressing
  `b` enough times to cross back through the anchor and extend backward
  past it) isn't accounted for, and neither is the cross-line native
  fallback (it can't know exactly how far Ctrl+Right/Left actually moved,
  so it resets the tracked count to 0 rather than carry forward a number
  it knows is wrong -- meaning the *true* anchor position is "forgotten"
  from that point on, though tracking then stays self-consistent again for
  whatever comes after).

- **Visual-mode `w`/`W`/`e`/`E`/`b`/`B`/`f`/`F`/`t`/`T` getting stuck after one
  motion.** Real bug in the previous pass: `readAfterCursor()`/
  `readBeforeCursor()` collapsed their temporary selection with a single
  plain (non-shift) arrow press after reading. A plain arrow on an active
  selection always collapses to one edge *and drops the anchor* -- harmless
  with nothing selected yet (normal mode), but in visual mode it silently
  destroyed the real anchor `v`/`V` had established, so every motion after
  the first one re-selected from scratch (from wherever the collapse landed)
  instead of extending the existing selection. Fixed by retracting the
  temporary selection with shift+arrow pressed exactly as many times as
  characters were read, instead of one plain arrow -- this undoes exactly
  the extension the read just made and nothing else, so a pre-existing
  visual-mode selection comes out the other side completely unchanged, and
  the next motion correctly extends it rather than restarting it.
- **`;`/`,` now work after an operator and in visual mode** (`d;`, `v;`),
  not just as a bare normal-mode motion.
- **Latency reduction, take two.** Two real fixes, not just tuning:
  - The fixed `REGISTER_READ_DELAY_MS` wait after every Copy/Cut (guessing
    how long Docs' async clipboard write takes) is replaced with
    `pollClipboardForChange()`, which polls the clipboard every ~12ms and
    returns as soon as it actually changes, instead of always waiting out a
    worst-case delay. In the common case this should be noticeably faster
    than the fixed wait was; it still falls back to a bounded max wait
    (250ms) for the rare case where the copied text happens to be identical
    to what was already on the clipboard.
  - `withClipboardSaved()`'s clipboard-restore write was previously
    *awaited* before returning control to the caller -- meaning every single
    oracle read (`f`/`t`/`w`/`e`/`b`) was waiting on a second clipboard
    round-trip it didn't actually need to block on. The restore now happens
    in the background; the caller gets its result as soon as the read
    itself resolves. Tradeoff: two oracle reads firing within single-digit
    milliseconds of each other could very rarely see each other's temporary
    copied text instead of the true original clipboard contents. Considered
    an acceptable, self-correcting-ish edge case given how much this was
    the actual latency complaint.

## Implemented in the previous pass

- **`e` bug fix (landing mid-word, e.g. between 'o' and 'n' in "discussions").**
  Root cause: the previous fix for the `ee`/`2e` repeat-press bug (see
  "Implemented in prior passes" below) nudged the cursor forward a fixed
  2 characters before a native Ctrl+Right word-jump, on the assumption the
  cursor was always sitting at a *previous* end-of-word position. That's true
  for a repeated press, but not for a fresh press from elsewhere in a word --
  there the same fixed nudge overshoots past the word's real end. Fixed by
  replacing the whole Ctrl+Right-based heuristic with an exact
  implementation: `w`/`e`/`b` (and now true `W`/`E`/`B`) are computed by
  reading the current line's text (the same clipboard-based oracle `f`/`t`
  use) and tokenizing it against Vim's actual word/WORD definitions --
  `word` = a run of `[A-Za-z0-9_]` or a run of other non-blank characters,
  `WORD` = any run of non-blank characters -- then counting the exact number
  of characters to move. Checked against Vim's own "`ee` and `2e` are the
  same" example directly (a unit test that repeats a single `e` twice and
  compares it against a counted `2e` on the same text), not just derived by
  inspection.

  This only knows about the current wrapped display line, the same scope
  `f`/`t` have. When a motion would need to continue onto another line (e.g.
  `w` from the last word of a line), it falls back to the old native
  Ctrl+Right/Ctrl+Left-based behavior for that one press -- exact within a
  line, approximate only at line-crossings, rather than approximate
  everywhere as before.

- **True `W`, `E`, `B`.** Previously honest aliases of `w`/`e`/`b` (see below
  -- this used to be the "not practical" answer, since telling word from
  WORD boundaries needs to read text DocsKeys couldn't read at the time).
  Now that the oracle exists, `W`/`E`/`B` tokenize with the WORD (whitespace
  is the only boundary) instead of word (alnum/punctuation/whitespace all
  boundaries) classifier, and are genuinely distinct from lowercase `w`/`e`/`b`.

- **Register/clipboard semantics overhaul.** Previously every `y`/`d`/`c` --
  named register or not -- went through Docs' Cut/Copy menu items, which
  always write to the real OS clipboard; a named-register yank (`"ayy`)
  silently clobbered whatever the user had copied from elsewhere, with no way
  to get it back. New behavior:
  - Plain `y` (no register): unchanged, goes straight to the OS clipboard.
  - `"{reg}y`: captured into that register only; the real OS clipboard is
    saved beforehand and restored afterward, so it's untouched by the end of
    the command.
  - Plain `d`/`c` (no register): now land in a new default register (`"-`,
    matching Vim's actual small-delete register name, though DocsKeys
    applies it to every cut rather than just character-wise-small ones) as
    an approximation) instead of the OS clipboard -- so repeated deleting no
    longer overwrites what the user meant to paste elsewhere. `"-p` pastes
    the last cut back; the real clipboard (`p` with no register) is
    unaffected by cuts.
  - `"{reg}d`/`"{reg}c`: land only in that register, same as `y`.
  - Register append mode: an uppercase register letter (`"Ayy`) appends to
    that register instead of overwriting it, per real Vim.
  - Black-hole register (`"_dd`): discards the deleted text entirely rather
    than storing it anywhere.

  Mechanically, deletion now always goes through synthetic Backspace on the
  active selection rather than Docs' Cut menu item, specifically so a delete
  to the black-hole register (or, in principle, a hypothetical future
  "don't bother with any register" mode) never has to touch the clipboard
  system at all. When a register capture *is* needed, the current OS
  clipboard is read (to know what to restore) before the capturing Copy
  click, and the read-back-and-restore happens in the background after the
  edit and mode switch are already done, so it doesn't block anything visible
  beyond that one initial clipboard read. Concurrent register-touching
  commands (e.g. mashing `"add` quickly) are serialized through a small
  promise queue so they can't race and clobber each other's saved clipboard
  snapshot.

- **Latency reduction for the text-reading oracle.** `f`/`F`/`t`/`T` (and now
  `w`/`e`/`b`) previously always read *both* directions around the cursor
  even though every caller only ever needs one side. Split into
  `readAfterCursor()`/`readBeforeCursor()`, each doing a single
  select+Copy+read+collapse instead of two -- roughly halves the round-trip
  latency for these commands. Also lowered `REGISTER_READ_DELAY_MS` from 80ms
  to 60ms; this hasn't been tuned against a live Docs page, so it may need
  raising back up if reads start coming back stale/truncated.

- **`^`/`_` vs `0`.** Previously identical (see "Known limitations" in the
  last pass). `^`/`_` now read the whole current line (both directions, via
  the oracle -- the one motion in this pass that needs both sides, since
  "first non-blank" is a property of the whole line rather than one side of
  the cursor) and move to the actual first non-blank character; `0` is
  unchanged (still the fast, oracle-free native Home).

- **Counted `D`/`C`/`Y` (`3D`, `3C`, `3Y`).** Previously didn't span multiple
  lines the way `3dd`/`3yy` do (see "Known limitations" in the last pass).
  Now `3D` deletes from the cursor to the end of the current line plus the
  next 2 full lines, matching `:help D`'s "and [count-1] more lines"; `3Y`
  yanks 3 full lines, matching `3yy`.



- **`f{char}`, `F{char}`, `t{char}`, `T{char}`** as normal-mode motions,
  operator-pending motions (`df{char}`, `dF{char}`, `dt{char}`, `dT{char}`,
  and the `c`/`y` equivalents), and visual-mode selection-extenders, plus
  `;`/`,` to repeat the last one forward/backward. This is the first
  DocsKeys motion that needs to know an actual character from the document,
  which "The core constraint" above says DocsKeys can't do -- but `f`/`t`
  only need to know the text of the *current line*, not the whole document,
  and DocsKeys already has clipboard read/write permission for registers.
  So instead of reading the DOM/canvas, `readCursorLineContext()` briefly
  selects cursor-to-line-start and cursor-to-line-end with Home/End (the
  same "line" `$`/`0`/`D`/`C` already use, i.e. the wrapped *display* line,
  not the paragraph -- see Known limitations below), clicks Docs' own Copy
  menu item, reads the OS clipboard, and collapses the selection back to
  the original cursor position -- twice (once for the text after the
  cursor, once for the text before), with the user's actual clipboard
  contents saved before and restored after, reusing the exact save/restore
  pattern `pasteRegister()` already established for named registers. Because
  every `f`/`t` press does a fresh, live read rather than consulting a
  cached copy of the document, this stays correct even while a collaborator
  is editing elsewhere in the doc -- there's no stored state to drift out
  of sync. The only accuracy risk is the read's own latency (roughly
  150-300ms, two clipboard round-trips at `REGISTER_READ_DELAY_MS` each): a
  collaborator editing at the exact cursor position during that window
  could make the read stale before it's used. Considered acceptable for a
  keystroke-triggered, non-realtime command.

  The inclusive/exclusive step-counting was checked directly against Vim's
  `:help f`/`:help t`/`:help F`/`:help T` (`f`/`t` inclusive, `F`/`T`
  exclusive) and verified against Vim's own worked example in `:help
  operator` ("abcXdef" with the cursor on `a`: `dfX` deletes `abcX`, `dtX`
  deletes `abc`) with a standalone unit test of the step-count arithmetic
  before wiring it into the keystroke layer, rather than trusting the
  derivation by inspection alone.

  One correctness subtlety specific to this Dvorak fork: the character
  argument to `f`/`F`/`t`/`T` is read from the *raw, untranslated* `e.key`,
  not the `translateKey()`-remapped value used for command letters
  elsewhere in this file. `translateKey()` exists to turn a physically
  Dvorak-typed key back into its QWERTY *command* label (so a physical key
  still means "delete" regardless of layout); but the character after
  `f`/`t` isn't a command, it's a literal character to search for in the
  document, and `e.key` already reflects the correct on-screen character
  under whatever OS keyboard layout is active. Translating it would search
  for the wrong character. (The existing `r` replace-character command
  sidesteps the same issue a different way: it never consumes the
  translated `key` for the replacement character at all, instead letting
  the untouched native keydown fall through to Google Docs after a
  synthetic delete.)

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
  behave like the "inner" variant (see Known limitations). This is more
  tractable than it used to be -- the word/WORD tokenizer built for `w`/`e`/`b`
  (see "Implemented in this pass" above) already knows exactly where a
  word's whitespace-inclusive "a" boundary would be -- but it hasn't been
  wired up yet.

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
- **Pattern search** `/pattern<CR>`, `?pattern<CR>`, `n`/`N` -- these need to
  read and search the *whole document* (or at least scroll-range) for an
  arbitrary pattern, not just the current line, which is a meaningfully
  bigger version of the "read document text" problem than `f`/`t` turned out
  to be (see "Implemented in this pass" below for how `f`/`F`/`t`/`T` do it).
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

- **`iw`/`aw` (and `ip`/`ap`) are currently identical.** Both act like the
  "inner" variant; the "a" variants don't extend the selection to include
  surrounding whitespace the way real Vim does.
- **`e`'s fix is a single-space approximation.** See "Implemented in this
  pass" above -- multiple spaces/tabs between words, or words directly
  adjacent to punctuation, can still land `e` one or more characters short of
  the true end of word.
- **`x`/`s` don't populate any register yet.** Real Vim's `x`/`s` write to
  the unnamed and small-delete registers same as any other delete; DocsKeys'
  `x`/`s` still just send a plain native Delete key, untouched by this
  pass's register work.
- **Register-qualified `y`/`d`/`c` (`"ayy`, plain `dd`/`cc` now included,
  since they default to `"-`) carry one small added latency step**: reading
  the OS clipboard's *current* contents (to know what to restore afterward)
  before the capturing Copy click. This is a plain `clipboard.readText()`
  with no artificial delay attached (unlike the ~60ms settle wait used after
  Docs' own Copy/Cut), so it should be on the order of a few ms in practice,
  but it's not zero the way a bare `y` (real OS clipboard, no register) still
  is.
- **`f`/`F`/`t`/`T` are scoped to the wrapped display line, not the
  paragraph.** They search within whatever Home/End already bounds -- same
  as the existing `$`/`0`/`D`/`C` -- so on a long paragraph that wraps
  across several screen lines, `f{char}` won't find a `{char}` that's
  visually one line down but still part of the same paragraph. Real Vim's
  own "line" is the buffer line (no hard wrap), so for a single unwrapped
  Google Docs paragraph this is arguably the more Vim-consistent choice
  anyway (Vim's `f`/`t` don't stop at soft-wrap boundaries either) -- but it
  does mean a *paragraph* that Google Docs wraps across multiple display
  lines behaves differently from a Vim buffer line that never wraps.
- **Counted `f`/`t` in visual mode (`3fx`) isn't supported.** `handleMultipleMotion`'s
  visual-mode branch repeats a command by calling its handler `n` times,
  which works for immediate motions but doesn't compose with a command that
  itself needs to wait for a follow-up keystroke -- doing `3fx` in visual
  mode would open three separate wait-for-a-character states instead of
  finding the 3rd occurrence. Normal-mode and operator-pending counts
  (`3fx`, `d3fx`) work correctly; only the visual-mode case is affected.
- **`f`/`F`/`t`/`T` briefly overwrite, then restore, the OS clipboard.**
  Same tradeoff registers already accept: if something outside DocsKeys
  writes to the clipboard in the same ~150-300ms window a find is running,
  that write could be lost when DocsKeys restores its saved copy afterward.
  Narrow window, but worth knowing about.
- **`f`/`F`/`t`/`T`'s pending-input mode (`waitForFindChar`) inherits the
  same `tempnormal` staleness bug already flagged below for `waitForFirstInput`
  and `waitForRegister`**: `Ctrl+o` followed by `f{char}` currently reverts
  to insert mode before the character is even read, for the same
  not-yet-fixed reason described there.
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