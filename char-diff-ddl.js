// 代码骨架（剥离注释/空白）字符级定位：node char-diff-ddl.js 1 5 6 21 36
// 扫描根与 check-ddl.js 同一个 resolveRoot()，序号可直接照抄它报出来的编号
const { collectFromFixtureRoot } = require('./extract-ddl');
const { formatSql } = require('./formatter-core');

const cfg = {
	keywordCase: 'lower',
	expressionWidth: 100,
	logicalOperatorNewline: 'before',
	linesBetweenQueries: 1,
};

function skeletonOf(text) {
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
	return out.toLowerCase();
}

const fixtures = collectFromFixtureRoot();
if (!fixtures) process.exit(0);

process.argv.slice(2).map(Number).forEach((idx) => {
	const f = fixtures[idx];
	if (!f) return console.log('无此序号', idx);
	const a = skeletonOf(f.stmt);
	const b = skeletonOf(formatSql(f.stmt, cfg, 4));
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	console.log(`\n##### #${idx} ${f.file.split('/').slice(-1)[0]} 骨架长度 ${a.length} → ${b.length}`);
	console.log('  原:', JSON.stringify(a.slice(Math.max(0, i - 60), i + 100)));
	console.log('  新:', JSON.stringify(b.slice(Math.max(0, i - 60), i + 100)));
});
