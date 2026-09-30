// 语句切分与缺分号检测单测：node test-semi-detect.js
const fs = require('fs');
const path = require('path');
const { findStatements } = require('./formatter-core');
const { listSqlFiles } = require('./corpus');
const { resolveRoot } = require('./fixture-root');
const ROOT = resolveRoot();

const cases = [
	['单语句无分号', 'select a, b from t', 1, 0],
	['单语句有分号', 'select a, b from t;', 1, 0],
	['两句都有分号', 'select 1;\nselect 2;', 2, 0],
	['末条无分号（不该报）', 'select 1;\nselect 2', 2, 0],
	['两句缺分号', "create table t (a int) comment 'x'\ninsert into t values (1)", 2, 1],
	['insert...select 是一句', 'insert into t (a, b)\nselect a, b from u', 1, 0],
	['insert...select 带列清单换行', 'insert into t (a)\n(\nselect a from u\n)', 1, 0],
	['with...select 是一句', 'with tmp as (\nselect 1 as a\n)\nselect a from tmp', 1, 0],
	['union all select 是一句', 'select 1\nunion all\nselect 2', 1, 0],
	['update join set 是一句', 'update a join (select 1 as x) b on a.id = b.x\nset a.y = 1', 1, 0],
	['注释里的 select 不算', "select 1 -- 下游 select 使用\n;", 1, 0],
	['字符串里的分号不算', "select 'a;b' as x", 1, 0],
	['打到一半的尾逗号', 'select a, b,', 1, 0],
	['三句缺中间分号', 'select 1\nselect 2;\nselect 3', 3, 1],
];

// 粘连脚本：一份没写分号的脚本（这类脚本在 DataWorks 会被当成一条语句送上去直接语法错）。
// 形状自己造、不引用真实文件，断点数写死可回归
const concat = ['use demo_ods;']
	.concat(
		Array.from({ length: 11 }, (_, i) => "select * from demo_stats.t_" + i + " where dt = '20240905'")
	)
	.join('\n');
cases.push(['粘连脚本:12 段', concat, 12, 10]);

let fail = 0;
cases.forEach(([name, sql, wantSeg, wantMissing]) => {
	const { segments, missing } = findStatements(sql);
	const ok = segments.length === wantSeg && missing.length === wantMissing;
	if (!ok) fail++;
	console.log(
		`${ok ? '  OK  ' : ' FAIL '} ${name.padEnd(28)} 段数 ${segments.length}(期望${wantSeg}) 缺分号 ${missing.length}(期望${wantMissing})`
	);
});

// 语料不变量巡检：只输出聚合数字，不印文件名（要名字用 npm run test:semi-scan）。
// 断言的是「切分器本身不能崩、不能把非起始词当断点」这类与语料内容无关的性质，
// 所以换一个语料仓跑也成立。
// 这一段是 npm test 里唯一依赖外部语料仓的部分，没有语料仓时按 SKIP 处理（不算失败）：
// 真正「必须验证真实语料」的闸是 test:real / test:ab，那两个没语料仓会退出码 2。
const START_KW = new Set(
	('select with insert update delete create alter drop truncate grant revoke call use begin commit rollback explain show merge replace').split(
		' '
	)
);
if (!ROOT)
	console.log(
		'\n  SKIP 语料不变量巡检（未找到 SQL 脚本仓，可用 --root 指定）—— 仓内脱敏样本用例已全部跑过，本条不算失败；\n' +
			'       要跑真实语料请用 npm run test:real / test:ab（那两个没语料仓会退出码 2）'
	);
else {
	const files = listSqlFiles(ROOT);
	let crash = 0;
	let multiFiles = 0;
	let hits = 0;
	let badKw = 0;
	let badInvariant = 0;
	let archiveHits = 0;
	let inUseHits = 0;
	files.forEach((f) => {
		const text = fs.readFileSync(f, 'utf8');
		let r;
		try {
			r = findStatements(text);
		} catch (e) {
			crash++;
			return;
		}
		if (r.segments.length > 1) multiFiles++;
		if (r.missing.length && r.segments.length < 2) badInvariant++;
		r.missing.forEach((m) => {
			hits++;
			const kw = text.slice(m.start, m.start + m.length).toLowerCase();
			if (!START_KW.has(kw)) badKw++;
			if (/archive/i.test(path.relative(ROOT, f))) archiveHits++;
			else inUseHits++;
		});
	});
	const check = (name, cond, extra) => {
		if (!cond) fail++;
		console.log(`${cond ? '  OK  ' : ' FAIL '} ${name}${extra ? '  ' + extra : ''}`);
	};
	console.log('');
	check('语料巡检:切分器不抛异常', crash === 0, crash ? crash + ' 个文件抛错' : `(${files.length} 个文件)`);
	check('语料巡检:断点关键字全在起始词白名单内', badKw === 0, '异常 ' + badKw + ' 处');
	check('语料巡检:单语句文件不产生断点', badInvariant === 0, '违反 ' + badInvariant + ' 文件');
	console.log(
		`       聚合：多语句文件 ${multiFiles} 个，断点 ${hits} 处（archive 路径 ${archiveHits} / 其他 ${inUseHits}）`
	);
	if (inUseHits) console.log(`  WARN 非 archive 路径出现 ${inUseHits} 处断点，明细见 npm run test:semi-scan`);
}

console.log(fail ? `\n${fail} 个用例失败` : '\n全部用例通过');
process.exit(fail ? 1 : 0);
