const { makeEnv } = require("./harness")
let seed = Number(process.argv[2] || 1)
const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296
const pick = (a) => a[Math.floor(rnd() * a.length)]
const words = ["foo", "bar", "baz_1", "qux", "a.b", "(x,y)", "hello", "w", "--", "end;", "I"]
function makeLine() {
  const n = 2 + Math.floor(rnd() * 6)
  let s = rnd() < 0.3 ? "  " : ""
  for (let i = 0; i < n; i++) s += pick(words) + (rnd() < 0.2 ? "   " : " ")
  return s.trimEnd() + (rnd() < 0.15 ? " x" : "")
}
;(async () => {
  let fails = 0, steps = 0
  for (let trial = 0; trial < Number(process.argv[3] || 40); trial++) {
    const line = makeLine()
    const text = "top line\n" + line + "\nbottom line"
    const env = makeEnv(text, { warn: () => {} })
    const { sim, ctx, press, pressRaw, get } = env
    const off0 = 9
    const p = Math.floor(rnd() * line.length)          // caret boundary; cursor char = p
    sim.setCaret(off0 + p)
    await press("v")
    let a = p, c = p, last = null
    const n = line.length
    const log = [`line=${JSON.stringify(line)} p=${p}`]
    const nsteps = 3 + Math.floor(rnd() * 8)
    for (let s = 0; s < nsteps; s++) {
      const k = pick(["h","l","h","l","w","e","b","W","E","B","0","^","$","f","t","F","T",";",",","o","iw","aw","iW","aW"])
      let nc = c, na = a, ok = true
      const rw = (kind, cls) => {
        const fwd = kind !== "b"
        const finder = kind === "e" ? ctx.findWordEnd : kind === "w" ? ctx.findWordStart : ctx.findWordStartBackward
        const t = fwd ? line.slice(c) : line.slice(0, c)
        const st = ctx.countedWordSteps(t, cls, 1, finder, !fwd)
        if (st === -1) { ok = false; return }
        nc = fwd ? c + st : c - st
      }
      if (k === "h") nc = Math.max(0, c - 1)
      else if (k === "l") nc = Math.min(n - 1, c + 1)
      else if ("web".includes(k)) rw(k, ctx.classifyWordChar)
      else if ("WEB".includes(k)) rw(k.toLowerCase(), ctx.classifyWORDChar)
      else if (k === "0") nc = 0
      else if (k === "^") nc = line.search(/\S/) === -1 ? 0 : line.search(/\S/)
      else if (k === "$") nc = n - 1
      else if ("ftFT".includes(k) || k === ";" || k === ",") {
        let type, ch
        if (k === ";" || k === ",") {
          if (!last) { ok = false } else { ch = last.ch; type = k === ";" ? last.type : ({f:"F",F:"f",t:"T",T:"t"})[last.type] }
        } else { type = k; ch = pick(line.replace(/\s/g, "").split("")) }
        if (ok) {
          const fwd = type === "f" || type === "t", till = type === "t" || type === "T"
          let target = null
          const skip = (k === ";" || k === ",") && till   // Vim default cpo (no ';'): ; and , after t/T skip an adjacent match
          if (fwd) { const r = ctx.findForward(line.slice(c), ch, 1, skip); if (r.found) { const st = till ? r.matchIndex - 1 : r.matchIndex; if (st >= 0) target = c + st } }
          else { const r = ctx.findBackward(line.slice(0, c), ch, 1, skip); if (r.found) { const st = till ? r.distance - 1 : r.distance; if (st >= 0) target = c - st } }
          if (k !== ";" && k !== ",") { if (target !== null) last = { type, ch } }
          else if (target !== null) last = { type: last.type, ch: last.ch } // ; and , keep original
          if (target !== null) nc = target
          if (k === "f" || k === "t" || k === "F" || k === "T") { await press(k); await pressRaw(ch) }
          else await press(k)
          k === k
        }
      }
      else if (k === "o") { na = c; nc = a }
      else if (k.length === 2) {
        const cls = k[1] === "W" ? ctx.classifyWORDChar : ctx.classifyWordChar
        const around = k[0] === "a"
        if (a === c) { const r = ctx.textObjectRange(line, c, cls, around); na = r[0]; nc = r[1] }
        else if (c > a) { if (c + 1 < n) nc = ctx.textObjectRange(line, c + 1, cls, around)[1] }
        else if (c - 1 >= 0) nc = ctx.textObjectRange(line, c - 1, cls, around)[0]
      }
      if (!ok) continue
      if (!("ftFT;,".includes(k))) {
        if (k.length === 2) { await press(k[0]); await press(k[1]) } else await press(k)
      }
      a = na; c = nc
      if (rnd() < 0.3) await env.sleep(170)   // let the old cosmetic refresh window pass
      const lo = Math.min(a, c), hi = Math.max(a, c)
      const expect = line.slice(lo, hi + 1)
      steps++
      log.push(`${k} -> a=${a} c=${c} sel=${JSON.stringify(expect)}`)
      if (sim.selText() !== expect || get("mode") !== "visual") {
        fails++
        console.log("FAIL", log.join(" | "), "\n   got", JSON.stringify(sim.selText()), "mode", get("mode"))
        break
      }
    }
    // finally d and compare
    if (fails === 0 || true) {
      const lo = Math.min(a, c), hi = Math.max(a, c)
      const before = sim.text
      if (sim.selText() === line.slice(lo, hi + 1)) {
        await press("d"); await env.sleep(20)
        const exp = "top line\n" + line.slice(0, lo) + line.slice(hi + 1) + "\nbottom line"
        if (sim.text !== exp) { fails++; console.log("FAIL d", log.join(" | "), JSON.stringify(sim.text), JSON.stringify(exp)) }
      }
    }
  }
  console.log(`done seed=${process.argv[2]||1} steps=${steps} fails=${fails}`)
  process.exit(fails ? 1 : 0)
})()
