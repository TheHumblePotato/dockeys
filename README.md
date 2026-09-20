# DocsKeys

A browser extension that brings Vim-style keyboard shortcuts to Google Docs, allowing you to edit documents with familiar Vim motions and commands.

While this extension currently implements core Vim functionality including basic motions, text manipulation, dot-repeat, registers, and visual selections, there's room for expansion. Contributions are welcome to add more Vim features as per your need. See [MISSING_VIM_FEATURES.md](MISSING_VIM_FEATURES.md) for a breakdown of what's missing, why, and how hard each piece would be to add.

If you are using DocsKeys with Vimium, disable Vimium on Google Docs.

This project is heavily inspired by and uses much of code from [SheetKeys](https://github.com/philc/sheetkeys)

### Programmer Dvorak support

This fork translates keystrokes back to their QWERTY physical-key position
before interpreting them as Vim commands (the same trick Neovim's `langmap`
uses), so all the motions and commands below work from muscle memory even if
your OS keyboard layout is set to Programmer Dvorak. This is controlled by
the `DVORAK_MODE` constant at the top of `content.js` -- set it to `false` to
use raw QWERTY-style DocsKeys instead.

### Why can't DocsKeys read the document's text?

Google Docs doesn't use a standard editable HTML element
(`contenteditable`) -- it draws the document itself, with its own "kix"
rendering layer, partly for historical reasons (contenteditable across
browsers was too inconsistent for a full word processor) and partly because
its rendering has moved further toward canvas-based drawing over time. Either
way, there's no public API for a content script to ask "what does this line
say" and get a reliable answer back. The DOM/canvas structure that's
actually present reflects rendering decisions (line wrapping, page layout),
not a stable representation of paragraph/word content, and it isn't
documented or version-stable enough to build on safely.

That's why DocsKeys is built the way it is: every command is either a
synthetic keyboard event (arrows, Home/End, word-jump, Backspace/Delete) or a
simulated click on one of Google Docs' own Edit-menu items (Copy/Cut/Paste/
Undo/Redo/Find). It never touches document text directly -- it moves the
cursor and drives the same menu commands you could click yourself. This is
also why a handful of Vim features (search motions like `f`/`t`, `%`
bracket-matching, true `iw`/`aw` whitespace handling, true word/WORD
distinction for `w`/`W` etc., and Ex commands like `:s`) aren't implemented:
they fundamentally require knowing what character or word is at a given
position, which this architecture can't answer. See
[MISSING_VIM_FEATURES.md](MISSING_VIM_FEATURES.md) for the full breakdown,
including which of these are "not practical" vs. just "not done yet."

### Available Motions

