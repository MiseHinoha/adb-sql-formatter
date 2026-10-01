// 仓内自测：不依赖外部 SQL 脚本仓，用 test/fixtures 下的脱敏样本
// 校验四件事：代码骨架不变、二次格式化幂等、建表结构符合约定、缺分号检测段数正确
// 运行：node test-selfcheck.js
const fs = require('fs');
const path = require('path');
const { formatSql, findStatements, EXTRA_FUNCTION_NAMES: EXTRA_FN } = require('./formatter-core');

const cfg = {
	keywordCase: 'lower',
	expressionWidth: 100,
	logicalOperatorNewline: 'before',
	linesBetweenQueries: 1,
};

// 剥离注释与空白后的代码骨架，用于验证重排没有改动实质内容
function skeleton(text) {
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

// 按空行分段（fixture 里语句之间留空行）；丢掉纯注释段，末尾分号可有可无
function splitStatements(text) {
	return text
		.split(/\n\s*\n/)
		.map((b) => b.trim())
		.filter(Boolean)
		.filter((b) =>
			b
				.split('\n')
				.some((l) => /^\s*(create|insert|update|delete|select|with|alter|drop)\b/i.test(l))
		);
}

let fail = 0;
const check = (name, cond, extra = '') => {
	if (!cond) fail++;
	console.log(`${cond ? '  OK  ' : ' FAIL '} ${name}${extra ? '  ' + extra : ''}`);
};

const fixtureDir = path.join(__dirname, 'test', 'fixtures');
const files = fs.readdirSync(fixtureDir).filter((f) => /\.sql$/i.test(f));
console.log(`自测样本：${files.join(', ')}\n`);

files.forEach((f) => {
	const text = fs.readFileSync(path.join(fixtureDir, f), 'utf8');
	splitStatements(text).forEach((stmt, i) => {
		const tag = `${f} #${i + 1}`;
		let once;
		try {
			once = formatSql(stmt, cfg, 4);
		} catch (e) {
			check(`${tag} 格式化不抛错`, false, e.message.slice(0, 60));
			return;
		}
		check(`${tag} 代码骨架不变`, skeleton(once) === skeleton(stmt));
		check(`${tag} 二次格式化幂等`, formatSql(once, cfg, 4) === once);
		check(`${tag} 不新增分号`, (once.match(/;/g) || []).length <= (stmt.match(/;/g) || []).length);

		// 建表结构约定：distribute by / partition by / primary key / 表 comment 各自成行
		if (/^create\s+table/i.test(stmt)) {
			const lines = once.split('\n');
			const atLineStart = (re) => lines.some((l) => re.test(l.trim()));
			// 按原语句里真实存在的表选项断言（广播表没有 partition by，不该要求）
			if (/\bdistributed?\s+by\b/i.test(stmt)) {
				check(`${tag} 分布键独立成行`, atLineStart(/^(distribute|distributed)\s+by\b/));
			}
			if (/\bpartition\s+by\b/i.test(stmt)) {
				check(`${tag} 分区子句独立成行`, atLineStart(/^partition\s+by\b/));
			}
			check(`${tag} primary key 独立成行`, lines.some((l) => /^,?\s*primary key\s*\(/i.test(l.trim())));
			check(
				`${tag} 表 comment 独立成行`,
				lines.some((l) => /^comment\b/i.test(l.trim()) && !/^(distribute|distributed|partition)\b/i.test(l.trim()))
			);
			check(`${tag} 关键字已小写`, !/(^|\s)(SELECT|FROM|WHERE|DISTRIBUTE|PRIMARY KEY)(\s|$)/.test(once));
			// 关键字纵向对齐：含 comment 的列定义行，comment 必须落在同一列
			const comCols = lines
				.filter((l) => /^\s*,?\s*\w+\s+\w+/.test(l) && /\bcomment\s/i.test(l))
				.map((l) => l.indexOf('comment'));
			check(
				`${tag} 列定义 comment 对齐`,
				comCols.length < 2 || new Set(comCols).size === 1,
				comCols.join(',')
			);
		}
	});
});

// ADB 专有函数紧贴：补进方言函数表后由排版器自己贴住括号，且不得误伤表名/关键字位置的括号
const UPPER = Object.assign({}, cfg, { keywordCase: 'upper' });
const oneLine = (s) => formatSql(s, cfg, 4).replace(/\n\t?/g, ' ').replace(/\s+/g, ' ').trim();
console.log('');
EXTRA_FN.forEach((fn) => {
	const src = 'select ' + fn + ' (a, b) from t';
	const out = oneLine(src);
	check(`ADB 函数紧贴 ${fn}(a, b)`, out.includes(fn.toLowerCase() + '(a, b)'), JSON.stringify(out));
	check(`${fn} 二次格式化幂等`, formatSql(out, cfg, 4) === formatSql(formatSql(src, cfg, 4), cfg, 4));
});
[
	['表名位置不剥空格 insert into t (a, b)', 'insert into demo_stats.t (a, b) values (1, 2)', /t \(a, b\)/],
	['窗口子句不剥空格 over (', 'select row_number() over (partition by a order by b) as rn from t', /over \(/],
	['未知函数保持排版器原样 some_udf (', 'select some_udf (a) from t', /some_udf \(/],
	['注释内不动', "select a from t -- nvl (b, 0)\n", /-- nvl \(b, 0\)/],
	['字符串内不动', "select 'nvl (x)' as s from t", /'nvl \(x\)'/],
].forEach(([name, src, re]) => check(name, re.test(oneLine(src) + '\n'), JSON.stringify(oneLine(src))));
check(
	'keywordCase=upper 时函数名跟随大写',
	/NVL\(a, 0\)/.test(formatSql('select nvl(a, 0) from t', UPPER, 4)),
	'进了函数表就等于吃 keywordCase，与 SUM/COUNT 同口径'
);

// 1.5.0 排版回归：逗号行缩进（任意 tabWidth）/ 窗口子句不换行 / 建表关键字纵向对齐
console.log('');
[2, 3, 4, 8].forEach((w) => {
	const out = formatSql('select a, b, c from t', cfg, w);
	check(
		`tabWidth=${w}：逗号行与首个字段同级缩进`,
		/^select\n	a\n	, b\n	, c\n	from t$/m.test(out),
		JSON.stringify(out)
	);
});

const windowShort = formatSql(
	'select row_number() over (partition by user_id order by dt desc) as rn, count(1) over() as c from t',
	cfg,
	4
);
check(
	'窗口子句保持一行 over (partition by … order by …)',
	/row_number\(\) over \(partition by user_id order by dt desc\) as rn/.test(windowShort),
	JSON.stringify(windowShort)
);
const windowLongSql =
	'select row_number() over (partition by user_id, shop_id, city_code, province_code order by dt desc, amount desc, order_id asc, uid desc) as rn from t';
const windowLong = formatSql(windowLongSql, cfg, 4);
check(
	'窗口子句超过 expressionWidth 时仍换行',
	/\n		partition by user_id\n/.test(windowLong),
	JSON.stringify(windowLong)
);
check('窗口子句合并不改变代码骨架', skeleton(windowLong) === skeleton(formatSql(windowLong, cfg, 4)));

const ddlSrc = `create table demo_align (order_id bigint not null comment '订单id', uid bigint not null comment '下单用户', amount decimal(18, 4) not null comment '付费金额', primary key (order_id)) distribute by hash(uid) partition by value(order_id) comment = 'DWD-订单';`;
const alignOut = formatSql(ddlSrc, cfg, 4);
const alignLines = alignOut.split('\n');
const at = (i, word) => alignLines[i].indexOf(word);
check(
	'列名纵向对齐（首行补 2 空格抵消前置逗号）',
	at(2, 'order_id') === at(3, 'uid') && at(3, 'uid') === at(4, 'amount'),
	[at(2, 'order_id'), at(3, 'uid'), at(4, 'amount')].join(',')
);
check(
	'类型纵向对齐',
	at(2, 'bigint') === at(3, 'bigint') && at(3, 'bigint') === at(4, 'decimal(18, 4)'),
	[at(2, 'bigint'), at(3, 'bigint'), at(4, 'decimal(18, 4)')].join(',')
);
check(
	'comment 关键字纵向对齐',
	at(2, 'comment') === at(3, 'comment') && at(3, 'comment') === at(4, 'comment'),
	[at(2, 'comment'), at(3, 'comment'), at(4, 'comment')].join(',')
);
check(
	'表选项 by / = 纵向对齐',
	/^distribute by /m.test(alignOut) && /^partition  by /m.test(alignOut) && /^comment    = /m.test(alignOut),
	JSON.stringify(alignLines.slice(7).join(' | '))
);
check('建表对齐幂等', formatSql(alignOut, cfg, 4) === alignOut);
check('建表对齐不改变代码骨架', skeleton(alignOut) === skeleton(ddlSrc));

// 缺分号检测：fixture 里最后一条没有分号，属「末条不报」，前面几条都带分号
const ddlText = fs.readFileSync(path.join(fixtureDir, 'ddl.sql'), 'utf8');
const { segments, missing } = findStatements(ddlText);
check(`缺分号检测：段数 ${segments.length} >= 4`, segments.length >= 4);
check('缺分号检测：无中间断点误报', missing.length === 0, `missing=${missing.length}`);

// 文案一致性：漏了翻译，用户在设置界面会看到 %adbSqlFormatter.xxx% 这种坏值，所以必须当场拦
const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');
const nlsKeys = [...read('package.json').matchAll(/%([A-Za-z][\w.]*)%/g)].map((m) => m[1]);
const nlsEn = JSON.parse(read('package.nls.json'));
const nlsZh = JSON.parse(read('package.nls.zh-cn.json'));
console.log('');
check('nls：manifest 引用的每个 %key% 都有英文与中文文案', nlsKeys.length > 0 && nlsKeys.every((k) => k in nlsEn && k in nlsZh), nlsKeys.length + ' 个 key');
check(
	'nls：中英文案键集合一致',
	JSON.stringify(Object.keys(nlsEn).sort()) === JSON.stringify(Object.keys(nlsZh).sort())
);
check(
	'nls：没有未被 manifest 引用的多余 key',
	Object.keys(nlsEn).every((k) => nlsKeys.includes(k)),
	Object.keys(nlsEn)
		.filter((k) => !nlsKeys.includes(k))
		.join(',')
);
const srcKeys = [...read('extension.js').matchAll(/\bt\(\s*'([^']+)'/g)].map((m) => m[1]);
const bundleTpl = JSON.parse(read('l10n/bundle.l10n.json'));
const bundleZh = JSON.parse(read('l10n/bundle.l10n.zh-cn.json'));
check(
	'l10n：代码里每个英文源文都有中文译文',
	srcKeys.length > 0 && srcKeys.every((k) => k in bundleZh && bundleZh[k] !== k),
	srcKeys.length + ' 条'
);
check(
	'l10n：模板与中文包键集合一致',
	JSON.stringify(Object.keys(bundleTpl).sort()) === JSON.stringify(Object.keys(bundleZh).sort())
);

console.log(fail ? `\n${fail} 项失败` : '\n自测全部通过');
process.exit(fail ? 1 : 0);
