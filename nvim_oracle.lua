-- Run with nvim --headless -u NONE -i NONE -n -l nvim_oracle.lua.
-- The Node runner supplies temporary input/output paths through the environment.
local cases = vim.json.decode(table.concat(vim.fn.readfile(vim.env.DOCSKEYS_CASES), "\n"))
local results = {}
vim.o.clipboard = ""
vim.o.swapfile = false
vim.o.wrapscan = true
vim.o.ignorecase = false
vim.o.selection = "inclusive"
for _, case in ipairs(cases) do
  vim.cmd("enew!")
  vim.api.nvim_buf_set_lines(0, 0, -1, false, vim.split(case.text, "\n", { plain = true }))
  local prefix = case.text:sub(1, case.at)
  local row = select(2, prefix:gsub("\n", "")) + 1
  local col = #(prefix:match("[^\n]*$") or "")
  vim.api.nvim_win_set_cursor(0, { row, col })
  -- Feed typed keys rather than :normal: :normal aborts the remaining string
  -- on a failed boundary motion, unlike separate keystrokes in the editor.
  vim.api.nvim_feedkeys(case.keys, "xt", false)
  local position = vim.api.nvim_win_get_cursor(0)
  local lines = vim.api.nvim_buf_get_lines(0, 0, -1, false)
  local offset = position[2]
  for i = 1, position[1] - 1 do offset = offset + #lines[i] + 1 end
  local selection = vim.NIL
  if vim.fn.mode():sub(1, 1) == "v" then
    vim.cmd.normal({ args = { '"zy' }, bang = true })
    selection = vim.fn.getreg("z")
  end
  results[#results + 1] = { at = offset, text = table.concat(lines, "\n"), selection = selection }
  vim.cmd("normal! \027")
end
vim.fn.writefile({ vim.json.encode(results) }, vim.env.DOCSKEYS_RESULTS)
vim.cmd("qa!")
