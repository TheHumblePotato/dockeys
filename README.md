# DocsKeys

Vim-style editing for Google Docs. This extension drives Docs' keyboard and Edit menu commands; it uses short-lived plain-text snapshots for motions and does not send document content to a server.

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
| Word motions | Fast | Both modes use Vim word boundaries across paragraphs. Fast caches reads for up to 2.5 seconds; Precise allows up to 0.5 seconds. Edits and mouse/native navigation invalidate the cache. |

DVP remains enabled by default for compatibility with this fork. Settings no longer require editing source constants. Both word modes share one motion engine. Fast no longer delegates to native Docs word jumps. Destructive word/search operators refresh their snapshot before selecting text.

## Commands

| Action | Keys |
| --- | --- |
| Move | `h j k l`, arrow keys, counts such as `3j` |
| Words / WORDs | `w b e` / `W B E` |
| Line navigation | `0`, `^`/`_`, `$`, Home, End |
| Document / paragraph navigation | `gg`, `{n}gg`, `G`, `{n}G`, `{`, `}` |
| Backward word ends / last nonblank | `ge`, `gE`, `g_` (also operator targets) |
| Native display-line movement | `gj`, `gk` |
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
| Literal search | `/{text}` + Enter, `?{text}` + Enter |
| Repeat / word search | `n`, `N`, `*`, `#`; counts work |
| Half / full page | `Ctrl+d/u`, `Ctrl+f/b` |
| Scroll view one line | `Ctrl+e/y` |

Counts before and after an operator multiply: `2d3w` targets six words. Exact semantics depend on the motion's scope; see the limitations below.

### Visual selections

Charwise Visual mode includes both the anchor and cursor character, even when crossing the anchor. Vim's `w` lands on the next word's first character and Visual mode includes that character; use `e` to land at a word end. The box is drawn on the logical cursor character, rather than the outer edge of the highlight.

Entering `v` reads a document snapshot. Character, word/WORD, and vertical motions remain in that model across paragraphs; they do not switch to approximate native word jumps. Counts, `o`/`O`, line-local `f/F/t/T`, and word text objects use the same model. `$` includes the paragraph break where one exists. EOF can be a virtual Visual cursor position without selecting a neighboring character.

`V` maintains whole **display lines**, including line breaks where available. Use `j/k`, counts, `gg/G`, or paragraph motions. Horizontal and word motions are ignored in linewise mode. Page shortcuts preserve whole-line selections. `v` switches a linewise selection to charwise mode. Native mouse selections and `gj/gk` may require rebuilding a text snapshot before subsequent word motions.

Escape cancels a pending Visual argument/count first; another Escape leaves Visual mode. `g` is now a prefix: use `gg`, not a single `g`, to go to the first line. Like Neovim's default `nostartofline`, `gg/G` preserve the column where possible.

### Custom search

Type a literal query after `/` (forward) or `?` (backward), then Enter. Search stays in DocsKeys and keeps focus in the editor. Escape cancels, Backspace edits the query, Ctrl+U clears it, Ctrl+W removes a word, and Ctrl+V pastes query text. An empty query repeats the previous pattern.

- `d/hi` + Enter deletes up to the next `hi`, excluding the match. `c/hi`, `y/hi`, backward searches, `dn`, and counted searches also work.
- `n/N` repeat in the original/opposite direction. Searches wrap at document boundaries.
- `*/#` search the word under the cursor, skipping the current occurrence. Keyword searches use whole-word boundaries.
- Queries are case-sensitive by default; `\c` and `\C` control case, `\n` matches a paragraph break, and an optional `\V` prefix is accepted.
- This is **literal search**, not a full implementation of Vim regular expressions. Characters such as `.*[]` are literal. Built-in Google Docs Find remains available from Docs' menu.

### Registers and clipboard

- Plain `y` copies to the system clipboard. Plain `p` pastes it.
- Plain `d/c` save into the cut register `"-`, preserving the system clipboard. Use `"-p` to paste the cut.
- Prefix a command with `"a`–`"z` or `"0`–`"9` for a named register. Uppercase names append: `"Ayy`.
- `"+` explicitly uses the system clipboard. `"*` aliases it; there is no separate X11 primary selection.
- `"_` discards text without capturing a register.

