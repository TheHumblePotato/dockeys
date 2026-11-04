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
| Box cursor color | Blue (`#1a73e8`) | Choose any color in the popup. The box remains translucent so text is readable; changes repaint a stationary cursor immediately. |
| Mode badge | On | Show the current mode in the lower-right corner. |
| Start in insert mode | Off | Choose the initial mode for newly loaded Docs tabs. Changing this does not interrupt an active command. |
| Word motions | Fast | Both modes use Vim word boundaries across paragraphs. Fast caches reads for up to 2.5 seconds; Precise allows up to 0.5 seconds. Edits and mouse/native navigation invalidate the cache. |
| Document reads | Auto | Prefer annotated rendered text; fall back to masked clipboard reads. Rendered only disables document probes and declines commands needing unavailable text. Clipboard forces the compatibility reader. |
| Visual j/k | Displayed rows | Move one displayed row using native selection events, including wrapped paragraphs. Choose Paragraphs for Vim-style logical lines; that option may need a larger text snapshot. |

DVP remains enabled by default for compatibility with this fork. Settings no longer require editing source constants. Both word modes share one motion engine. Fast no longer delegates to native Docs word jumps. Destructive word/search operators refresh their snapshot before selecting text.

After updating to 1.10, reload the extension and fully refresh Docs tabs. The rendered reader requests annotations during document startup. That request is undocumented and may be unavailable in some Docs versions; Auto retains a clipboard fallback. Rendered only can cross adjacent annotated paragraphs when their boundaries are explicit, but still declines unknown/offscreen boundaries, global search, and operators requiring a full snapshot. Native linewise cursor movement remains available without a text read. Explicit yank/paste/register commands can still use the clipboard in that setting.

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
| Place cursor in viewport | `zz` (center), `zt` (top), `zb` (bottom), in normal mode |

Counts before and after an operator multiply: `2d3w` targets six words. Exact semantics depend on the motion's scope; see the limitations below.

### Visual selections

Charwise Visual mode includes both the anchor and cursor character, even when crossing the anchor. Vim's `w` lands on the next word's first character and Visual mode includes that character; use `e` to land at a word end. The box is drawn on the logical cursor character, rather than the outer edge of the highlight.

Entering `v` uses rendered text where the caret can be mapped confidently, otherwise a masked bounded snapshot. Adjacent runs are joined verbatim only inside explicit paragraph groups; neighboring paragraph siblings supply real line breaks. Word/WORD motions use the shared Vim engine across those boundaries. Commands needing more context promote a local model to a full snapshot in Auto/Clipboard mode. The entire collapse/read/reconstruction stays inside one viewport transaction, including delayed layout frames. A failed read restores the original selection.

By default, Visual `j/k` moves one **displayed row**, matching normal movement in Docs. It preserves the existing anchor and uses native Up/Down instead of walking a whole paragraph with character events. Repeated movement across ordinary rows needs no clipboard read; crossing the anchor may require one repair read. Choose **Visual j/k → Paragraphs** for Vim's logical-line behavior instead. Returning to a modeled word/text-object motion after native movement can require a masked snapshot rebuild. Preferred columns and short/empty rows without annotations still need broader live testing.

Modeled counts, `o`/`O`, line-local `f/F/t/T`, and word text objects use the same snapshot. `$` includes the paragraph break where one exists. EOF can be a virtual Visual cursor position without selecting a neighboring character.

Selection and tile redraws retain the Visual model instead of triggering another read. While rebuilding a selection, DocsKeys temporarily keeps the previous highlight visible and masks the intermediate collapse/extend states. Masks have a timeout fallback so background-tab frame throttling cannot leave selections hidden.

`V` keeps an ordinary native caret at its current column and draws a separate whole-line highlight. `h/j/k/l`, word motions, `0/^/$`, `f/F/t/T`, `gg/G`, searches, and counts move the caret; crossing a paragraph boundary expands the highlighted range. `o/O` swap the cursor and anchor. `v` converts the range to charwise Visual mode; converting back preserves its span. Escape leaves the caret where it is.

