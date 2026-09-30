// 真实建表语句回归检查：node check-ddl.js（扫描根由 fixture-root 解析，可用 --root 指定）
const path = require('path');
const { collectFromFixtureRoot } = require('./extract-ddl');
const { formatSql } = require('./formatter-core');

const cfg = {
	keywordCase: 'lower',
	expressionWidth: 100,
	logicalOperatorNewline: 'before',
	linesBetweenQueries: 1,
};

// 代码骨架（去注释、去空白、小写）与注释集合分开比对：
// 逗号与行尾注释交换位置是良性的（注释贴字段、逗号在下一行行首），不该算内容改动
function analyze(text) {
	const comments = [];
	let quote = null;
	let buf = '';
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quote) {
			buf += c;
			if (c === quote && text[i - 1] !== '\\') quote = null;
			continue;
		}
		if (c === "'" || c === '"' || c === '`') {
			quote = c;
			buf += c;
			continue;
		}
		if (c === '-' && text[i + 1] === '-') {
			const nl = text.indexOf('\n', i);
			const end = nl < 0 ? text.length : nl;
			comments.push(text.slice(i, end).trim());
			i = end;
			continue;
		}
		if (c === '/' && text[i + 1] === '*') {
			const end = text.indexOf('*/', i + 2);
			const stop = end < 0 ? text.length : end + 2;
			comments.push(text.slice(i, stop).replace(/\s+/g, ' ').trim());
			i = stop - 1;
			continue;
		}
		buf += c;
	}
	return {
		comments: comments.sort(),
		skeleton: buf.replace(/\s+/g, '').toLowerCase(),
	};
}

// 骨架首处差异的上下文：直接印在报告里，省得再去 char-diff-ddl.js 复现一遍
function firstSkeletonDiff(a, b) {
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	const from = Math.max(0, i - 50);
	return `首个差异位于骨架第 ${i} 字符\n    原: ${JSON.stringify(a.slice(from, i + 70))}\n    新: ${JSON.stringify(
		b.slice(from, i + 70)
	)}`;
}

// 只相差空行 = sql-formatter 对某些形态（CTAS 括号内含查询体，插件不参与重排）的排版抖动，
// 不改动任何代码与注释，单独计数不记为问题；行内容变了才算真不幂等
const dropBlank = (text) =>
	text
		.split('\n')
		.filter((l) => l.trim())
		.join('\n');

function firstLineDiff(a, b) {
	const la = a.split('\n');
	const lb = b.split('\n');
	let i = 0;
	while (i < la.length && i < lb.length && la[i] === lb[i]) i++;
	return `首个差异位于第 ${i + 1} 行（${la.length} 行 → ${lb.length} 行）\n    一次: ${JSON.stringify(
		la[i] === undefined ? '<无此行>' : la[i]
	)}\n    二次: ${JSON.stringify(lb[i] === undefined ? '<无此行>' : lb[i])}`;
}

const fixtures = collectFromFixtureRoot();
// 没语料 = 真实建表语句一条都没验证：按「未验证」退出，不能算通过（0 条通过是假绿）
if (!fixtures) {
	console.log('\n判定：未验证 —— 没找到语料仓，真实建表语句一条也没跑（退出码 2）');
	process.exit(2);
}
if (!fixtures.length) {
	console.log('\n判定：未验证 —— 语料仓里没抓到 create table 语句，等于没跑（退出码 2）');
	process.exit(2);
}
const problems = [];
const drifts = [];
let touched = 0;

fixtures.forEach(({ file, stmt }, idx) => {
	let once;
	try {
		once = formatSql(stmt, cfg, 4);
	} catch (e) {
		problems.push({ idx, file, kind: 'THROW', msg: e.message });
		return;
	}
	if (once !== stmt) touched++;
	const a = analyze(stmt);
	const b = analyze(once);
	if (a.skeleton !== b.skeleton) {
		problems.push({ idx, file, kind: 'CODE_DIFF', msg: '代码骨架被改动\n' + firstSkeletonDiff(a.skeleton, b.skeleton) });
		return;
	}
	if (JSON.stringify(a.comments) !== JSON.stringify(b.comments)) {
		problems.push({ idx, file, kind: 'COMMENT_DIFF', msg: '注释条数/内容变了' });
		return;
	}
	let twice;
	try {
		twice = formatSql(once, cfg, 4);
	} catch (e) {
		problems.push({ idx, file, kind: 'THROW2', msg: e.message });
		return;
	}
	if (twice !== once) {
		if (dropBlank(twice) === dropBlank(once)) {
			drifts.push({ idx, file });
		} else {
			problems.push({ idx, file, kind: 'NOT_IDEMPOTENT', msg: '二次格式化行内容变了\n' + firstLineDiff(once, twice) });
		}
		return;
	}
});

console.log(
	`共 ${fixtures.length} 条，重排 ${touched} 条，问题 ${problems.length} 条，空行抖动 ${drifts.length} 条（不计问题）`
);
problems.slice(0, 25).forEach((p) => console.log(`  [${p.kind}] ${path.basename(p.file)} #${p.idx} ${p.msg}`));
drifts.slice(0, 25).forEach((d) => console.log(`  [BLANK_DRIFT] ${path.basename(d.file)} #${d.idx} 仅空行差异`));

// 位置参数留给「看某条样本」，只认纯数字序号，避免把 --root 的路径当成序号
const show = process.argv.slice(2).find((a) => /^\d+$/.test(a));
if (show) {
	const f = fixtures.find((_, i) => String(i) === show);
	if (f) {
		console.log('\n===== 原文 =====\n' + f.stmt);
		console.log('\n===== 格式化后 =====\n' + formatSql(f.stmt, cfg, 4));
	}
}