Named registers persist in local extension storage. Captures, reads, and restores share an input guard so rapid commands cannot race the clipboard. Distinct keys pressed during a read are replayed afterward; held repeats received while busy are dropped to prevent movement continuing after release.

## Performance and scrolling

The cursor overlay uses caret geometry and an estimated character width. It never selects text or reads the clipboard. Mouse-wheel scrolling and `Ctrl+e/y` can therefore move the cursor offscreen without an idle measurement pulling it back into view. The box hides offscreen and follows the caret back into view. Only the local caret is overlaid; collaborator carets retain Docs' appearance.

Both modes read text on demand and reuse it during motion bursts. The first forward word motion copies only the suffix, avoiding an empty-prefix round trip. Backward motions refresh a complete snapshot only when needed. Visual motions do not read again while their model remains valid. Long selections avoid per-character layout reads and unnecessary selection retraction.

There are no idle text/selection reads. Explicit reads preserve the viewport, including wheel/touch input during a read and late layout frames. A wheel gesture also takes precedence over an older motion completing asynchronously. Caches are invalidated on edits, clicks, native navigation, and observable document/collaborator changes. Canvas-only remote changes may only become visible on expiry; neither mode promises a synchronized Docs buffer.

## Limits and compatibility

- Google Docs has no supported content-script buffer API. Snapshots assume plain-text graphemes correspond to arrow-key steps. Large documents, tables, lists, embedded objects, and page wrapping need live Docs testing.
- Normal/native `j/k`, `V`, and Home/End remain display-line based; modeled Visual vertical motions and `gg/G` use paragraph breaks. This differs from a fully integrated Vim buffer.
- Snapshot invalidation is best effort for collaborative canvas edits. Precise is fresher, while Fast reuses snapshots longer.
- Search is literal; full Vim regex, incremental highlighting, and search history are not implemented.
- The box width is estimated when direct boundary geometry is unavailable. Custom `iskeyword` and every Unicode word-class boundary are not implemented.
- `.` re-evaluates supported word/search changes, but cannot replay inserted text, Visual changes, or `r{char}`.
- Registers store plain text; full linewise metadata, rich clipboard preservation, and numbered-register rotation remain missing.
- Other unverified or approximate rules, including cross-paragraph text-object edge cases and several editing aliases, are listed in the feature backlog.

See [MISSING_VIM_FEATURES.md](MISSING_VIM_FEATURES.md) for remaining work. Motion/selection rules follow the [Neovim motion reference](https://neovim.io/doc/user/motion/) and [Visual reference](https://neovim.io/doc/user/visual/) where this architecture supports them. `Y` follows [Neovim's default mapping](https://neovim.io/doc/user/quickref/).

## Permissions

The extension runs only on Google Docs document URLs. `clipboardRead`/`clipboardWrite` support precise text motions, Visual snapshots, text objects, and registers. Clipboard-based motions decline when the clipboard cannot be saved safely. Basic native editing still works without a text read; word/search commands require readable clipboard text in both modes. `storage` holds preferences and named registers locally. No analytics or document-content network requests are added.

## Development and verification

No dependencies are required. With Node.js 18 or later:

~~~sh
npm test
# or
node test.js
~~~

The runner checks JavaScript syntax, motions/operators, registers, graphemes, Visual cursor geometry, scrolling races, cache reuse, custom search, settings, and the keyboard bridge. It also runs seeded selection fuzzing. If Neovim is installed, `vim_differential.js` compares the pure engine and actual extension command sequences to a clean headless editor; set `DOCSKEYS_NVIM` if its executable is not on PATH, or run `npm run test:vim`. Missing Neovim is reported as a skipped comparison.

`harness.js` loads the actual content scripts in a simulated Docs editor. Differential checks cover the tested rules, not all Vim commands or the live Google Docs UI.

Before a release, check an actual Docs document with multiple collaborators, page wrapping, zoom changes, native mouse selections, an empty final paragraph, and clipboard permissions denied. This repository run verifies the simulator and bridge, not those live Docs behaviors.

Inspired by [SheetKeys](https://github.com/philc/sheetkeys). MIT licensed.
