---
name: fastPush
description: 快速 git 工作流 - 自动拉取、合并、提交和推送
model: google/gemini-flash-latest
subtask: true
---

执行快速 git 工作流：
1. 检查 git 仓库是否存在
2. 必要时暂存当前更改
3. 从远程拉取最新更改并 rebase
4. 恢复暂存的更改
5. 处理可能的合并冲突
6. 暂存所有更改
7. 用描述性消息提交
8. 推送到远程

**重要规则：**
- **commit 消息必须使用中文**
- 使用常规提交前缀（docs:, tui:, core:, ci:, wip:, 等）
- packages/web 的更改使用 docs: 前缀
- 从最终用户角度解释**为什么**改变，而不仅仅是改了什么
- 具体说明，避免泛泛的消息如"改进了代理体验"
- 如果有合并冲突，不要修复它们 - 立即通知用户并停止

**commit 消息格式示例：**
- ✅ 正确：`docs: 添加快速开始指南以帮助新用户快速上手`
- ✅ 正确：`tui: 优化命令行界面响应速度提升用户体验`
- ✅ 正确：`core: 修复内存泄漏问题防止长时间运行崩溃`
- ❌ 错误：`docs: add quick start guide` (使用了英文)
- ❌ 错误：`improved UI` (没有前缀且使用英文)

**优化工作流：**
1. 检查是否有需要暂存的本地更改
2. 如果有，运行 `git stash push -u -m "fastPush auto-stash"` 暂存所有更改（包括未跟踪文件）
3. 运行 `git fetch` 获取最新远程更改
4. 运行 `git pull --rebase origin <current-branch>` 拉取并 rebase
5. 如果拉取时发生冲突，运行 `git stash pop` 恢复更改并通知用户手动解决冲突
6. 如果拉取成功，运行 `git stash pop` 恢复本地更改
7. 如果 stash pop 时发生冲突，通知用户手动解决冲突
8. 使用 `git add -A` 暂存所有更改
9. **根据更改创建有意义的中文 commit 消息**
10. 使用 `git push origin <current-branch>` 推送

**安全检查：**
- 检查是否在有效分支上（非 detached HEAD）
- 检查远程仓库是否存在
- 拉取前检查未提交的更改
- 自动暂存和恢复以处理脏工作树
- 如果发生任何冲突立即停止

**commit 消息编写要求：**
- 必须使用中文
- 必须包含常规提交前缀（如 docs:, tui:, core:, ci:, wip:）
- 描述要具体，说明改动的原因和影响
- 从用户角度说明价值

## Current Branch

!`git branch --show-current`

## Remote Status

!`git remote -v`

## Check if behind remote

!`git fetch && git rev-list --count HEAD..@{upstream} 2>/dev/null || echo "0"`

## Check if ahead of remote

!`git rev-list --count @{upstream}..HEAD 2>/dev/null || echo "0"`

## Git Status

!`git status --short`

## Check for uncommitted changes

!`git status --porcelain | wc -l | tr -d ' '`

## Unstaged Changes

!`git diff --stat`

## Staged Changes

!`git diff --cached --stat`

## Recent Commits (for context)

!`git log --oneline -5`

## Latest remote commit

!`git log origin/$(git branch --show-current) --oneline -1 2>/dev/null || echo "No remote branch"`
