// Zoom-aware cursor width, off-screen hiding, and scroll-command wiring.
const { makeEnv } = require("./harness")
let fails = 0
const eq = (n, g, x) => { const ok = JSON.stringify(g) === JSON.stringify(x); if (!ok) fails++; console.log(ok ? "ok  " : "FAIL", n, ok ? "" : `got ${JSON.stringify(g)} expected ${JSON.stringify(x)}`) }

function setup() {
  const e = makeEnv("hello world", {})
  const d = e.ctx.document
  const caret = { style: {}, isConnected: true, rect: { left: 50, top: 60, width: 1, height: 16, bottom: 76 }, getBoundingClientRect() { return this.rect } }
  d.getElementsByClassName = (c) => (c === "kix-cursor-caret" ? [caret] : [])
  const el = { ownerDocument: { defaultView: { getComputedStyle: () => ({ fontSize: "16px", fontFamily: "Arial", fontWeight: "400" }) } } }
  d.querySelector = (s) => (s === ".docs-texteventtarget-iframe" ? { contentDocument: { activeElement: el, querySelector: () => el } } : null)
  d.createElement = () => ({ style: {}, appendChild() {}, isConnected: true, getContext: () => ({ set font(v) {}, measureText: () => ({ width: 9 }) }) })
  e.ctx.window.innerWidth = 1200
  e.ctx.window.innerHeight = 800
  return { e, caret, overlay: () => e.get("cursorBoxOverlay") }
}

;(async () => {
  // ---- zoom-aware width: a taller caret (zoomed in) should widen the box.
  let { e, caret, overlay } = setup()
  e.get("updateCursorOverlay('block')")
  const w100 = parseFloat(overlay().style.width)
  caret.rect = { left: 50, top: 60, width: 1, height: 32, bottom: 92 } // ~2x line height: zoomed in
  e.get("overlayFrame()")
  const w200 = parseFloat(overlay().style.width)
  eq("zoomed-in caret (2x height) roughly doubles the box width", Math.abs(w200 / w100 - 2) < 0.2, true)

  // ---- off-screen: caret scrolled above/below the viewport hides the box
  ;({ e, caret, overlay } = setup())
  e.get("updateCursorOverlay('block')")
  eq("on-screen: box shown", overlay().style.display, "block")
  caret.rect = { left: 50, top: -500, width: 1, height: 16, bottom: -484 }
  e.get("overlayFrame()")
  eq("scrolled above the viewport: box hidden", overlay().style.display, "none")
  caret.rect = { left: 50, top: 60, width: 1, height: 16, bottom: 76 }
  e.get("overlayFrame()")
  eq("scrolled back into view: box reappears with no explicit resume", overlay().style.display, "block")
  caret.rect = { left: 50, top: 5000, width: 1, height: 16, bottom: 5016 }
  e.get("overlayFrame()")
  eq("scrolled below the viewport: box hidden", overlay().style.display, "none")

  // ---- scroll commands
  ;({ e } = setup())
  let scrolled = { scrollTop: 1000 }
  e.ctx.document.querySelector = (s) => (s === ".kix-appview-editor" ? scrolled : null)
  e.get("scrollOneLine(true)")
  eq("Ctrl+e scrolls the container down by ~one line, cursor untouched", [scrolled.scrollTop > 1000, e.sim.hasSel()], [true, false])
  const afterDown = scrolled.scrollTop
  e.get("scrollOneLine(false)")
  eq("Ctrl+y scrolls back up", scrolled.scrollTop < afterDown, true)

  e = makeEnv("l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10"); e.sim.setCaret(0)
  await e.press("d", true, { ctrlKey: true })
  eq("Ctrl+d moves the cursor down without selecting", [e.sim.focus > 0, e.sim.hasSel()], [true, false])
  const afterD = e.sim.focus
  await e.press("u", true, { ctrlKey: true })
  eq("Ctrl+u moves back up", e.sim.focus < afterD, true)

  console.log(fails ? `${fails} FAILURES` : "ALL OK")
  process.exit(fails ? 1 : 0)
})()