#### Basic Movement
- `h` - Move cursor left
- `j` - Move cursor down
- `k` - Move cursor up
- `l` - Move cursor right
- `w` - Move to start of next word
- `b` - Move to start of previous word
- `e` - Move to end of current word (or next word's end, if already at one).
  Repeated presses (`ee`/`2e`) correctly keep advancing word-by-word. Still a
  single-space approximation around multi-space runs or punctuation directly
  adjacent to a word -- see MISSING_VIM_FEATURES.md.
- `W`, `E`, `B` - True WORD-wise equivalents of `w`/`e`/`b`: whitespace is the
  only boundary (punctuation doesn't split a WORD the way it splits a word).
  Uses the same text-reading mechanism as `f`/`F`/`t`/`T` -- see "How DocsKeys
  reads the document" below.
- `f{char}` / `F{char}` - Move to the next/previous occurrence of `{char}` on
  the current line, landing on it (inclusive if used with an operator, e.g.
  `dfx`).
- `t{char}` / `T{char}` - Move till just before/after the next/previous
  occurrence of `{char}` on the current line (exclusive with an operator for
  `T`, inclusive for `t` -- see `:help t`/`:help T`).
- `;` / `,` - Repeat the last `f`/`F`/`t`/`T`, in the same/opposite direction.
  A count (`{n}f{char}`) finds the n'th occurrence. `f`/`F`/`t`/`T` are the
  first DocsKeys motions that actually read document text -- see "How f/F/t/T
  read the document" below for how, and MISSING_VIM_FEATURES.md for the
  caveats (scoped to the current wrapped line, not the full paragraph;
  `;`/`,` only work as plain motions so far, not after an operator or in
  visual mode).

### How DocsKeys reads the document

The section above explains why DocsKeys can't read arbitrary document text.
`f`/`F`/`t`/`T` and `w`/`e`/`b`/`W`/`E`/`B` get around a narrower version of
that problem using a mechanism DocsKeys already had: the same clipboard
permission and save/restore pattern used for named registers. To answer
"what's on this line?", DocsKeys briefly selects from the cursor to the start
(or the end) of the current line with Home/End, clicks Google Docs' own Copy
menu item, reads the result back from the OS clipboard, and then collapses
the selection back to exactly where the cursor started -- all before the
user's own clipboard contents (saved beforehand) are restored. This is a
live, on-demand read every time, not a cached copy of the document, so it
stays correct even while collaborators are editing elsewhere in the doc; the
only risk window is the read itself, which only touches one side of the
cursor (whichever the motion needs) and takes on the order of a hundred
milliseconds or so. Reads write a unique marker to the clipboard first, so
"nothing was copied" (empty selection, e.g. at the end of a line) is
distinguishable from "copied the same text", and any key you press while a
read is in flight is queued and replayed in order afterwards. Visual mode
never reads while a selection is live: `v` takes one snapshot of the line
before it creates the selection, and everything after that is arithmetic. See MISSING_VIM_FEATURES.md for the latency and scoping
caveats.

### Numbered Prefixed Motions

- `{n}h` - Move cursor left n times
- `{n}j` - Move cursor down n times
- `{n}k` - Move cursor up n times
- `{n}l` - Move cursor right n times
- `{n}w` / `{n}W` - Move to start of n words
- `{n}b` / `{n}B` - Move to start of n previous word
- `{n}e` / `{n}E` - Move to end of n word

A count also works immediately before an operator, e.g. `3dw` deletes 3
words (equivalent to `d3w`), and `2cw`, `5yy`, etc. behave the same way.

#### Line Navigation
- `0` - Go to column 0 of the line (fast, native, no document read needed)
- `^` or `_` - Go to the line's first non-blank character (reads the current
  line the same way `f`/`t` do -- see "How DocsKeys reads the document")
- `$` - Go to end of line
- `I` - Go to start of line and enter insert mode
- `A` - Go to end of line and enter insert mode

#### Document Navigation
- `g` - Go to document start
- `G` - Go to document end
- `{` - Go to start of paragraph
- `}` - Go to end of paragraph
- `/` - Opens the Find dialog

### Editing Commands

#### Mode Switching
- `i` - Enter insert mode
- `a` - Enter insert mode (after cursor)
- `v` - Enter visual mode
- `V` - Enter visual line mode
- `Esc` - Return to normal mode
- `Ctrl` + `o` - Temporary normal mode from insert mode (run one normal-mode
  command, then automatically return to insert mode)

#### Text Manipulation
- `d` + motion - Delete. Supports `dw`/`dW`, `de`/`dE`, `db`/`dB`, `dh`, `dl`,
  `dj`, `dk`, `diw`, `dp`, `dip`, `d{`, `d}`, `dd`, `d_`, `d0`, `d^`, `d$`,
  `dg`, `dG`, `df{char}`, `dF{char}`, `dt{char}`, `dT{char}`.
  - `dj`/`dk` are **linewise**, matching real Vim exactly: `dj` deletes the
    current line and the line below (2 lines total), `dk` deletes the
    current line and the line above (2 lines total), and a count extends
    this the same way `dd`'s count does (e.g. `d2j` deletes 3 lines).
  - `dh`/`dl` are charwise: `dl` deletes the character(s) at/after the
    cursor (same as `x`), `dh` deletes the character(s) before the cursor.
- `c` + motion - Change (same motion set as `d` above)
- `y` + motion - Yank/copy (same motion set as `d` above)
- `D` - Delete to end of line (equivalent to `d$`). A count spans lines like
  Vim's does: `3D` deletes to end of line plus the next 2 full lines.
- `C` - Change to end of line (equivalent to `c$`), with the same counted
  behavior as `D`.
- `Y` - Yank the whole line (equivalent to `yy`), with the same counted
  behavior as `yy`/`dd` (`3Y` yanks 3 full lines).
- `r` + character - Replace the character under the cursor with the next
  character you type, without leaving normal mode
- `p` - Paste
- `u` - Undo
- `Ctrl` + `r` - Redo
- `x` - Delete character in front of cursor
- `s` - Delete character in front of cursor and enter insert mode
- `J` - Join the current line with the next line, separated by a single space
- `.` - Repeat the last change. Works for operator+motion deletes/changes,
  `D`/`C`/`x`/`s`/`J`/`p`. Change-operators (`cw`, `C`, `s`, ...) replay the
  deletion and drop you back into insert mode, but can't retype what you
  typed last time -- see MISSING_VIM_FEATURES.md for why. `r{char}` and
  yank commands are intentionally not dot-repeatable.
- `"{register}` before `y`/`d`/`c`/`p` - use a named register (`a`-`z`,
  `0`-`9`) instead of the default. Registers now behave much closer to real
  Vim:
  - Plain `y` with no register goes straight to the OS clipboard, exactly as
    before -- use it to copy something out of Google Docs.
  - Plain `d`/`c` with no register no longer touch the OS clipboard at all --
    they land in a dedicated cut register (`"-`) instead, so repeated
    deleting doesn't overwrite whatever you meant to paste elsewhere. `"-p`
    pastes your last cut back.
  - `"{reg}y`/`"{reg}d`/`"{reg}c` capture into that register only; the real
    OS clipboard is saved and restored around the command, so it's left
    exactly as it was.
  - An uppercase register (`"Ayy`) appends to that register instead of
    overwriting it.
  - `"_` is the black-hole register: `"_dd` deletes without storing the text
    anywhere.
  - This is still one of the newer, less-tested parts of DocsKeys -- see
    MISSING_VIM_FEATURES.md for the caveats.

Note: in *operator-pending* position (`diw`, `daw`, `dip`, `dap`, ...) DocsKeys'
`iw`/`aw` (and `ip`/`ap`) still behave identically and `diw` has a known bug
(see MISSING_VIM_FEATURES.md, "Known bugs found during review"). In *visual*
mode `iw`/`aw` are now distinct and follow Vim's rules.

#### Line Operations
- `o` - Add new line below and enter insert mode
- `O` - Add new line above and enter insert mode

### Visual Mode Commands
`v` starts charwise visual mode, `V` linewise. The selection is inclusive of the
character under the cursor and the anchor character stays selected when the
cursor passes it (`vh` selects two characters), as in Vim.

**How `v` works.** When you press `v`, DocsKeys reads the current line once
(before any selection exists -- see "How DocsKeys reads the document") and
then computes every motion on that snapshot, so inside that line these are
exact and instant, with no further clipboard use: `h` `l` `w` `W` `e` `E` `b`
`B` `f` `F` `t` `T` `;` `,` `0` `^` `_` `$` `o` `O` `iw` `aw` `iW` `aW`.
Counts work (`3w`, `2l`, `3fx`).

Once the selection leaves that line (`j`, `k`, `{`, `}`, `g`, `G`, or a word
motion running off the end of the line), Docs' native selection motions take
over: `h`/`l`/`j`/`k`/`0`/`$` and word jumps still work, but `f`/`F`/`t`/`T`,
`^` and `iw`/`aw` decline until you press `v` again. Visual LINE mode (`V`)
is always in this native mode.

- `iw`/`aw`, `iW`/`aW` - select the word/WORD (with a one-character selection);
  repeating extends the selection. `aw` includes trailing white space, or
  leading if there is none. `ip`/`ap` - select the paragraph (switches to
  linewise, as in Vim)
- `o` / `O` - go to the other end of the selection
- `"{register}` - use a named register for the following `d`/`c`/`y`/`p`
- `d` / `x` - Delete selected text
- `c` / `s` - Change selected text
- `y` - Yank selected text (the cursor goes to the start of the selection)
- `p` - Paste over selected text
- `Esc` - leave visual mode, cursor on the character the cursor was on. While
  a pending `i`/`a`, `f`/`t`, `"` or count is waiting, `Esc` cancels just that
  and stays in visual mode.

Visual-mode changes are not dot-repeatable (see MISSING_VIM_FEATURES.md).
`$` stops at the last character rather than also selecting the line break.

### Mode indicators

A floating badge in the bottom-right corner always shows the current mode
(NORMAL, INSERT, VISUAL, etc.) -- this is the indicator to rely on. An
earlier version also tried to restyle Google Docs' own text cursor (a
resized block for normal/visual mode, a thin bar for insert mode) as a
bonus on top of the badge, but sizing it to reliably match the actual
character under the cursor isn't something DocsKeys can do without reading
line content (see above), so that attempt has been removed -- Google Docs'
native cursor is left alone, and the floating badge is the only mode
indicator.

