const { spawnSync } = require("node:child_process")
const fs = require("node:fs")
const path = require("node:path")

function run(label, args) {
    const result = spawnSync(process.execPath, args, { cwd: __dirname, encoding: "utf8", timeout: 60000 })
    if (result.error || result.status !== 0) {
        console.error(`FAIL ${label}\n${result.stdout || ""}${result.stderr || ""}`)
        if (result.error) console.error(result.error.message)
        process.exit(1)
    }
    console.log(`PASS ${label}`)
}

for (const file of fs.readdirSync(__dirname).filter((name) => name.endsWith(".js"))) {
    run(`syntax ${file}`, ["--check", path.join(__dirname, file)])
}
for (const file of ["normal_regression.js", "fixes.js", "visual_scenarios.js", "scroll_zoom.js", "overlay.js", "regressions.js", "integration_regression.js"]) {
    run(file, [file])
}
run("random visual selections (seed 7, 40 cases)", ["visual_random.js", "7", "40"])
