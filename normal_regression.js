const { makeEnv } = require("./harness")
let fails = 0
const eq = (name, got, exp) => { const ok = JSON.stringify(got) === JSON.stringify(exp); if (!ok) fails++; console.log(ok ? "ok  " : "FAIL", name, ok ? "" : `got ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`) }
async function fresh(text, off) { const e = makeEnv(text); e.sim.setCaret(off); return e }
;(async () => {
  let e
  const L = "foo bar.baz qux"
  e = await fresh(L, 0); await e.press("w"); eq("w", e.sim.focus, 4)
  e = await fresh(L, 0); await e.press("e"); eq("e", e.sim.focus, 2)
  e = await fresh(L, 0); await e.pressAll("ee"); eq("ee", e.sim.focus, 6)
  e = await fresh(L, 0); await e.pressAll("3w"); eq("3w", e.sim.focus, 8)
  e = await fresh(L, 14); await e.press("b"); eq("b", e.sim.focus, 12)
  e = await fresh(L, 0); await e.press("W"); eq("W", e.sim.focus, 4)
  e = await fresh(L, 4); await e.press("W"); eq("W over punct", e.sim.focus, 12)
  e = await fresh(L, 0); await e.press("f"); await e.pressRaw("q"); eq("fq", e.sim.focus, 12)
  e = await fresh(L, 0); await e.press("t"); await e.pressRaw("q"); eq("tq", e.sim.focus, 11)
  e = await fresh(L, 14); await e.press("F"); await e.pressRaw("b"); eq("Fb", e.sim.focus, 8)
  e = await fresh("   indented", 8); await e.press("^"); eq("^", e.sim.focus, 3)
  e = await fresh(L, 0); await e.pressAll("dw"); await e.sleep(30); eq("dw", e.sim.text, "bar.baz qux")
  e = await fresh(L, 0); await e.press("d"); await e.press("f"); await e.pressRaw("r"); await e.sleep(30); eq("dfr", e.sim.text, ".baz qux")
  e = await fresh(L, 0); await e.pressAll("l"); await e.sleep(20); await e.pressAll("l"); eq("ll", e.sim.focus, 2)
  // ; then , keep original direction
  e = await fresh("a-b-c-d-e", 0); await e.press("f"); await e.pressRaw("-"); await e.press(";"); await e.press(","); await e.press(";")
  eq("f- ; , ;", e.sim.focus, 3 + 0 === 3 ? 3 : 3)
  console.log(fails ? `${fails} FAILURES` : "ALL OK"); process.exit(fails ? 1 : 0)
})()
