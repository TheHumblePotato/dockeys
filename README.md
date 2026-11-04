# DocsKeys

Vim-style editing for Google Docs. This extension drives Docs' keyboard and Edit menu commands; it does not keep a document buffer or send document content to a server.

## Install and configure

1. Open `chrome://extensions` and enable Developer mode.
2. Choose **Load unpacked** and select the folder containing `manifest.json`.
3. Reload any open Google Docs tabs.
4. Click the DocsKeys toolbar icon for settings and the shortcut reference.

Disable Vimium/Surfingkeys on Google Docs to avoid competing shortcuts.

Settings are saved locally and apply to open documents automatically:

| Setting | Default | Behavior |
| --- | --- | --- |
| Programmer Dvorak (DVP) | On | Translate command keys to their QWERTY positions. Turn off for a QWERTY keyboard. Inserted text and find/replace arguments always use the OS layout. |
| Box cursor | On | Draw a box in normal/visual modes and an underline while awaiting a command argument. Insert mode uses Docs' caret. |
| Mode badge | On | Show the current mode in the lower-right corner. |
| Start in insert mode | Off | Choose the initial mode for newly loaded Docs tabs. Changing this does not interrupt an active command. |
| Word motions | Fast | Fast normal-mode `w`/`b` use native Docs word jumps without clipboard reads. Precise mode uses Vim punctuation boundaries within the current display line. |

DVP remains enabled by default for compatibility with this fork. Settings no longer require editing source constants. `e` and `W/E/B`, operators, find motions, and text objects retain their text-based behavior regardless of the fast-word setting.

## Commands

