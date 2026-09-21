// Overlay follows a (fake) native caret: scroll, arrow keys, clicks, blink.
const { makeEnv } = require("./harness")
let fails = 0
const eq = (n, g, x) => { const ok = JSON.stringify(g) === JSON.stringify(x); if (!ok) fails++; console.log(ok ? "ok  " : "FAIL", n, ok ? "" : `got ${JSON.stringify(g)} expected ${JSON.stringify(x)}`) }
;(async () => {
  const e = makeEnv("hello world", {})
  const d = e.ctx.document
  const caret = { style: {}, isConnected: true, rect: { left: 100, top: 200, width: 1, height: 16, bottom: 216 }, getBoundingClientRect() { return this.rect } }
  d.getElementsByClassName = (c) => (c === "kix-cursor-caret" ? [caret] : [])
  const el = { ownerDocument: { defaultView: { getComputedStyle: () => ({ fontSize: "16px", fontFamily: "Arial", fontWeight: "400" }) } } }
  d.querySelector = (s) => (s === ".docs-texteventtarget-iframe" ? { contentDocument: { activeElement: el, querySelector: () => el } } : null)
  d.createElement = () => ({ style: {}, appendChild() {}, isConnected: true, getContext: () => ({ set font(v) {}, measureText: () => ({ width: 9 }) }) })
  const overlay = () => e.get("cursorBoxOverlay")
  e.get("updateCursorOverlay('block')")
  eq("box drawn over caret", [overlay().style.left, overlay().style.top, overlay().style.width, caret.style.opacity], ["100px", "200px", "9px", "0"])
  caret.rect = { left: 100, top: 120, width: 1, height: 16, bottom: 136 }; e.get("overlayFrame()")
  eq("follows a scroll (frame loop)", overlay().style.top, "120px")
  caret.rect = { left: 140, top: 120, width: 1, height: 16, bottom: 136 }; e.get("overlayFrame()")
  eq("follows an arrow key / click", overlay().style.left, "140px")
  caret.rect = { left: 0, top: 0, width: 0, height: 0, bottom: 0 }; e.get("overlayFrame()")
  eq("blink 'off' phase keeps the box (no flicker/jump)", [overlay().style.left, overlay().style.display], ["140px", "block"])
  e.get("hideCursorBoxOverlay()"); eq("insert mode hides box, restores native caret", [overlay().style.display, caret.style.opacity], ["none", ""])
  // moving the caret without DocsKeys schedules an exact-width refresh; our own read must not re-trigger it forever
  e.get("switchModeToNormal()"); caret.rect = { left: 10, top: 10, width: 1, height: 16, bottom: 26 }
  let runs = 0; const orig = e.ctx.runAccurateWidthRefresh
  e.get("overlayFrame()"); await e.sleep(200); await e.settle()
  const k1 = e.sim.keyLog.length; e.get("overlayFrame()"); await e.sleep(300)
  eq("no self-triggering refresh loop", e.sim.keyLog.length, k1)
  console.log(fails ? `${fails} FAILURES` : "ALL OK"); process.exit(fails ? 1 : 0)
})()
