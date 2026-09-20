const { makeEnv } = require("./harness")
let fails = 0
const eq = (name, got, exp) => { const ok = JSON.stringify(got) === JSON.stringify(exp); if (!ok) fails++; console.log(ok ? "ok  " : "FAIL", name, ok ? "" : `got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`) }
const T = "abcdefgh\nabcdefgh\nabcdefgh"
async function fresh(text, off) { const e = makeEnv(text); e.sim.setCaret(off); return e }
;(async () => {
  let e
  e = await fresh(T, 9 + 3); await e.press("v"); await e.press("k")
  eq("v k", e.sim.selText(), T.slice(3, 13)); eq("v k mode/model", [e.get("mode"), e.get("visualModel")], ["visual", null])
  await e.press("d"); await e.sleep(20); eq("v k d", e.sim.text, T.slice(0, 3) + T.slice(13))
  e = await fresh(T, 9 + 3); await e.press("v"); await e.press("j")
  eq("v j", e.sim.selText(), T.slice(12, 18 + 3 + 1))
  e = await fresh(T, 9 + 3); await e.pressAll("vllk")
  eq("v l l k", e.sim.selText(), T.slice(5, 13))
  e = await fresh(T, 9 + 3); await e.pressAll("vhj")
  eq("v h j", e.sim.selText(), T.slice(9 + 3, 18 + 2 + 1))
  e = await fresh(T, 9 + 3); await e.pressAll("vhk")
  eq("v h k", e.sim.selText(), T.slice(2, 13))
  e = await fresh(T, 9 + 3); await e.pressAll("vjjk"); await e.sleep(200)
  console.log("     (v j j k, native after crossing) sel =", JSON.stringify(e.sim.selText()), "mode", e.get("mode"))

  // Esc caret placement
  e = await fresh(T, 9 + 3); await e.pressAll("vll"); await e.press("Escape")
  eq("Esc forward caret", [e.sim.focus, e.sim.hasSel(), e.get("mode")], [9 + 5, false, "normal"])
  e = await fresh(T, 9 + 3); await e.pressAll("vhh"); await e.press("Escape")
  eq("Esc backward caret", [e.sim.focus, e.sim.hasSel()], [9 + 1, false])
  e = await fresh(T, 9 + 3); await e.press("v"); await e.press("Escape")
  eq("v Esc caret", [e.sim.focus, e.sim.hasSel()], [9 + 3, false])

  // yank
  e = await fresh(T, 9 + 3); e.sim.clipboard = "OLD"; await e.pressAll("vlly"); await e.sleep(30)
  eq("v l l y", [e.sim.clipboard, e.sim.focus, e.sim.hasSel(), e.get("mode")], ["def", 12, false, "normal"])

  // counts
  e = await fresh(T, 9 + 1); await e.pressAll("v3l"); eq("v 3l", [e.sim.selText(), e.get("mode")], [T.slice(10, 14), "visual"])
  e = await fresh("aa bb cc dd ee ff", 0); await e.pressAll("v2w"); eq("v 2w", [e.sim.selText(), e.get("mode")], ["aa bb c", "visual"])
  e = await fresh("a-b-c-d-e", 0); await e.press("v"); await e.press("3"); await e.press("f"); await e.pressRaw("-"); eq("v 3f-", e.sim.selText(), "a-b-c-")

  // Esc cancelling pending f keeps visual
  e = await fresh(T, 9 + 3); await e.pressAll("vf"); await e.press("Escape"); eq("v f Esc stays visual", [e.get("mode"), e.sim.selText()], ["visual", "d"])
  // invalid text object key keeps charwise visual
  e = await fresh(T, 9 + 3); await e.pressAll("vix"); eq("v i x -> visual", e.get("mode"), "visual")

  // race: x during the cosmetic refresh
  e = await fresh("abc def ghi", 4); await e.press("l"); await e.sleep(155); await e.press("x", false); await e.settle(); await e.sleep(60)
  eq("x during refresh window (new)", e.sim.text, "abc df ghi")

  // stale clipboard at EOL
  e = await fresh("hello world\nnext", 11); e.sim.clipboard = "STALE CLIPBOARD TEXT"
  await e.press("w"); await e.sleep(50)
  eq("w at EOL keeps clipboard", e.sim.clipboard, "STALE CLIPBOARD TEXT")
  e = await fresh("hello world", 11); e.sim.clipboard = "STALE CLIPBOARD TEXT"; await e.press("f"); await e.pressRaw("o"); await e.sleep(50)
  eq("f at EOL no garbage move", e.sim.focus, 11)

  // v at EOL / line start / empty line / word-end fallback
  e = await fresh("hello\nworld", 5); await e.press("v"); eq("v at EOL selects last char", [e.sim.selText(), e.get("visualModel").a], ["o", 4])
  e = await fresh("hello\nworld", 0); e.sim.clipboard = "JUNK"; await e.press("v"); await e.sleep(30); eq("v at line start", [e.sim.selText(), e.sim.clipboard], ["h", "JUNK"])
  e = await fresh("a\n\nb", 2); await e.press("v"); await e.sleep(50); eq("v on empty line no crash", [e.get("mode"), e.get("visualModel")], ["visual", null])
  e = await fresh("one two\nthree four", 4); await e.press("v"); await e.press("w"); await e.sleep(10)
  console.log("     v w on last word (native fallback): sel", JSON.stringify(e.sim.selText()), "model", e.get("visualModel"))
  await e.press("h"); eq("h after fallback still visual", e.get("mode"), "visual")

  // V mode: no reads
  e = await fresh(T, 9 + 3); await e.press("V"); const c0 = e.sim.copyCalls; await e.pressAll("wbeh"); await e.sleep(300)
  eq("V mode performs no oracle reads", e.sim.copyCalls, c0)
  // clipboard restored after v
  e = await fresh(T, 9 + 3); e.sim.clipboard = "MINE"; await e.press("v"); await e.sleep(50); eq("clipboard restored after v", e.sim.clipboard, "MINE")

  // visual p replaces selection
  e = await fresh("abc def", 0); e.sim.clipboard = "ZZ"; await e.pressAll("vl"); await e.press("p"); await e.sleep(20)
  eq("v l p replaces", e.sim.text, "ZZc def")
  // x / s in visual
  e = await fresh("abc def", 0); await e.pressAll("vlx"); await e.sleep(20); eq("v l x", e.sim.text, "c def")

  console.log(fails ? `${fails} FAILURES` : "ALL OK")
  process.exit(fails ? 1 : 0)
})()