Linewise native `j/k` follow Docs' displayed rows; operators use logical paragraph boundaries. Annotated paragraph geometry supplies whole-paragraph highlighting, including wrapped rows; without it the highlight band approximates displayed rows. Entering `V` normally reads one snapshot to remember the anchor. Movement does not rebuild a native selection on every key; supported editing/clipboard commands realize the range when needed. If text access is unavailable, native movement/highlighting still works, while commands needing an exact range decline. Native formatting menus and accessibility selection ranges are not synchronized with the custom highlight.

A plain mouse click that clears a Visual range returns to normal mode without Copy. Dragging, double-clicking, or shift-clicking enters charwise Visual mode. Mouse replacement invalidates pending motion state and cancels a read without moving the newly clicked caret.

Escape cancels a pending Visual argument/count first; another Escape leaves Visual mode. `g` is now a prefix: use `gg`, not a single `g`, to go to the first line. Like Neovim's default `nostartofline`, `gg/G` preserve the column where possible.

### Custom search

Type a literal query after `/` (forward) or `?` (backward), then Enter. Search stays in DocsKeys and keeps focus in the editor. Escape cancels, Backspace edits the query, Ctrl+U clears it, Ctrl+W removes a word, and Ctrl+V pastes query text. An empty query repeats the previous pattern.

Up/Down browse the last 50 submitted queries in this Docs tab. Down past the newest query restores your draft. Browsing history does not read or move the document. A missing pattern leaves the caret/selection unchanged. A failed Copy is reported as unavailable text rather than treating a stale caret rectangle as proof of an empty document.

Search keeps viewport protection through its destination move. It restores the intended viewport before measuring the target, then scrolls only enough to show that target. Missing patterns retain the original view. Annotated text can verify a unique nearby match and correct a one/two-character native landing discrepancy, including backward searches.

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

