// 语料枚举与代码骨架比对：check-ddl / scan-semicolon / ab-format 共用，
// 避免各处再抄一份目录遍历和骨架归一化（抄第三份必然漂）
const fs = require('fs');
const path = require('path');

const SKIP_DIRS = ['.git', '.cm_tmp', '.tmp', '.trash', '.vscode', '.vscode-test', 'node_modules'];

// 递归列出 root 下所有 .sql（跳过依赖与临时目录）；只读
function listSqlFiles(root) {
	const out = [];
	(function walk(dir) {
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch (e) {
			return;
		}
		for (const e of entries) {
			if (SKIP_DIRS.includes(e.name)) continue;
			const p = path.join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else if (/\.sql$/i.test(e.name)) out.push(p);
		}
	})(root);
	return out;
}

// 代码骨架：剥掉注释与全部空白，引号内内容保留。用于判断「排版有没有动到代码」——
// 排版规则改动后骨架必须一致；要连大小写一起忽略时传 { ignoreCase: true }
function skeletonOf(text, opts) {
	const ignoreCase = !!(opts && opts.ignoreCase);
	let out = '';
	let quote = null;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quote) {
			out += c;
			if (c === quote && text[i - 1] !== '\\') quote = null;
			continue;
		}
		if (c === "'" || c === '"' || c === '`') {
			quote = c;
			out += c;
			continue;
		}
		if (c === '-' && text[i + 1] === '-') {
			const nl = text.indexOf('\n', i);
			i = nl < 0 ? text.length : nl;
			continue;
		}
		if (c === '/' && text[i + 1] === '*') {
			const end = text.indexOf('*/', i + 2);
			i = end < 0 ? text.length : end + 1;
			continue;
		}
		if (!/\s/.test(c)) out += c;
	}
	return ignoreCase ? out.toLowerCase() : out;
}

module.exports = { listSqlFiles, skeletonOf, SKIP_DIRS };