| Action | Keys |
| --- | --- |
| Move | `h j k l`, arrow keys, counts such as `3j` |
| Words / WORDs | `w b e` / `W B E` |
| Line navigation | `0`, `^`/`_`, `$`, Home, End |
| Document / paragraph navigation | `g` or `gg`, `G`, `{`, `}` |
| Find on current display line | `f{char}`, `F{char}`, `t{char}`, `T{char}`, `;`, `,` |
| Insert | `i`, `a`, `I`, `A`, `o`, `O` |
| Return to normal | Escape or `Ctrl+[` |
| Temporary normal from insert | `Ctrl+o`, followed by one complete command |
| Visual / visual line | `v`, `V`; repeat the same key to leave |
| Delete / change / yank | `d{motion}`, `c{motion}`, `y{motion}`, doubled operators such as `dd` |
| Word text objects | `iw`, `aw`, `iW`, `aW`; e.g. `diw`, `d2aw` |
| Paragraph text objects | `ip`, `ap` (Docs paragraph approximation) |
| Delete / change to line end | `D`, `C` |
| Yank to line end | `Y` (`y$`, following Neovim's default); use `yy` for a whole line |
| Delete / substitute characters | `x`, `s`, with counts |
| Replace / toggle case | `r{char}`, `~`, counted `~` |
| Undo / redo | `u`, `Ctrl+r` |
| Paste / join / repeat change | `p`, `J`, `.` |
| Find dialog | `/` |
| Half / full page | `Ctrl+d/u`, `Ctrl+f/b` |
| Scroll view one line | `Ctrl+e/y` |

Counts before and after an operator multiply: `2d3w` targets six words. Exact semantics depend on the motion's scope; see the limitations below.

### Visual selections

Charwise Visual mode includes the anchor and cursor characters, including when the cursor crosses the anchor. On entering `v`, the extension reads the current display line once. Within that snapshot, character, word, find, and text-object motions are synchronous. `o`/`O` swaps the endpoints within the snapshot. `d/x`, `c/s`, `y`, and `p` act on the selection.

When a motion leaves the starting line, native Docs selection motions take over. Native word motions start on the cursor character rather than after its highlight. Crossing the anchor may require one clipboard read to rebuild the selection. `f/F/t/T`, `^`, and word text objects require the original line snapshot; leave and re-enter Visual mode to establish a new one.

`V` maintains whole **display lines**, including line breaks where available. Use `j/k`, counts, `g/G`, or paragraph motions. Horizontal and word motions are ignored in linewise mode. Page shortcuts preserve a linewise selection. `v` switches a linewise selection to charwise mode. A mouse selection becomes charwise because a mouse range need not cover whole lines.

Escape cancels a pending Visual argument/count first; another Escape leaves Visual mode.

### Registers and clipboard

- Plain `y` copies to the system clipboard. Plain `p` pastes it.
- Plain `d/c` save into the cut register `"-`, preserving the system clipboard. Use `"-p` to paste the cut.
- Prefix a command with `"a`–`"z` or `"0`–`"9` for a named register. Uppercase names append: `"Ayy`.
- `"+` explicitly uses the system clipboard. `"*` aliases it; there is no separate X11 primary selection.
- `"_` discards text without capturing a register.

Named registers persist in local extension storage. Captures, reads, and restores share an input guard so rapid commands cannot race the clipboard. Distinct keys pressed during a read are replayed afterward; held repeats received while busy are dropped to prevent movement continuing after release.

## Performance and scrolling

The cursor overlay uses caret geometry and an estimated character width. It never selects text or reads the clipboard. Mouse-wheel scrolling and `Ctrl+e/y` can therefore move the cursor offscreen without an idle measurement pulling it back into view. The box hides offscreen and follows the caret back into view. Only the local caret is overlaid; collaborator carets retain Docs' appearance.

Fast `w/b` perform no document reads. Precise motions temporarily select text, copy it, read it through the clipboard, and restore the caret and clipboard. They are slower, particularly at empty line boundaries. Set `DEBUG_TIMING` in `content.js` to inspect their timings.

## Limits and compatibility

- Google Docs has no supported content-script API for its document buffer. Text reads cover a wrapped display line, not a full Neovim buffer line. Page boundaries, wrapping, tables, lists, and proportional fonts need live Docs testing.
- Native word boundaries can differ from Vim around punctuation. Cross-line word fallbacks are approximate, including in precise mode.
- Visual snapshots do not update for concurrent collaborator edits. Re-enter Visual mode after the underlying text changes.
- The box width is an estimate; it deliberately avoids background document reads.
- `.` repeats supported editing actions, but cannot replay inserted text. Visual changes and `r{char}` are not dot-repeatable.
- Registers preserve plain text only; clipboard formatting and images are outside this implementation.
- Some behavior remains different from Neovim: single `g` also goes to document start, linewise mode ignores word/horizontal motions, `$` in Visual mode stops before the line break, and paragraph/word-operator edge cases are approximate.

See [MISSING_VIM_FEATURES.md](MISSING_VIM_FEATURES.md) for remaining work. Motion/selection rules follow the [Neovim motion reference](https://neovim.io/doc/user/motion/) and [Visual reference](https://neovim.io/doc/user/visual/) where this architecture supports them. `Y` follows [Neovim's default mapping](https://neovim.io/doc/user/quickref/).

## Permissions

The extension runs only on Google Docs document URLs. `clipboardRead`/`clipboardWrite` support precise text motions, Visual snapshots, text objects, and registers. Clipboard-based motions decline when the clipboard cannot be saved safely. Basic editing and fast `w/b` still work without a text read. `storage` holds preferences and named registers locally. No analytics or document-content network requests are added.

## Development and verification

No dependencies are required. With Node.js 18 or later:

~~~sh
npm test
# or
node test.js
~~~

The runner checks JavaScript syntax, normal/operator motions, registers, graphemes, Visual selections, scrolling/zoom, preference persistence, and the injected keyboard bridge. It also runs 40 seeded random Visual scenarios. `harness.js` loads the actual content script in a simulated Docs editor; it is not a live browser integration test. The older oracle-focused suites explicitly use precise word mode, while the new regressions also exercise shipped defaults.

Before a release, check an actual Docs document with multiple collaborators, page wrapping, zoom changes, native mouse selections, an empty final paragraph, and clipboard permissions denied. This repository run verifies the simulator and bridge, not those live Docs behaviors.

Inspired by [SheetKeys](https://github.com/philc/sheetkeys). MIT licensed.