Clipboard requests have finite deadlines. Escape/Ctrl+[ cancel an active read ahead of queued keys, clear stale commands/masks, and return to normal mode. Cleanup and clipboard restoration have bounded waits; a stalled promise cannot permanently lock the input queue. Queue overflow and the command watchdog cancel the stalled command instead of leaving input trapped.

## Performance and scrolling

The cursor overlay uses caret geometry and annotated glyph widths when available, including proportional fonts and zoom. Otherwise it measures the character known from an existing motion/search snapshot, with an estimated width when no character is known. Native vertical movement may only provide an approximate glyph hint without annotations. Cursor cosmetics never select text or read the clipboard. Mouse-wheel scrolling and `Ctrl+e/y` can move the cursor offscreen without an idle measurement pulling it back into view. The box hides offscreen and follows the caret back into view. Only the local caret is overlaid; collaborator carets retain Docs' appearance.

Both modes read text on demand and reuse it during motion bursts. Local word/find motions use annotated SVG text without Copy when available. Rendered runs with unexplained gaps, generated list markers, or ambiguous wrapped joins decline the combined context instead of inventing native character steps. Normal word motions wait for the painted caret and rebind to its actual rendered context, preventing a stale cross-line offset from making the next `w` move one character. Fallback word reads start with a two-display-line window on each needed side, expanding only at unknown boundaries. Large counts, global searches, and operators may still require a full snapshot. Visual motions do not read again while their model remains valid.

There are no idle clipboard/selection probes. Explicit probes hide Docs' temporary blue selection layer, suppress editor focus/programmatic scroll calls in the page world, and preserve the viewport throughout the read and late layout frames. The guard covers editor ancestors/window scrolling and scroll/focus calls inside page timers/animation callbacks scheduled during a read, including callbacks that outlive its immediate lease. A wheel gesture takes precedence over an older motion completing asynchronously. Caches are invalidated on edits, clicks, native navigation, and observable document/collaborator changes. Canvas-only remote changes may only become visible on expiry; neither mode promises a synchronized Docs buffer. Ordinary navigation can still scroll to reveal its destination, as in Vim.

See [READING_RESEARCH.md](READING_RESEARCH.md) for sources, alternatives, and the limits of annotated-canvas support.

## Limits and compatibility

- Google Docs has no supported content-script buffer API. Snapshots assume plain-text graphemes correspond to arrow-key steps. Large documents, tables, lists, embedded objects, and page wrapping need live Docs testing.
- Normal/native `j/k`, default Visual `j/k`, linewise cursor `j/k`, and Home/End are display-line based. The Visual Paragraphs option, linewise operator ranges, and `gg/G` use paragraph breaks. Wrapped-line behavior still differs from a fully integrated Vim buffer.
- Snapshot invalidation is best effort for collaborative canvas edits. Precise is fresher, while Fast reuses snapshots longer.
- Search is literal; full Vim regex, incremental highlighting, persistent history, and the search register are not implemented.
- The box width is estimated when direct boundary geometry is unavailable. Custom `iskeyword` and every Unicode word-class boundary are not implemented.
- `.` re-evaluates supported word/search changes, but cannot replay inserted text, Visual changes, or `r{char}`.
- Registers store plain text; full linewise metadata, rich clipboard preservation, and numbered-register rotation remain missing.
- Other unverified or approximate rules, including cross-paragraph text-object edge cases and several editing aliases, are listed in the feature backlog.

See [MISSING_VIM_FEATURES.md](MISSING_VIM_FEATURES.md) for remaining work. Motion/selection rules follow the [Neovim motion reference](https://neovim.io/doc/user/motion/) and [Visual reference](https://neovim.io/doc/user/visual/) where this architecture supports them. `Y` follows [Neovim's default mapping](https://neovim.io/doc/user/quickref/).

## Permissions

The extension runs only on Google Docs document URLs. `clipboardRead`/`clipboardWrite` support fallback text motions, full Visual snapshots, global search, text objects, and registers. Clipboard-based motions decline when the clipboard cannot be saved safely. Basic native editing and confidently mapped local rendered-text commands do not need a clipboard probe. `storage` holds preferences and named registers locally. No new permissions, OAuth, analytics, or document-content network requests are added.

## Development and verification

No dependencies are required. With Node.js 18 or later:

~~~sh
npm test
# or
node test.js
~~~

The runner checks JavaScript syntax, motions/operators, registers, graphemes, Visual cursor geometry, scrolling races, wrapped Visual rows and key volume, delayed caret/failed Copy recovery, cache reuse, custom search/history, settings/color, and the keyboard bridge. It also runs seeded selection fuzzing. If Neovim is installed, `vim_differential.js` compares the pure engine and actual extension command sequences to a clean headless editor; set `DOCSKEYS_NVIM` if its executable is not on PATH, or run `npm run test:vim`. Missing Neovim is reported as a skipped comparison.

`harness.js` loads the actual content scripts in a simulated Docs editor. Differential checks cover the tested rules, not all Vim commands or the live Google Docs UI.

Run `npm run test:browser` separately for a disposable local Chromium fixture (Chrome/Edge, or set `DOCSKEYS_BROWSER`). It verifies real DOM/CSS/canvas glyph sizing, generated-bullet cross-line word motions, independent linewise highlighting/native caret movement, masked Copy, late callback scroll suppression, iframe focus protection, stable Visual redraws, and Escape recovery from a clipboard promise that never resolves. It uses a fresh browser profile and does not access an authenticated document.

Before a release, check an actual Docs document with multiple collaborators, page wrapping, zoom changes, native mouse selections, an empty final paragraph, and clipboard permissions denied. The simulator and local browser fixture do not verify those live Docs behaviors or guarantee the private annotation/selection selectors remain available.

Inspired by [SheetKeys](https://github.com/philc/sheetkeys). MIT licensed.
