const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const Vim = require("./vim")
const { makeEnv } = require("./harness")

const cases = []
for (const text of ["one two.three, four", "a b\nc d", "a\n\nb\n", "  one   two\nlast", "a", "", "foo-bar\nx.y z", "a  \n b \nlast", "\n\n", " \tfoo\n\n   bar "]) {
    for (let at = 0; at < Math.max(1, text.length); at++) {
        if (text[at] === "\n" && !Vim.emptyLine([...text], at)) continue
        for (const motion of ["w", "b", "e", "W", "B", "E", "ge", "gE"]) {
            for (const count of [1, 2, 4]) cases.push({ text, at, keys: `${count === 1 ? "" : count}${motion}`, kind: "motion", motion, count })
        }
        for (const op of ["d", "c", "y"]) {
            for (const motion of ["w", "b", "e", "W", "B", "E", "ge", "gE"]) {
                for (const count of [1, 2]) cases.push({ text, at, keys: `${op}${count === 1 ? "" : count}${motion}`, kind: "operator", motion, count, op })
            }
        }
    }
}
const adapterCases = []
const adapterText = "one two.three\n\nfour five\nsix"
for (const at of [0, 14, 20]) {
    for (const keys of ["vwwbb", "v2w", "v2e", "v3wbb", "vkkjj", "v3wge", "v$", "gE", "2ge", "2d2w", "cw", "2cw", "db", "d2e", "gg", "2gg", "G", "g_", "dg_", "$"]) {
        adapterCases.push({ text: adapterText, at, keys, kind: "adapter" })
    }
}
for (const [text, at, keys] of [
    ["one hi two hi three", 0, "/hi\rnN"],
    ["one hi two hi three", 0, "d/hi\r"],
    ["one hi two hi three", 0, "y/hi\r"],
    ["one hi two hi three", 0, "c/hi\r"],
    ["one hi two hi three", 0, "2/hi\r"],
    ["one hi two hi three", 18, "d?hi\r"],
    ["one\nhi two\nlast", 1, "d/hi\r"],
    ["one\nhi two\nlast", 0, "c/hi\r"],
    ["one\nhi two\nlast", 0, "v/hi\r"],
    ["one one_more one\none", 0, "*nN"],
    ["one one_more one\none", 16, "#"],
    ["a\n  b\nc", 4, "dgg"],
    ["a\n", 2, "vd"],
    ["a\n", 2, "vc"],
]) adapterCases.push({ text, at, keys, kind: "adapter" })
cases.push(...adapterCases)
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "docskeys-oracle-"))
const input = path.join(temp, "cases.json"), output = path.join(temp, "results.json")
const log = path.join(temp, "nvim.log")
fs.writeFileSync(input, JSON.stringify(cases))
const nvim = process.env.DOCSKEYS_NVIM || "nvim"
const result = spawnSync(nvim, ["--headless", "-u", "NONE", "-i", "NONE", "-n", "-l", path.join(__dirname, "nvim_oracle.lua")], {
    encoding: "utf8", timeout: 60000,
    env: { ...process.env, DOCSKEYS_CASES: input, DOCSKEYS_RESULTS: output, NVIM_LOG_FILE: log },
})
if (result.error && result.error.code === "ENOENT") {
    console.log("SKIP Neovim differential tests: install nvim or set DOCSKEYS_NVIM")
    fs.unlinkSync(input); fs.rmdirSync(temp); process.exit(0)
}
if (result.error || result.status !== 0) throw new Error(result.error || result.stderr)
const expected = JSON.parse(fs.readFileSync(output, "utf8"))
fs.unlinkSync(input); fs.unlinkSync(output); if (fs.existsSync(log)) fs.unlinkSync(log); fs.rmdirSync(temp)
let failures = 0
for (let i = 0; i < cases.length; i++) {
    const test = cases[i], oracle = expected[i], chars = [...test.text]
    if (test.kind === "adapter") continue
    const WORD = test.motion === test.motion.toUpperCase() || test.motion === "gE"
    const kind = test.motion.toLowerCase()
    let got
    if (test.kind === "motion") {
        got = Vim.word(chars, test.at, kind, test.count, WORD).target
        if (got !== oracle.at) {
            if (failures++ < 40) console.error("MOTION", test, "got", got, "nvim", oracle.at)
        }
    } else {
        const range = Vim.wordRange(chars, test.at, kind, test.count, WORD, test.op)
        got = test.op === "y" ? test.text : chars.slice(0, range.start).concat(chars.slice(range.end)).join("")
        // Nvim always has at least one empty buffer line; joining lines is "".
        if (got !== oracle.text) {
            if (failures++ < 40) console.error("OPERATOR", JSON.stringify(test), "got", JSON.stringify(got), "nvim", JSON.stringify(oracle.text))
        }
    }
}
assert.equal(failures, 0, `${failures}/${cases.length} cases differ from Neovim`)
console.log(`${cases.length - adapterCases.length} word motions/operator ranges match Neovim`)

;(async () => {
    for (let i = cases.length - adapterCases.length; i < cases.length; i++) {
        const test = cases[i], oracle = expected[i]
        for (const wordMotion of ["native", "precise"]) {
            const e = makeEnv(test.text, { settings: { dvorak: false, wordMotion } })
            e.sim.setCaret(test.at)
            for (const char of test.keys) await e.pressRaw(char === "\r" ? "Enter" : char)
            await e.settle()
            const visual = e.get("mode") === "visual"
            const got = { text: e.sim.text, selection: visual ? e.sim.selText() : null }
            // Cursor positions after deletes/changes depend on Docs' insertion
            // caret. Compare logical motion cursors and all resulting ranges.
            if (!/[dcy]/.test(test.keys)) got.at = visual && e.get("visualModel") ? e.get("visualModel.c") : e.sim.focus
            const want = { text: oracle.text, selection: oracle.selection }
            if (got.at !== undefined) want.at = oracle.at
            try { assert.deepEqual(got, want) }
            catch (err) {
                if (failures++ < 10) console.error("ADAPTER", wordMotion, test, "got", got, "nvim", want)
            }
        }
    }
    assert.equal(failures, 0, "Extension command results differ from Neovim")
    console.log(`${adapterCases.length * 2} extension command sequences match Neovim in both speed modes`)
})().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1) })
