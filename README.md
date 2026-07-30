# DocsKey# DocsKeys

A browser extension that brings Vim-style keyboard shortcuts to Google Docs, allowing you to edit documents with familiar Vim motions and commands.

While this extension currently implements core Vim functionality including basic motions, text manipulation, and visual selections, there's room for expansion. Contributions are welcome to add more Vim features as per your need. See [MISSING_VIM_FEATURES.md](MISSING_VIM_FEATURES.md) for a breakdown of what's missing, why, and how hard each piece would be to add.

If you are using DocsKeys with Vimium, disable Vimium on Google Docs.

This project is heavily inspired by and uses much of code from [SheetKeys](https://github.com/philc/sheetkeys)

### Programmer Dvorak support

This fork translates keystrokes back to their QWERTY physical-key position
before interpreting them as Vim commands (the same trick Neovim's `langmap`
uses), so all the motions and commands below work from muscle memory even if
your OS keyboard layout is set to Programmer Dvorak. This is controlled by
the `DVORAK_MODE` constant at the top of `content.js` -- set it to `false` to
use raw QWERTY-style DocsKeys instead.

### Available Motions

#### Basic Movement
- `h` - Move cursor left
- `j` - Move cursor down
- `k` - Move cursor up
- `l` - Move cursor right
- `w` - Move to start of next word
- `b` - Move to start of previous word
- `e` - Move to end of current word

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
- `d` + motion - Delete (supports `dw`, `diw`, `dp`, `dip`, `dd`, `d_`, `d0`,
  `d^`, `d$`, `dg`, `dG`)
- `c` + motion - Change (supports `cw`, `ciw`, `cp`, `cip`, `cc`, `c_`, `c0`,
  `c^`, `c$`, `cg`, `cG`)
- `y` + motion - Yank/copy (supports `yw`, `yiw`, `yp`, `yip`, `yy`, `y_`,
  `y0`, `y^`, `y$`, `yg`, `yG`)
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

Note: DocsKeys' `iw`/`aw` (and `ip`/`ap`) text objects currently behave
identically -- both act like the "inner" variant. Real Vim's "a" (around)
variants additionally grab surrounding whitespace, which DocsKeys can't
detect without reading line content. See MISSING_VIM_FEATURES.md.

#### Line Operations
- `o` - Add new line below and enter insert mode
- `O` - Add new line above and enter insert mode

### Visual Mode Commands
When in visual mode (`v` or `V`):
- All movement keys (`h`, `j`, `k`, `l`, `w`, `b`, `e`, `{`, `}`, `g`, `G`,
  `0`/`^`/`_`, `$`) extend the selection
- `iw`/`aw`, `ip`/`ap` - extend the selection to the current word/paragraph
- `d` - Delete selected text
- `c` - Change selected text
- `y` - Yank selected text
- `p` - Paste over selected text

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

## Known Limitations

- Most advanced Vim features like marks, macros, registers, dot-repeat,
  search motions (`f`/`t`/`/`), and Ex commands (`:s`, `:g`) are not
  supported, because DocsKeys has no way to read the document's text -- it
  only drives cursor movement and the clipboard. See
  [MISSING_VIM_FEATURES.md](MISSING_VIM_FEATURES.md) for the full list,
  sorted by how practical each would be to add, plus a couple of known bugs
  that were found but not yet fixed.
- Custom key mappings are not supported
- PR's are welcome to add these features

## License

See [MIT-LICENSE.txt](MIT-LICENSE.txt) for details.