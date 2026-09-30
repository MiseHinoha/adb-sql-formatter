// 排版规则改动的回归闸：拿当前工作树与某个 git 基线，对真实语料逐文件比对格式化输出
//   node ab-format.js                # 基线取 HEAD
//   node ab-format.js 407585e        # 基线取指定 commit/tag/ref
//   node ab-format.js --root "C:\path\to\sql-repo"
// 分四档：完全一致 / 仅空白差异(骨架一致) / 仅大小写差异 / 真动了代码。
// 只有「真动了代码」才置失败码 —— 排版规则改动允许改空格和函数名大小写，不允许改语义。
// 语料只读，本脚本不写任何业务仓文件。
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { listSqlFiles, skeletonOf } = require('./corpus');
const { resolveRoot, hint } = require('./fixture-root');
const newCore = require('./formatter-core');

const cfg = {
	keywordCase: 'lower',
	expressionWidth: 100,
	logicalOperatorNewline: 'before',
	linesBetweenQueries: 1,
};

// 位置参数是基线 ref；但 --root 的值不是（否则 `--root D:\sql` 会把路径当成 ref 去做 git show）
const argv = process.argv.slice(2);
const refArgs = [];
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === '--root') {
		i++;
		continue;
	}
	if (argv[i].startsWith('-')) continue;
	refArgs.push(argv[i]);
}
const REF = refArgs[0] || 'HEAD';

function git(args) {
	return execFileSync('git', args, { cwd: __dirname, encoding: 'utf8', maxBuffer: 32 << 20 });
}

let baseSource;
try {
	baseSource = git(['show', REF + ':formatter-core.js']);
} catch (e) {
	console.log('取不到基线版本 ' + REF + ':formatter-core.js —— ' + String(e.message).split('\n')[0]);
	console.log('（确认已在 git 仓内、ref 存在，且该 ref 里有 formatter-core.js）');
	process.exit(2);
}
const oneLine = git(['rev-parse', '--short', REF]).trim();
const subject = git(['log', '-1', '--format=%s', REF]).trim();

const tmpDir = path.join(__dirname, '.tmp');
fs.mkdirSync(tmpDir, { recursive: true });
const basePath = path.join(tmpDir, 'formatter-core-' + oneLine + '.js');
fs.writeFileSync(basePath, baseSource, 'utf8');
let baseCore;
try {
	baseCore = require(basePath);
	if (typeof baseCore.formatSql !== 'function') throw new Error('该版本没有导出 formatSql');
} catch (e) {
	console.log('基线核心加载失败：' + e.message);
	process.exit(2);
}

const ROOT = resolveRoot();
if (!ROOT) {
	console.log(hint().replace(/\s+/g, ' '));
	console.log('判定：未验证 —— 没找到语料仓，没有可比对的内容（退出码 2）');
	process.exit(2);
}
const files = listSqlFiles(ROOT);
if (!files.length) {
	console.log('语料 ' + ROOT + ' 里没有 .sql 文件：没有可比对的内容（退出码 2）');
	process.exit(2);
}

const run = (core, text) => {
	try {
		return { ok: true, out: core.formatSql(text, cfg, 4) };
	} catch (e) {
		return { ok: false, out: '', err: String(e.message).split('\n')[0] };
	}
};

const stat = { same: 0, wsOnly: 0, caseOnly: 0, real: [], flip: [], bothThrow: 0 };
const samples = [];
files.forEach((f) => {
	const raw = fs.readFileSync(f, 'utf8');
	const a = run(baseCore, raw);
	const b = run(newCore, raw);
	if (!a.ok && !b.ok) {
		stat.bothThrow++;
		return;
	}
	if (a.ok !== b.ok) {
		stat.flip.push([f, '基线=' + (a.ok ? 'ok' : a.err.slice(0, 50)) + ' 当前=' + (b.ok ? 'ok' : b.err.slice(0, 50))]);
		return;
	}
	if (a.out === b.out) {
		stat.same++;
		return;
	}
	const skA = skeletonOf(a.out);
	const skB = skeletonOf(b.out);
	if (skA === skB) {
		stat.wsOnly++;
		if (samples.length < 5) samples.push([f, a.out, b.out]);
	} else if (skA.toLowerCase() === skB.toLowerCase()) {
		stat.caseOnly++;
		if (samples.length < 5) samples.push([f, a.out, b.out]);
	} else {
		stat.real.push([f, '骨架（去注释去空白、区分大小写）变了']);
	}
});

console.log('基线 ' + oneLine + ' ' + subject);
console.log('当前 工作树 formatter-core.js');
console.log('语料 ' + ROOT + ' 共 ' + files.length + ' 个 .sql\n');
console.log('  输出完全一致            ' + stat.same);
console.log('  仅空白差异(骨架一致)     ' + stat.wsOnly);
console.log('  仅大小写差异(骨架忽略大小写一致) ' + stat.caseOnly);
console.log('  两侧都解析失败(未变)      ' + stat.bothThrow);
console.log('  一侧解析失败            ' + stat.flip.length);
console.log('  真动了代码              ' + stat.real.length);
stat.flip.slice(0, 8).forEach(([f, m]) => console.log('   ! 一侧失败 ' + path.basename(f) + '  ' + m));
stat.real.slice(0, 8).forEach(([f, m]) => console.log('   ! 代码变化 ' + f.replace(/\\/g, '/').slice(ROOT.length + 1) + '  ' + m));

if (samples.length) {
	console.log('\n差异样例（最多 5 个文件，各取前 3 处不同行）：');
	samples.forEach(([f, oa, ob]) => {
		const la = oa.split('\n');
		const lb = ob.split('\n');
		console.log('  ' + f.replace(/\\/g, '/').slice(ROOT.length + 1));
		for (let i = 0, n = Math.max(la.length, lb.length), shown = 0; i < n && shown < 3; i++) {
			if (la[i] !== lb[i]) {
				console.log('    基线: ' + JSON.stringify((la[i] || '').trim()));
				console.log('    当前: ' + JSON.stringify((lb[i] || '').trim()));
				shown++;
			}
		}
	});
}

const bad = stat.real.length + stat.flip.length;
console.log(
	bad
		? '\n判定：改动触碰了 ' + bad + ' 个文件的代码语义或可解析性，别急着发版'
		: '\n判定：通过 —— 差异全部落在空白与大小写，代码语义未变'
);
process.exit(bad ? 1 : 0);
