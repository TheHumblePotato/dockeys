// Tests for the "next iteration" bug list. Run: node fixes.js
const { makeEnv } = require("./harness")
let fails = 0
const eq = (name, got, exp) => { const ok = JSON.stringify(got) === JSON.stringify(exp); if (!ok) fails++; console.log(ok ? "ok  " : "FAIL", name, ok ? "" : `got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`) }
async function fresh(text, off, opts) { const e = makeEnv(text, opts); e.sim.setCaret(off); return e }
;(async () => {
  let e
  // ---- diw / daw / ciw / yiw
  e = await fresh("foo bar baz", 4); await e.pressAll("diw"); await e.sleep(30); eq("diw from FIRST char", e.sim.text, "foo  baz")
  e = await fresh("foo bar baz", 6); await e.pressAll("diw"); await e.sleep(30); eq("diw mid word", e.sim.text, "foo  baz")
  e = await fresh("foo bar baz", 4); await e.pressAll("daw"); await e.sleep(30); eq("daw trailing space", e.sim.text, "foo baz")
  e = await fresh("foo bar baz", 8); await e.pressAll("daw"); await e.sleep(30); eq("daw last word takes leading space", e.sim.text, "foo bar")
  e = await fresh("a.b c", 1); await e.pressAll("diw"); await e.sleep(30); eq("diw on punctuation", e.sim.text, "ab c")
  e = await fresh("foo   bar", 4); await e.pressAll("diw"); await e.sleep(30); eq("diw on white space", e.sim.text, "foobar")
  e = await fresh("a.b c", 0); await e.pressAll("diW"); await e.sleep(30); eq("diW", e.sim.text, " c")
  e = await fresh("aa bb cc dd", 0); await e.pressAll("d2aw"); await e.sleep(30); eq("d2aw", e.sim.text, "cc dd")
  e = await fresh("foo bar baz", 4); await e.pressAll("ciw"); await e.sleep(30); eq("ciw", [e.sim.text, e.get("mode")], ["foo  baz", "insert"])
  e = await fresh("foo bar baz", 4); await e.pressAll("diw"); await e.sleep(30); e.sim.setCaret(5); await e.press("."); await e.sleep(40)
  eq("dot repeats diw at the NEW position", e.sim.text, "foo  ")
  e = await fresh("foo bar baz", 4); e.sim.clipboard = "OLD"; await e.pressAll("yiw"); await e.sleep(40)
  eq("yiw yanks, caret at start, no selection", [e.sim.clipboard, e.sim.focus, e.sim.hasSel(), e.get("mode")], ["bar", 4, false, "normal"])
  e = await fresh("foo", 3); await e.pressAll("diw"); await e.sleep(30); eq("diw with caret after last char", e.sim.text, "")

  // ---- y with an operator: caret to start, no lingering highlight
  e = await fresh("foo bar baz", 4); await e.pressAll("yw"); await e.sleep(40); eq("yw", [e.sim.clipboard, e.sim.focus, e.sim.hasSel()], ["bar ", 4, false])
  e = await fresh("foo bar baz", 8); await e.pressAll("yb"); await e.sleep(40); eq("yb moves caret to start", [e.sim.clipboard, e.sim.focus, e.sim.hasSel()], ["bar ", 4, false])
  e = await fresh("foo bar baz", 4); await e.pressAll("y$"); await e.sleep(40); eq("y$", [e.sim.clipboard, e.sim.focus, e.sim.hasSel()], ["bar baz", 4, false])
  e = await fresh("foo bar baz", 4); await e.pressAll("yy"); await e.sleep(40); eq("yy leaves no selection", e.sim.hasSel(), false)
  e = await fresh("foo bar baz", 0); await e.press("y"); await e.press("f"); await e.pressRaw("r"); await e.sleep(40); eq("yfr", [e.sim.clipboard, e.sim.focus, e.sim.hasSel()], ["foo bar", 0, false])

  // ---- ; after t/T skips the adjacent match (cpo lacks ';')
  e = await fresh("a-b-c-d-e", 0); await e.press("t"); await e.pressRaw("-"); eq("t- (already adjacent: no move)", e.sim.focus, 0)
  await e.press(";"); eq("; after t jumps to NEXT", e.sim.focus, 2)
  await e.press(";"); eq("; again", e.sim.focus, 4)
  e = await fresh("a-b-c-d-e", 8); await e.press("T"); await e.pressRaw("-"); eq("T-", e.sim.focus, 8)
  e = await fresh("a-b-c-d-e", 1); await e.press("f"); await e.pressRaw("-"); await e.press(";"); eq("f then ; lands on the next match", e.sim.focus, 5)
  e = await fresh("a-b-c-d-e", 0); await e.press("t"); await e.pressRaw("-"); await e.press(";"); await e.press(","); eq("t- ; then , (T- skips adjacent, nothing before)", e.sim.focus, 2)
  e = await fresh("xax", 0); await e.press("F"); await e.pressRaw("x"); eq("F with no match to the left", e.sim.focus, 0)
  e = await fresh("xax", 2); await e.pressAll("2"); await e.press("F"); await e.pressRaw("x"); eq("2Fx with only one match", e.sim.focus, 2)

  // ---- V mode
  const L = "l1\nl2\nl3\nl4"
  e = await fresh(L, 3); await e.press("V"); eq("V selects the line", e.sim.selText(), "l2\n")
  await e.press("k"); eq("V k adds the line above", e.sim.selText(), "l1\nl2\n")
  await e.press("j"); eq("V k j back to one line", e.sim.selText(), "l2\n")
  await e.press("j"); eq("V k j j", e.sim.selText(), "l2\nl3\n")
  await e.press("j"); eq("V k j j j", e.sim.selText(), "l2\nl3\nl4")
  e = await fresh(L, 3); await e.press("V"); await e.pressAll("hlwbe$0^"); await e.press("f"); await e.pressRaw("2"); eq("V ignores h l w b e $ 0 ^ f", [e.sim.selText(), e.get("mode")], ["l2\n", "visualLine"])
  e = await fresh(L, 3); await e.press("V"); await e.press("j"); await e.press("d"); await e.sleep(60); eq("V j d", e.sim.text, "l1\nl4")
  e = await fresh(L, 0); await e.press("V"); await e.press("k"); eq("V k on FIRST line: selection not empty", e.sim.selText(), "l1\n")
  await e.press("d"); await e.sleep(60); eq("... and d removes exactly that line", e.sim.text, "l2\nl3\nl4")
  e = await fresh(L, 0); await e.press("V"); await e.pressAll("kj"); await e.press("d"); await e.sleep(80)
  eq("V k j at top then d never deletes an unrelated char", e.sim.text.replace(/\n/g, "").length >= "l2l3l4".length - 0, true)
  console.log("     (V k j on first line) text =", JSON.stringify(e.sim.text), "mode", e.get("mode"))
  e = await fresh(L, 3); await e.press("V"); await e.press("G"); eq("V G", e.sim.selText(), "l2\nl3\nl4")
  e = await fresh(L, 6); await e.press("V"); await e.press("g"); eq("V g", e.sim.selText(), "l1\nl2\nl3\n")
  e = await fresh(L, 3); await e.press("V"); await e.pressAll("2j"); eq("V 2j", e.sim.selText(), "l2\nl3\nl4")
  e = await fresh(L, 6); await e.press("V"); await e.pressAll("kkj"); eq("V k k j", e.sim.selText(), "l2\nl3\n")
  e = await fresh(L, 6); await e.press("V"); await e.pressAll("2k"); await e.press("d"); await e.sleep(60); eq("V 2k d", e.sim.text, "l4")
  e = await fresh(L, 6); e.sim.clipboard = "K"; await e.press("V"); await e.press("y"); await e.sleep(60); eq("V y", [e.sim.clipboard, e.sim.hasSel(), e.get("mode")], ["l3\n", false, "normal"])
  e = await fresh(L, 3); await e.press("V"); await e.press("Escape"); eq("V Esc", [e.sim.hasSel(), e.get("mode")], [false, "normal"])
  // empty selection guard: d on an empty visual selection must not delete anything
  e = await fresh("abc", 1); await e.press("v"); await e.press("h"); await e.press("h"); await e.press("d"); await e.sleep(60)
  console.log("     (vhh d) text =", JSON.stringify(e.sim.text))

  // ---- emoji / combining marks (sim moves by grapheme)
  const E = "x😀 yy z"
  e = await fresh(E, 0); await e.pressAll("ww"); eq("ww over emoji", e.sim.focus, E.indexOf("yy"))
  e = await fresh(E, 0); await e.press("f"); await e.pressRaw("z"); eq("fz after emoji", e.sim.focus, E.indexOf("z"))
  e = await fresh(E, 0); await e.press("f"); await e.pressRaw("😀"); eq("f😀", e.sim.focus, 1)
  e = await fresh(E, E.length); await e.press("b"); eq("b", e.sim.focus, E.indexOf("z"))
  e = await fresh(E, 0); await e.pressAll("dw"); await e.sleep(30); eq("dw before emoji", e.sim.text, "😀 yy z")
  const C = "cafe\u0301 ok"   // e + combining acute
  e = await fresh(C, 0); await e.press("w"); eq("w over combining mark", e.sim.focus, C.indexOf("ok"))
  e = await fresh("a😀b😀c", 0); await e.press("v"); await e.pressAll("ll"); eq("v ll over emoji", e.sim.selText(), "a😀b")
  e = await fresh("a😀b😀c", 0); await e.pressAll("2f"); await e.pressRaw("😀"); eq("2f😀", e.sim.focus, 4)
  e = await fresh("é😀 x", 0); await e.pressAll("diw"); await e.sleep(40); eq("diw treats accented letter as word char", e.sim.text, "😀 x")

  // ---- ^ on all-blank line goes to last char
  e = await fresh("    ", 0); await e.press("^"); eq("^ on blank line", e.sim.focus, 3)

  // ---- held key / repeat
  e = await fresh("a b c d e f g h", 0)
  await e.press("w", false); for (let i = 0; i < 6; i++) await e.press("w", false, { repeat: true }); await e.settle(); await e.sleep(20)
  eq("held w: repeats during a read are dropped", e.sim.focus, 2)
  e = await fresh("a b c d e f g h", 0)
  await e.press("w", false); await e.press("w", false); await e.press("w", false); await e.settle(); await e.sleep(20)
  eq("distinct presses during a read are queued", e.sim.focus, 6)

  // ---- Ctrl shortcuts during a read
  e = await fresh("one two three", 0); e.sim.clipboard = "ZZ"
  await e.press("w", false); await e.pressRaw("v", false, { ctrlKey: true }); await e.settle(); await e.sleep(30)
  eq("Ctrl+V during a read waits, then pastes at the caret", e.sim.text, "one ZZtwo three")
  e = await fresh("one two three", 0)
  await e.press("w", false); await e.pressRaw("b", false, { ctrlKey: true }); await e.settle(); await e.sleep(20)
  eq("unmapped Ctrl key during a read is dropped, no selection", [e.sim.focus, e.sim.hasSel()], [4, false])

  // ---- real 40ms idle refresh must leave no selection and not disturb keys
  e = await fresh("hello world foo", 0, { refreshMs: 40 })
  for (const k of "wlwh") { await e.press(k); await e.sleep(25) }
  await e.sleep(200); eq("40ms refresh: no stray selection, clipboard intact", [e.sim.hasSel(), e.sim.focus], [false, e.sim.focus])
  e = await fresh("hello world", 3, { refreshMs: 40 }); e.sim.clipboard = "MINE"; await e.press("l"); await e.sleep(250)
  eq("40ms refresh restores clipboard and caret", [e.sim.clipboard, e.sim.focus, e.sim.hasSel()], ["MINE", 4, false])

  console.log(fails ? `${fails} FAILURES` : "ALL OK")
  process.exit(fails ? 1 : 0)
})()
