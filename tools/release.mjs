#!/usr/bin/env node
/**
 * 发布引导（懒人版）：一步步带你发布新版本。
 *
 *   node tools/release.mjs          # 交互式引导发布
 *   node tools/release.mjs --dry-run  # 只检查，不真正打 tag
 *
 * 实际发布 = 打一个 vX.Y.Z 的 git tag 并推送（触发 .github/workflows/release.yml
 * 自动构建离线包 + 安装包 + 发布），本脚本只负责检查和引导，不需要你记命令。
 */

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DRY_RUN = process.argv.includes("--dry-run");

const config = JSON.parse(readFileSync(join(ROOT, "config.json"), "utf8"));

const rl = createInterface({ input: process.stdin, output: process.stdout });

// 行队列式 ask：交互终端和管道输入（echo "y" | script）都能稳定工作。
// 到达的行先入队，等有挂起的提问时再取出——避免 readline.question 在管道
// EOF 时丢回调、以及两次提问间隙到达的输入被丢弃。
const inputQueue = [];
let pendingResolver = null;
function flushQueue() {
	while (pendingResolver && inputQueue.length) {
		const r = pendingResolver;
		pendingResolver = null;
		r(inputQueue.shift());
	}
}
rl.on("line", (line) => {
	inputQueue.push(line);
	flushQueue();
});
rl.on("close", () => {
	if (pendingResolver && inputQueue.length === 0) {
		const r = pendingResolver;
		pendingResolver = null;
		r(""); // EOF：当作放弃输入
	}
});
function ask(question) {
	return new Promise((resolve) => {
		pendingResolver = resolve;
		process.stdout.write(question);
		flushQueue();
	});
}

function sh(cmd, opts = {}) {
	try {
		return execFileSync(cmd[0], cmd.slice(1), { encoding: "utf8", ...opts }).trim();
	} catch (err) {
		if (opts.allowFail) return (err.stdout ?? "").trim() || "";
		throw err;
	}
}

function step(n, title) {
	console.log(`\n┌─ 第 ${n} 步：${title}`);
}

function ok(msg) {
	console.log(`│  ✅ ${msg}`);
}
function warn(msg) {
	console.log(`│  ⚠️  ${msg}`);
}
function err(msg) {
	console.log(`│  ❌ ${msg}`);
}

