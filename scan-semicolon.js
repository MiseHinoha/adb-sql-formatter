// 统计真实语料里「多语句文件缺分号截断」的比例：node scan-semicolon.js
// 语句切分直接调用插件上线用的 formatter-core.findStatements —— 扫描口径必须与
// 编辑器里波浪线的口径一致，另写一份必然会漂（历史教训：旧版自带实现对齐不了缩进行的
// 关键字，把 48 处命中的起始关键字统计成了 "?"）。本脚本只读，不改任何 .sql。
const fs = require('fs');
const path = require('path');
const { findStatements } = require('./formatter-core');
const { listSqlFiles } = require('./corpus');
const { resolveRoot, hint } = require('./fixture-root');

const ROOT = resolveRoot();
// 没有语料仓时按「未验证」退出（码 2）：统计脚本 0 条通过等于没跑，不该是绿的
if (!ROOT) {
	console.log(hint());
	console.log('\n判定：未验证 —— 没找到语料仓，本次没有任何真实脚本被统计（退出码 2）');
	process.exit(2);
}
console.log('扫描根 ' + ROOT);

const files = listSqlFiles(ROOT);
if (!files.length) {
	console.log('语料仓里没有 .sql 文件：本次没有任何真实脚本被统计（退出码 2）');
	process.exit(2);
}

// 可选：ADB_SQL_FIXTURE_SKIP=<正则> 过滤掉不想看的路径（默认不过滤，不替使用者判断业务归属）
const SKIP_RE = (() => {
	const src = process.env.ADB_SQL_FIXTURE_SKIP;
	if (!src) return null;
	try {
		return new RegExp(src);
	} catch (e) {
		console.log('ADB_SQL_FIXTURE_SKIP 不是合法正则，已忽略：' + src);
		return null;
	}
})();

// 相对根目录的归属：顶层目录 + 其下一层（通用两级，不假设任何具体仓名）
function areaOf(f) {
	const parts = path.relative(ROOT, f).split(/[\\/]/);
	return parts.length > 2 && parts[1] ? parts[0] + '/' + parts[1] : parts[0];
}

const report = { total: 0, multi: 0, single: 0, noStmt: 0, needSemi: [] };
const byArea = {};
const byKw = {};
const allHits = [];
const throwFiles = [];

files.forEach((f) => {
	const text = fs.readFileSync(f, 'utf8');
	let segments;
	let missing;
	try {
		({ segments, missing } = findStatements(text));
	} catch (e) {
		throwFiles.push(f);
		return;
	}
	report.total++;
	if (!segments.length) {
		report.noStmt++;
		return;
	}
	if (segments.length === 1) {
		report.single++;
		return;
	}
	report.multi++;
	if (!missing.length) return;

	const area = areaOf(f);
	byArea[area] = byArea[area] || { files: 0, hits: 0 };
	byArea[area].files++;
	byArea[area].hits += missing.length;

	const hits = missing.map((m) => {
		const lineNo = text.slice(0, m.start).split('\n').length;
		const lineText = (text.split('\n')[lineNo - 1] || '').trim();
		const kw = text.slice(m.start, m.start + m.length).toLowerCase();
		byKw[kw] = (byKw[kw] || 0) + 1;
		return { at: m.start, line: lineNo, snippet: lineText.slice(0, 70), kw };
	});
	const rel = f.replace(/\\/g, '/');
	report.needSemi.push({ file: rel, count: missing.length, first: hits[0] });
	hits.forEach((h) => allHits.push({ file: rel, area, ...h }));
});

const needHits = report.needSemi.reduce((a, b) => a + b.count, 0);
console.log('扫描 .sql 文件: ' + report.total + (throwFiles.length ? '（解析失败跳过 ' + throwFiles.length + '）' : ''));
console.log('  单条语句文件: ' + report.single);
console.log('  多条语句文件: ' + report.multi);
console.log('  未识别到语句: ' + report.noStmt);
console.log(
	'  其中存在缺分号断点的文件: ' +
		report.needSemi.length +
		` （占多语句文件的 ${((report.needSemi.length / Math.max(1, report.multi)) * 100).toFixed(0)}%），断点共 ${needHits} 处`
);

console.log('\n按归属目录（相对扫描根，细到第二层）：');
Object.entries(byArea)
	.sort((a, b) => b[1].files - a[1].files)
	.forEach(([k, v]) => console.log(`  ${String(v.files).padStart(4)} 文件 ${String(v.hits).padStart(5)} 断点  ${k}`));

console.log('\n按断点处的语句起始关键字（取自关键字本身，不再靠行首猜）：');
Object.entries(byKw)
	.sort((a, b) => b[1] - a[1])
	.forEach(([k, v]) => console.log(`  ${String(v).padStart(4)}  ${k}`));

fs.mkdirSync(path.join(__dirname, '.tmp'), { recursive: true });
const outFile = path.join(__dirname, '.tmp', 'semicolon_hits.txt');
fs.writeFileSync(outFile, allHits.map((h) => `${h.file}:${h.line}  ${h.snippet}`).join('\n'), 'utf8');
console.log('\n全部断点已写 ' + outFile + '，样例：');
report.needSemi
	.filter((x) => !(SKIP_RE && SKIP_RE.test(x.file)))
	.slice(0, 12)
	.forEach((x) => console.log(`  ${x.file.split('/').slice(-2).join('/')}  缺${x.count}处 行${x.first.line}: ${x.first.snippet}`));
