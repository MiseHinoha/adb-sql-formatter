// 回归样本的扫描根解析：新仓不依赖工作 SQL 仓也能跑，全量校准时显式指定
//   node check-ddl.js --root "<SQL 脚本仓根目录>"
//   或 set ADB_SQL_FIXTURE_ROOT=<SQL 脚本仓根目录>
// 探测不到语料仓 = 真实语料一条都没验证，调用方必须按「未验证」处理（退出码 2），
// 不能算通过：这里以前只认目录名，撞上无关目录就会 0 条静默通过。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SKIP_DIRS } = require('./corpus');

// 语料仓判定：含 .sql 是硬条件 —— 只认目录名的话，任何碰巧含同名子目录的目录
// （blob 存储、导出目录）都会被认成语料仓，结果 0 条也算「通过」，真实校准静默空转。
// 「像不像脚本仓」不猜，由使用者声明，默认不自动认任何目录：
//   ADB_SQL_FIXTURE_MARKERS="sql,etl"   （逗号分隔，命中任一子目录名即算）
// 别拿 .git 当特征：本工具仓自己就是 git 仓、又自带 test/fixtures/*.sql，
// 那样连自己都会被认成语料仓（实测：check-ddl 把自家 fixture 当语料报了「共 4 条」）。
function looksLikeSqlRepo(dir) {
	try {
		if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false;
		if (!isRepoShaped(dir)) return false;
		return hasSqlFile(dir, MAX_PROBE_ENTRIES);
	} catch (e) {
		return false;
	}
}

function markers() {
	return (process.env.ADB_SQL_FIXTURE_MARKERS || '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}

function isRepoShaped(dir) {
	return markers().some((m) => fs.existsSync(path.join(dir, m)));
}

// 有界扫描：只回答「有没有 .sql」，扫到第一个就返回，最多看 limit 个目录项，
// 避免探测大目录时把启动拖慢
const MAX_PROBE_ENTRIES = 4000;

function hasSqlFile(dir, limit) {
	const stack = [dir];
	let seen = 0;
	while (stack.length) {
		const cur = stack.pop();
		let entries;
		try {
			entries = fs.readdirSync(cur, { withFileTypes: true });
		} catch (e) {
			continue;
		}
		for (const e of entries) {
			if (SKIP_DIRS.includes(e.name)) continue;
			if (++seen > limit) return false;
			if (e.isDirectory()) stack.push(path.join(cur, e.name));
			else if (/\.sql$/i.test(e.name)) return true;
		}
	}
	return false;
}

function fromArgv(argv) {
	const i = argv.indexOf('--root');
	if (i >= 0 && argv[i + 1]) return path.resolve(argv[i + 1]);
	const inline = argv.find((a) => a.startsWith('--root='));
	return inline ? path.resolve(inline.slice('--root='.length)) : null;
}

// 返回解析出的根目录；找不到返回 null（调用方按「跳过全量校准」处理，不算失败）
function resolveRoot() {
	const cli = fromArgv(process.argv);
	if (cli && looksLikeSqlRepo(cli)) return cli;
	if (cli) return null;

	const env = process.env.ADB_SQL_FIXTURE_ROOT;
	if (env && looksLikeSqlRepo(env)) return path.resolve(env);

	if (looksLikeSqlRepo(process.cwd())) return process.cwd();

	// 从当前目录往上找，兼容「工具仓与 SQL 仓同级」或「SQL 仓再深一层」的布局。
	// 上界压在用户主目录以内：再往上会扫到 / 的直接子目录（/tmp、/opt、/private…），
	// 既慢又会把无关的临时目录认成语料仓（实测：从 ~/Projects/x 一路升到 /，把 /tmp 下的仓吞了）。
	let dir = process.cwd();
	for (let up = 0; up < 4; up++) {
		const parent = path.dirname(dir);
		if (!parent || parent === dir) break;
		if (!withinHome(parent)) break;
		for (const name of safeReadDir(parent)) {
			const cand = path.join(parent, name);
			if (looksLikeSqlRepo(cand)) return cand;
			for (const inner of safeReadDir(cand)) {
				const cand2 = path.join(cand, inner);
				if (looksLikeSqlRepo(cand2)) return cand2;
			}
		}
		dir = parent;
	}
	return null;
}

function safeReadDir(dir) {
	try {
		return fs.readdirSync(dir).filter((n) => !['.git', '$RECYCLE.BIN', 'System Volume Information'].includes(n));
	} catch (e) {
		return [];
	}
}

// 目录是否落在用户主目录内（含主目录自身）。探测不做全盘漫游。
function withinHome(p) {
	const rel = path.relative(os.homedir(), p);
	return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function hint() {
	return (
		'未找到 SQL 脚本仓（目录下有 .sql，且命中 ADB_SQL_FIXTURE_MARKERS 声明的子目录名）。\n' +
		'  显式指定：--root "<SQL 脚本仓根目录>"  或  set ADB_SQL_FIXTURE_ROOT=<SQL 脚本仓根目录>\n' +
		'  自定义特征：set ADB_SQL_FIXTURE_MARKERS=sql,etl\n' +
		'  只跑仓内自测（脱敏样本，不需要语料仓）：node test-selfcheck.js\n' +
		'  没有语料仓时，本脚本按「未验证」退出（码 2），不会当成通过。'
	);
}

module.exports = { resolveRoot, looksLikeSqlRepo, hint };
