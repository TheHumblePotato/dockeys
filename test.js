const { spawnSync } = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")

function run(label, args, timeout = 60000) {
    const result = spawnSync(process.execPath, args, { cwd: __dirname, encoding: "utf8", timeout })
    if (result.error || result.status !== 0) {
        console.error(`FAIL ${label}\n${result.stdout || ""}${result.stderr || ""}`)
        if (result.error) console.error(result.error.message)
        process.exit(1)
    }
    if (/^SKIP /m.test(result.stdout)) console.log(result.stdout.trim())
    else {
        console.log(`PASS ${label}`)
        if (label === "Neovim differential comparisons") console.log(result.stdout.trim())
    }
}

for (const file of fs.readdirSync(__dirname).filter((name) => name.endsWith(".js"))) {
    run(`syntax ${file}`, ["--check", path.join(__dirname, file)])
}
for (const file of ["normal_regression.js", "fixes.js", "visual_scenarios.js", "scroll_zoom.js", "overlay.js", "regressions.js", "integration_regression.js", "iteration_regression.js", "probe_regression.js", "navigation_regression.js", "docs_adapter_regression.js"]) {
    run(file, [file])
}
run("random visual selections (seed 7, 40 cases)", ["visual_random.js", "7", "40"])
run("Neovim differential comparisons", ["vim_differential.js"], 180000)