async function main() {
	console.log("===============================================");
	console.log("  DSH 发布引导（懒人版）");
	console.log("  整个过程只需要：打个 tag 并推送，其余全自动");
	console.log(`  目标仓库: ${config.owner}/${config.repo}`);
	console.log(`  将打包:   dsh@${config.dshVersion} + node@${config.nodeVersion}`);
	console.log(DRY_RUN ? "  [DRY-RUN 模式：只检查不发布]" : "");
	console.log("===============================================");

	/* 1. gh 登录 */
	step(1, "检查 gh 命令行工具与登录状态");
	try {
		const who = sh(["gh", "auth", "status", "--show-token"], { allowFail: true });
		if (!who.includes("Logged in")) throw new Error("未登录");
		const m = /Logged in to github\.com account ([^\s]+)/.exec(who);
		ok(`gh 已登录：${m ? m[1] : "?"}`);
	} catch {
		err("未检测到 gh 登录。请先执行：gh auth login");
		rl.close();
		process.exit(1);
	}

	/* 2. remote 与 config 一致 */
	step(2, "检查 git remote 与 config.json 是否一致");
	const remote = sh(["git", "remote", "get-url", "origin"], { allowFail: true });
	if (remote.includes(`${config.owner}/${config.repo}`)) {
		ok(`remote 匹配：${remote}`);
	} else {
		warn(`remote 是 ${remote || "(未设置)"}，而 config.json 配置的是 ${config.owner}/${config.repo}`);
		warn("若仓库地址不一致，发布后会找不到产物。确认无误再继续。");
	}

	/* 3. 工作区干净 */
	step(3, "检查 git 工作区（未提交的改动不会被打包）");
	const dirty = sh(["git", "status", "--porcelain"]);
	if (!dirty) {
		ok("工作区干净");
	} else {
		warn(`有 ${dirty.split("\n").length} 个未提交的改动，将不会被包含在本次发布中：`);
		for (const line of dirty.split("\n").slice(0, 5)) warn(`    ${line}`);
	}

	/* 4. 版本号 */
	step(4, "确定版本号（tag）");
	// 本地 + 远端 tag 一起看，避免漏掉已在 GitHub 上发过的版本
	const remoteTags = sh(["git", "ls-remote", "--tags", "origin", "v*"], { allowFail: true })
		.split("\n")
		.map((l) => l.split("refs/tags/")[1])
		.filter(Boolean);
	const tags = [...new Set([...sh(["git", "tag", "--list", "v*"]).split("\n").filter(Boolean), ...remoteTags])];
	const last = tags
		.map((t) => t.replace(/^v/, "").split(".").map(Number))
		.filter((v) => v.length === 3 && v.every(Number.isInteger))
		.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
		.pop();
	const suggest = last ? `v${last[0]}.${last[1]}.${last[2] + 1}` : "v1.0.0";
	ok(`最近版本：${last ? `v${last.join(".")}` : "（还没有）"}，建议下一个：${suggest}`);
	const input = (await ask(`│  请输入版本号（直接回车用 ${suggest}）: `)).trim();
	const version = /^v\d+\.\d+\.\d+$/.test(input) ? input : input ? `v${input}` : suggest;
	if (!/^v\d+\.\d+\.\d+$/.test(version)) {
		err(`版本号格式不对：${version}（应为 v1.2.3）`);
		rl.close();
		process.exit(1);
	}
	const exists = tags.includes(version);
	if (exists) {
		err(`tag ${version} 已存在（说明这个版本已发布过）。想重新发请用别的版本号。`);
		rl.close();
		process.exit(1);
	}
	ok(`版本号：${version}`);

	/* 5. 确认 */
	step(5, "确认发布内容");
	console.log(`│   tag:        ${version}`);
	console.log(`│   dsh 版本:   ${config.dshVersion}`);
	console.log(`│   node 版本:  ${config.nodeVersion}`);
	console.log(`│   平台:       macOS arm64 / macOS x64(Intel) / Windows x64`);
	console.log(`│   产物:       3 个离线包 + macOS dmg + Windows exe`);
	const confirm = (await ask("│  确认发布？(y/N) ")).trim().toLowerCase();
	if (confirm !== "y" && confirm !== "yes") {
		console.log("\n已取消，未做任何改动。");
		rl.close();
		return;
	}

	/* 6. 打 tag + 推送 */
	step(6, "打 tag 并推送（触发 GitHub Actions 自动构建发布）");
	if (DRY_RUN) {
		ok(`[DRY-RUN] 跳过：git tag ${version} && git push origin ${version}`);
	} else {
		sh(["git", "tag", version]);
		ok(`已创建 tag：${version}`);
		try {
			sh(["git", "push", "origin", version]);
			ok(`已推送 tag：${version} → 触发 release workflow`);
		} catch {
			sh(["git", "tag", "-d", version]);
			err("推送失败（网络或权限？），已回滚本地 tag。请检查后重试。");
			rl.close();
			process.exit(1);
		}
	}

	/* 7. 等待构建完成 */
	step(7, "等待自动构建发布（约 8-12 分钟）");
	if (DRY_RUN) {
		ok("[DRY-RUN] 跳过等待。");
	} else {
		// 找到本次 tag 触发的 run（可能出现几秒延迟），再显式 watch
		// （非交互终端下 gh run watch 需要 run id；按 tag 过滤避免误看旧 run）
		let runId = null;
		for (let i = 0; i < 12 && !runId; i++) {
			const out = sh(
				["gh", "run", "list", "--workflow", "release.yml", "--branch", version, "--repo", `${config.owner}/${config.repo}`, "--limit", "1", "--json", "databaseId"],
				{ allowFail: true },
			);
			try {
				const runs = JSON.parse(out || "[]");
				if (runs.length) runId = runs[0].databaseId;
			} catch {
				/* not ready yet */
			}
			if (!runId) await new Promise((r) => setTimeout(r, 3000));
		}
		if (!runId) {
			warn("暂时没找到对应的工作流，请到 Actions 页面查看进度。");
			console.log(`│   https://github.com/${config.owner}/${config.repo}/actions`);
		} else {
			ok(`已找到工作流 run #${runId}，开始等待…`);
			try {
				sh(["gh", "run", "watch", String(runId), "--repo", `${config.owner}/${config.repo}`, "--exit-status"], {
					stdio: "inherit",
				});
				ok("构建发布全部成功！");
			} catch {
				err("构建有任务失败，请到 Actions 页面查看日志。");
				console.log(`│   https://github.com/${config.owner}/${config.repo}/actions`);
				rl.close();
				process.exit(1);
			}
		}
	}

	/* 8. 完成 */
	step(8, "完成 🎉");
	const url = `https://github.com/${config.owner}/${config.repo}/releases/tag/${version}`;
	console.log(`│   发布地址：${url}`);
	console.log("│   下一步：");
	console.log("│     1. 打开上面的地址，确认产物齐全（离线包 + dmg + exe）");
	console.log("│     2. 自己下载安装一次做验收（首次打开提示见 README）");
	console.log("│     3. 把链接发给用户即可");
	rl.close();
	process.exit(0);
}

main().catch((e) => {
	console.error("发布引导出错：", e.message);
	rl.close();
	process.exit(1);
});