## Installation

[Chrome Web Store](https://chromewebstore.google.com/detail/docskeys/mmmomengbindngnkjblabjebdfmaiccj) |
[Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/docskeys/)

### Install from source

#### Chrome
- Clone or download this repository
- Navigate to `chrome://extensions` in Chrome
- Toggle into Developer Mode
- Click on "Load Unpacked Extension..."
- Select the docskeys folder

#### Firefox
- Clone or download the [firefox branch](https://github.com/tirthd16/dockeys/tree/firefox) of this repository
- Navigate to `about:debugging` in Firefox
- Click on "This Firefox"
- Click on "Load Temporary Add-on..."
- Select the manifest.json file from the docskeys folder

## Usage

1. Open a Google Doc
2. Extension will automatically activate
3. Start using Vim commands in normal mode
4. Press `i` or `a` to enter insert mode for regular typing
5. Press `Esc` to return to normal mode

## Permissions

As of this version, the manifest requests `clipboardRead` and
`clipboardWrite` in addition to running on `docs.google.com`, to support
named registers (see above). If you'd rather not grant that, you can still
use everything else -- registers are the only feature that depends on it,
and it fails silently (falling back to the default clipboard-backed
register) if clipboard access doesn't work in your browser.

The manifest also requests `storage`, used only to save named registers
(`"ayy`, `"ap`, etc.) to `chrome.storage.local` so they survive closing or
reloading the tab, instead of being lost with the rest of the content
script's in-memory state. Nothing else is stored or sent anywhere.

## Known Limitations

- Most advanced Vim features like marks, macros, search motions (`f`/`t`/
  `/`), true `iw`/`aw` whitespace handling, true word/WORD distinction, and
  Ex commands (`:s`, `:g`) are not supported, because DocsKeys has no way to
  read the document's text -- it only drives cursor movement and the
  clipboard. See [MISSING_VIM_FEATURES.md](MISSING_VIM_FEATURES.md) for the
  full list, sorted by how practical each would be to add.
- Dot-repeat (`.`) can't replay text you typed during an insert-mode change
  (see above), and named registers depend on the async Clipboard API and
  haven't been tested against a live Google Docs page -- see
  MISSING_VIM_FEATURES.md for both.
- Custom key mappings are not supported
- See the "Known bugs found during review" list in MISSING_VIM_FEATURES.md for the
  open items scheduled for the next iteration
- PR's are welcome to add these features

## License

See [MIT-LICENSE.txt](MIT-LICENSE.txt) for details.