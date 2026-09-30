// 从仓库提取真实 CREATE TABLE 语句作为格式化测试样本：node extract-ddl.js
const fs = require('fs');
const path = require('path');
const { listSqlFiles } = require('./corpus');

const found = [];

function scanStatement(text, start) {
	// 从 create table 处找到列定义左括号，按括号深度（跳过引号与行注释）扫到闭合，再吃到分号
	const open = text.indexOf('(', start);
	if (open < 0) return null;
	let depth = 0;
	let quote = null;
	let j = open;
	for (; j < text.length; j++) {
		const c = text[j];
		if (quote) {
			if (c === quote && text[j - 1] !== '\\') quote = null;
			continue;
		}
		if (c === "'" || c === '"' || c === '`') {
			quote = c;
			continue;
		}
		if (c === '-' && text[j + 1] === '-') {
			const nl = text.indexOf('\n', j);
			if (nl < 0) return null;
			j = nl;
			continue;
		}
		if (c === '/' && text[j + 1] === '*') {
			const end = text.indexOf('*/', j);
			if (end < 0) return null;
			j = end + 1;
			continue;
		}
		if (c === '(') depth++;
		else if (c === ')') {
			depth--;
			if (depth === 0) break;
		}
	}
	if (depth !== 0) return null;
	let k = j + 1;
	while (k < text.length && text[k] !== ';') {
		if (text[k] === "'" || text[k] === '"' || text[k] === '`') {
			const q = text[k];
			k++;
			while (k < text.length && text[k] !== q) k++;
		}
		k++;
	}
	return text.slice(start, Math.min(k, text.length));
}

function walk(dir) {
	for (const p of listSqlFiles(dir)) {
		const text = fs.readFileSync(p, 'utf8');
		const re = /create\s+table\s+(if\s+not\s+exists\s+)?[`0-9a-zA-Z_.]+\s*\(/gi;
		let m;
		while ((m = re.exec(text))) {
			const stmt = scanStatement(text, m.index);
			if (stmt && stmt.length < 5000) {
				found.push({ file: p.replace(/\\/g, '/'), stmt });
				re.lastIndex = m.index + stmt.length;
			}
		}
	}
}

function collectCreateTables(rootDir) {
	found.length = 0;
	walk(rootDir);
	return found;
}

// 供 check-ddl 与排查脚本共用：扫描根统一走 fixture-root 解析，
// 这样 debug-*/char-diff-* 的序号能直接照抄 check-ddl 报出来的编号。
// 找不到根时返回 null，由调用方决定退出。
function collectFromFixtureRoot() {
	const { resolveRoot, hint } = require('./fixture-root');
	const root = resolveRoot();
	if (!root) {
		console.log(hint().replace(/\s+/g, ' '));
		return null;
	}
	console.log('扫描根 ' + root);
	return collectCreateTables(root);
}

module.exports = { collectCreateTables, collectFromFixtureRoot };

if (require.main === module) {
	const { resolveRoot, hint } = require('./fixture-root');
	const root = resolveRoot();
	if (!root) {
		console.log(hint());
		process.exit(0);
	}
	collectCreateTables(root);
	const outDir = path.join(__dirname, '.tmp');
	fs.mkdirSync(outDir, { recursive: true });
	const outFile = path.join(outDir, 'ddl_fixtures.txt');
	fs.writeFileSync(outFile, found.map((o, i) => '### ' + i + ' | ' + o.file + '\n' + o.stmt).join('\n\n'), 'utf8');
	console.log('扫描根 ' + root);
	console.log('抓到建表语句 ' + found.length + ' 条 → ' + outFile);
}
