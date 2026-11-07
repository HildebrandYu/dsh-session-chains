#!/usr/bin/env bash
#
# 把這個外掛發佈到 npm（`session-chains`）。
#
# 為什麼要包一支腳本：這台機器的 npm 快取與 log 目錄（`~/.npm`）在 DSH 沙箱下
# **不可寫**，直接 `npm publish` 會在寫入 log 時報錯；所以一律把 `--cache` 與
# `--logs-dir` 指到 /tmp。憑證不放在 repo 裡：預設讀 `~/.npmrc`（`npm login` 寫的），
# 也可以用 `NPM_USERCONFIG=/tmp/npmrc` 指到另一個含 token 的檔案。
#
# 用法：
#   npm login                                   # 一次性，互動式（會開瀏覽器／要 OTP）
#   ./scripts/publish-npm.sh                    # 檢查 → dry-run → 真的發佈
#   ./scripts/publish-npm.sh --tag next         # 其他 npm publish 參數會原樣往後傳
#
set -euo pipefail
cd "$(dirname "$0")/.."

NPM_CACHE="${NPM_CACHE:-/tmp/npm-cache}"
NPM_LOGS="${NPM_LOGS:-/tmp/npm-logs}"
# 注意：macOS 內建 bash 3.2 在 `set -u` 下展開「空陣列」會報 unbound variable，
# 所以下面每處展開都加上加號守衛（bash 3.2 相容寫法）。
PLAIN=()
if [ -n "${NPM_USERCONFIG:-}" ]; then
	PLAIN+=(--userconfig "$NPM_USERCONFIG")
fi

echo "== 1/4 登入狀態"
if ! npm whoami --cache "$NPM_CACHE" --logs-dir "$NPM_LOGS" ${PLAIN[@]+"${PLAIN[@]}"} >/dev/null 2>&1; then
	echo "   尚未登入。先跑『npm login』（一次性），或用 NPM_USERCONFIG 指向含 token 的 .npmrc。"
	exit 1
fi
echo "   已登入：$(npm whoami --cache "$NPM_CACHE" --logs-dir "$NPM_LOGS" ${PLAIN[@]+"${PLAIN[@]}"})"

echo "== 2/4 版號與工作區狀態"
PACKED="$(node -e 'const p=require("./package.json");process.stdout.write(p.name+"@"+p.version)')"
echo "   $PACKED"
if [ -n "$(git status --porcelain)" ]; then
	echo "   注意：工作區有未提交的改動（npm 只看檔案內容，不看 git）；建議先 commit。"
fi
if git rev-parse --git-dir >/dev/null 2>&1; then
	if ! git diff --quiet -- .; then
		echo "   注意：目前內容與最後一次 commit 不同。"
	fi
fi

echo "== 3/4 打包預覽"
npm publish --dry-run --cache "$NPM_CACHE" --logs-dir "$NPM_LOGS" ${PLAIN[@]+"${PLAIN[@]}"} | tail -8

echo "== 4/4 發佈"
npm publish --cache "$NPM_CACHE" --logs-dir "$NPM_LOGS" ${PLAIN[@]+"${PLAIN[@]}"} "$@"
echo "完成：https://www.npmjs.com/package/${PACKED%@*}"
