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
bracket-matching, true `iw`/`aw` whitespace handling, and Ex commands like
`:s`) aren't implemented: they fundamentally require knowing what character
or word is at a given position, which this architecture can't answer. See
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
  This is a single-space approximation -- see MISSING_VIM_FEATURES.md.

### Numbered Prefixed Motions

- `{n}h` - Move cursor left n times
- `{n}j` - Move cursor down n times
- `{n}k` - Move cursor up n times
- `{n}l` - Move cursor right n times
- `{n}w` - Move to start of n words
- `{n}b` - Move to start of n previous word
- `{n}e` - Move to end of n word

A count also works immediately before an operator, e.g. `3dw` deletes 3
words (equivalent to `d3w`), and `2cw`, `5yy`, etc. behave the same way.

#### Line Navigation
- `0` or `^` or `_` - Go to start of line (DocsKeys does not currently
  distinguish `^`'s "first non-blank character" from `0`'s "column 0", since
  that requires reading line content -- see MISSING_VIM_FEATURES.md)
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
- `d` + motion - Delete (supports `dw`, `de`, `diw`, `dp`, `dip`, `dd`, `d_`,
  `d0`, `d^`, `d$`, `dg`, `dG`)
- `c` + motion - Change (supports `cw`, `ce`, `ciw`, `cp`, `cip`, `cc`, `c_`,
  `c0`, `c^`, `c$`, `cg`, `cG`)
- `y` + motion - Yank/copy (supports `yw`, `ye`, `yiw`, `yp`, `yip`, `yy`,
  `y_`, `y0`, `y^`, `y$`, `yg`, `yG`)
- `D` - Delete to end of line (equivalent to `d$`)
- `C` - Change to end of line (equivalent to `c$`)
- `Y` - Yank the whole line (equivalent to `yy`)
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
  `0`-`9`) instead of the default clipboard-backed register, e.g. `"ayy`
  yanks the line into register `a`, `"ap` pastes it back. Plain `y`/`d`/`c`/
  `p` with no `"reg` prefix keep using the OS clipboard directly, exactly as
  before. This is the newest and least-tested feature here -- see
  MISSING_VIM_FEATURES.md for the caveats.

Note: DocsKeys' `iw`/`aw` (and `ip`/`ap`) text objects currently behave
identically -- both act like the "inner" variant. Real Vim's "a" (around)
variants additionally grab surrounding whitespace, which DocsKeys can't
detect without reading line content. See MISSING_VIM_FEATURES.md.

#### Line Operations
- `o` - Add new line below and enter insert mode
- `O` - Add new line above and enter insert mode

### Visual Mode Commands
When in visual mode (`v` or `V`):
- All movement keys (`h`, `j`, `k`, `l`, `w`, `e`, `b`, `{`, `}`, `g`, `G`,
  `0`/`^`/`_`, `$`) extend the selection
- `iw`/`aw`, `ip`/`ap` - extend the selection to the current word/paragraph
- `"{register}` - use a named register for the following `d`/`c`/`y`/`p`
- `d` - Delete selected text
- `c` - Change selected text
- `y` - Yank selected text
- `p` - Paste over selected text

Visual-mode changes are not dot-repeatable (see MISSING_VIM_FEATURES.md).

### Mode indicators

A floating badge in the bottom-right corner always shows the current mode
(NORMAL, INSERT, VISUAL, etc.) -- this is the reliable indicator. DocsKeys
also makes a best-effort attempt to restyle Google Docs' own text cursor into
a block shape for normal/visual/pending-input modes and a thin bar for
insert mode, via injected CSS. This part is unverified against a live Google
Docs page and may not visibly do anything depending on Docs' current
internals -- if it doesn't work for you, the floating badge is unaffected.

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

## Known Limitations

- Most advanced Vim features like marks, macros, search motions (`f`/`t`/
  `/`), true `iw`/`aw` whitespace handling, and Ex commands (`:s`, `:g`) are
  not supported, because DocsKeys has no way to read the document's text --
  it only drives cursor movement and the clipboard. See
  [MISSING_VIM_FEATURES.md](MISSING_VIM_FEATURES.md) for the full list,
  sorted by how practical each would be to add, plus a couple of known bugs
  that were found but not yet fixed.
- Dot-repeat (`.`) can't replay text you typed during an insert-mode change
  (see above), and named registers depend on the async Clipboard API and
  haven't been tested against a live Google Docs page -- see
  MISSING_VIM_FEATURES.md for both.
- Custom key mappings are not supported
- PR's are welcome to add these features

## License

See [MIT-LICENSE.txt](MIT-LICENSE.txt) for details.