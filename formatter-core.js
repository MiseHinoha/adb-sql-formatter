// 纯函数格式化核心：不依赖 vscode，extension.js 与 test.js 共用
const { formatDialect, mysql } = require('sql-formatter');

// ---------------------------------------------------------------------------
// 方言定制（基于 mysql）
// 原理：sql-formatter v13 中 reservedJoins 类关键字 =「关键字前置换行、内容跟同一行」，
// 正好是 DataGrip 的 from 表 / where 条件 风格；reservedClauses 则前后都换行。
// ---------------------------------------------------------------------------
const JOIN_STYLE_CLAUSES = [
	'FROM', 'WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT', 'OFFSET',
	'PARTITION BY', 'WINDOW', 'VALUES', 'ON DUPLICATE KEY UPDATE', 'SET',
	'INSERT', 'REPLACE', 'UPDATE', 'DELETE FROM', 'CREATE TABLE',
];
// ADB/DataWorks 常见短语，mysql 方言不认识会导致断行，作为整体短语补进去
const EXTRA_PHRASES = [
	'INSERT OVERWRITE', 'INSERT OVERWRITE TABLE', 'INSERT INTO TABLE',
];
// ADB/DataWorks 常见函数：mysql 方言的函数表里没有，sql-formatter 会把「不在表里的标识符 + 左括号」
// 排成 `nvl (a, 0)`（函数名与括号之间多一个空格）。补进函数表由排版器自己紧贴，
// 比在输出层做文本猜测安全 —— 后者会连 `insert into t (a, b)`、`over (partition by ...)` 一起吃掉。
// 名单按真实语料频率来（nvl 516 次居首），新增函数名往这里加即可。
// 注意：进了函数表就等于吃 keywordCase，设成 upper 时这些名字会跟着变大写（与 sum/if 同待遇）。
const EXTRA_FUNCTION_NAMES = [
	'NVL', 'DATE_TRUNC', 'MONTHS_BETWEEN', 'ARRAY_AGG', 'TO_TIMESTAMP',
	'TO_DATE', 'TO_UNIXTIME', 'DATE_DIFF', 'REGEXP_EXTRACT', 'CARDINALITY',
];
// DataWorks 调度占位符 ${bizdate} / ${yesterday} 等，按自定义参数识别避免被拆坏。
// 注意：整段 ${...} 现在先被下面的 protectParams 遮住再排版，这条正则只是兜底（遮不住的形态仍按参数处理）。
const PARAM_REGEX = String.raw`\$\{[a-zA-Z0-9_.]+\}`;

// 交接/调度用的参数占位符：${bizdate}，以及带格式说明的中文占位符 ${年月：格式yyyymm。如：202611}。
// 不支持反引号套表名的库上，占位符直接贴在表名尾部：order_gift_send_record_${年月...}。
// mysql 方言把 $ 当标识符字符（identChars.first/rest 都含 $）⇒ 排版器从标识符开头一路吞到 $，
// 下一个 { 没有任何规则能匹配，于是抛「Parse error: Unexpected "{"」；加宽 PARAM_REGEX 救不了 ——
// 扫描位置已在标识符内部，参数规则根本没机会触发（实测报错列正好落在 { 上）。
// 做法：排版前把整段 ${...} 换成等长的占位标记（只含标识符字符，与相邻标识符连成一个 token），
// 排完再按标记换回原文：占位符既不参与断词，也不会被插入空格。
const PARAM_MARK = '__adbparam';
const PARAM_MAX_LEN = 200;

function protectParams(text) {
	const marks = [];
	if (text.indexOf('${') < 0) return { text, marks };
	// 标记前缀必须保证原文里没有，否则还原时会误伤用户自己写的内容
	const head = text.indexOf(PARAM_MARK) < 0 ? PARAM_MARK : PARAM_MARK + 'zz';
	let out = '';
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '$' && text[i + 1] === '{') {
			let j = i + 2;
			let closed = false;
			for (; j < text.length && j - i <= PARAM_MAX_LEN + 2; j++) {
				const ch = text[j];
				if (ch === '}') {
					closed = j > i + 2;
					break;
				}
				// 不跨行、不跨语句、不吞引号：隔着这些字符的 ${ 更像坏 SQL，交给报错而不是硬修
				if (ch === '\n' || ch === '\r' || ch === ';' || ch === "'" || ch === '"' || ch === '`') break;
			}
			if (closed) {
				const raw = text.slice(i, j + 1);
				const tail = '_' + marks.length + 'q__';
				const pad = Math.max(0, raw.length - head.length - tail.length);
				const mark = head + 'x'.repeat(pad) + tail;
				marks.push({ mark, raw });
				out += mark;
				i = j;
				continue;
			}
		}
		out += text[i];
	}
	return { text: out, marks };
}

function restoreParams(text, marks) {
	for (const m of marks) text = text.split(m.mark).join(m.raw);
	return text;
}

function buildDialect() {
	const clauses = mysql.tokenizerOptions.reservedClauses.filter(
		(c) => !JOIN_STYLE_CLAUSES.some((p) => c === p || c.startsWith(p + ' '))
	);
	return {
		tokenizerOptions: {
			...mysql.tokenizerOptions,
			reservedClauses: clauses,
			reservedFunctionNames: [
				...(mysql.tokenizerOptions.reservedFunctionNames || []),
				...EXTRA_FUNCTION_NAMES,
			],
			reservedJoins: [
				...(mysql.tokenizerOptions.reservedJoins || []),
				...JOIN_STYLE_CLAUSES,
				...EXTRA_PHRASES,
			],
		},
		formatOptions: mysql.formatOptions,
	};
}

// 空格缩进转 tab。sql-formatter 要求 commaPosition=before 必须用空格，故先按 tabWidth 空格排版再转换。
// 逗号行比同级内容行少缩进 2 列（commaPosition=before 的固定行为，实测 tabWidth=2/3/4/8 均成立）：
// 折算时补回这 2 列，否则 tabWidth≠4 时（VS Code 的 detectIndentation 常给到 2）逗号行会落到 0 缩进，
// 表现为「select 之后只有第一个字段有缩进，后面的字段没缩进」。
// tabWidth=2 时逗号行本身就是 0 缩进（连空白都没有），故按行处理，不能只匹配已有缩进的行。
function toTabs(text, tabWidth) {
	return text
		.split('\n')
		.map((line) => {
			const m = line.match(/^[ 	]*/)[0];
			const rest = line.slice(m.length);
			if (!m && !rest.startsWith(',')) return line;
			const width = [...m].reduce((n, ch) => n + (ch === '	' ? tabWidth : 1), 0);
			// 内容行向下取整（宁可少缩进也不多缩进），逗号行按补齐后的列数取最接近的整数级
			const level = rest.startsWith(',') ? (width + 2) / tabWidth : width / tabWidth;
			return '	'.repeat(Math.max(0, Math.round(level))) + rest;
		})
		.join('\n');
}

// 短列表行内合并：group by / order by 后面按逗号前置换行的列表，
// 若整段拼回一行不超过 limit，则合并成行内短列表（如 group by 1, 2）。
// values 等长列表拼不进一行时保持逐行逗号前置不动。
function joinShortLists(text, limit) {
	const lines = text.split('\n');
	const out = [];
	const HEADS = ['group by ', 'order by '];
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i];
		const t = raw.trim();
		const head = HEADS.find((h) => t.startsWith(h));
		if (!head) {
			out.push(raw);
			continue;
		}
		const parts = [t];
		let j = i + 1;
		while (j < lines.length && /^\s*,/.test(lines[j])) {
			parts.push(lines[j].trim());
			j++;
		}
		if (parts.length > 1) {
			const merged = parts.reduce(
				(acc, p) => acc + (p.startsWith(',') ? p : ' ' + p)
			);
			if (merged.length <= limit) {
				out.push(raw.slice(0, raw.length - t.length) + merged);
				i = j - 1;
				continue;
			}
		}
		out.push(raw);
	}
	return out.join('\n');
}

// 窗口子句不换行：`row_number() over (` 之后被 sql-formatter 拆成多行的 partition by / order by
// 合回一行 —— 窗口里一般不会写很长，只有整行超过 expressionWidth 时才保持拆开的多行形态。
// 引号外的空白压成单空格（引号内原样），并在 , 与 ) 前不留空格。
function flattenSpec(text) {
	let out = '';
	let quote = null;
	let pending = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quote) {
			out += c;
			if (c === quote && text[i - 1] !== '\\') quote = null;
			continue;
		}
		if (c === "'" || c === '"' || c === '`') {
			quote = c;
			pending = false;
			out += c;
			continue;
		}
		if (/\s/.test(c)) {
			pending = true;
			continue;
		}
		if (c === ',' || c === ')') {
			out = out.replace(/[ 	]+$/, '');
			pending = false;
			out += c;
			continue;
		}
		if (pending && out && !out.endsWith('(')) out += ' ';
		pending = false;
		out += c;
	}
	return out;
}

function inlineWindowSpecs(text, limit) {
	const lines = text.split('\n');
	const out = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		// 只处理「整行以 over ( 收尾」的形态：已经在一行里的窗口子句不用动
		if (!/\bover\s*\(\s*$/i.test(line)) {
			out.push(line);
			continue;
		}
		const openIdx = line.lastIndexOf('(');
		let depth = 0;
		let closeIdx = -1;
		let blocked = false;
		let j = i;
		// 找到配对的右括号所在行；break 只跳内层，必须用 found 结束外层
		while (j < lines.length && !blocked && closeIdx < 0) {
			const seg = j === i ? line.slice(openIdx) : lines[j];
			for (let k = 0; k < seg.length; k++) {
				const c = seg[k];
				if (c === "'" || c === '"' || c === '`') {
					const q = c;
					k++;
					while (k < seg.length && seg[k] !== q) k++;
					continue;
				}
				// 带注释的窗口子句没法安全合并成一行，原样保留
				if ((c === '-' && seg[k + 1] === '-') || (c === '/' && seg[k + 1] === '*')) {
					blocked = true;
					break;
				}
				if (c === '(') depth++;
				else if (c === ')' && --depth === 0) {
					closeIdx = k;
					break;
				}
			}
			j++;
		}
		if (blocked || closeIdx < 0) {
			out.push(line);
			continue;
		}
		const last = j - 1;
		const parts = [line.slice(openIdx)];
		for (let k = i + 1; k < last; k++) parts.push(lines[k]);
		parts.push(lines[last].slice(0, closeIdx + 1));
		const single = (
			line.slice(0, openIdx) + flattenSpec(parts.join(' ')) + lines[last].slice(closeIdx + 1)
		).replace(/[ 	]+$/, '');
		if (single.trim().length > limit) {
			out.push(line);
			continue;
		}
		out.push(single);
		i = last;
	}
	return out.join('\n');
}

// 建表关键字纵向对齐（纯空白补齐，不动任何内容）
//   列定义：名称 / 类型 / 约束关键字各占一列 —— 关键字按「槽位」定位（not null、default x、
//   comment '…'、auto_increment…），某行没写某个关键字就留空位，这样 comment 永远在同一列。
//   表选项：distribute by / partition by / comment = 的首词补齐，让 by 与 = 对齐
// 解析不出固定形态的行（表级约束、注释、跨行定义）原样保留，不猜测。
// ---------------------------------------------------------------------------
const COL_KEYWORD_HEADS = [
	['not', 'null'], ['not'], ['null'], ['default'], ['comment'], ['auto_increment'],
	['on', 'update'], ['character', 'set'], ['collate'], ['references'], ['generated'],
	['primary', 'key'], ['unique'], ['key'], ['check'],
];
// 槽位顺序：决定关键字列的先后；'null' 与 'not null' 共用一列
const COL_SLOT_ORDER = [
	'not', 'default', 'auto_increment', 'on', 'collate', 'character',
	'references', 'generated', 'comment', 'primary', 'unique', 'key', 'check',
];
const COL_SLOT_OF = { null: 'not' };
const TABLE_CONSTRAINT_RE = /^(primary\s+key|unique|key|index|constraint|foreign\s+key|fulltext)\b/i;

// 引号与括号内的空白不切分：decimal(18, 4) 视为一个类型 token，'订单 id' 视为一个值 token
function splitTokens(text) {
	const tokens = [];
	let cur = '';
	let quote = null;
	let depth = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quote) {
			cur += c;
			if (c === quote && text[i - 1] !== '\\') quote = null;
			continue;
		}
		if (c === "'" || c === '"' || c === '`') {
			quote = c;
			cur += c;
			continue;
		}
		if (c === '(') depth++;
		else if (c === ')') depth = Math.max(0, depth - 1);
		else if (depth === 0 && /\s/.test(c)) {
			if (cur) tokens.push(cur);
			cur = '';
			continue;
		}
		cur += c;
	}
	if (cur) tokens.push(cur);
	return tokens;
}

function headLenAt(tokens, i) {
	let best = 0;
	COL_KEYWORD_HEADS.forEach((head) => {
		if (head.length <= best) return;
		if (head.every((w, k) => String(tokens[i + k] || '').toLowerCase() === w)) best = head.length;
	});
	return best;
}

// 拆成 { name, type, slots }；形态不认识返回 null（该行不参与对齐，也不会因此改动）
function columnCells(text) {
	const t = text.trim();
	if (/^(-{2}|\/\*)/.test(t) || TABLE_CONSTRAINT_RE.test(t)) return null;
	const tokens = splitTokens(t);
	// 名称 + 类型两段就够参与对齐（没有约束关键字的列照样要跟同表其它列对齐）
	if (tokens.length < 2) return null;
	const slots = {};
	let i = 2;
	while (i < tokens.length) {
		const head = headLenAt(tokens, i);
		if (!head) return null;
		let j = i + head;
		while (j < tokens.length && !headLenAt(tokens, j)) j++;
		const raw = tokens[i].toLowerCase();
		const slot = COL_SLOT_OF[raw] || raw;
		// 同一关键字出现两次（形态超出预期）就不对齐，避免猜错位置
		if (slots[slot] !== undefined || !COL_SLOT_ORDER.includes(slot)) return null;
		slots[slot] = tokens.slice(i, j).join(' ');
		i = j;
	}
	return { name: tokens[0], type: tokens[1], slots };
}

// 中日韩字符按 2 列宽计算，否则中文列名/注释会对不齐
function dispWidth(text) {
	let w = 0;
	for (const ch of text) {
		const c = ch.codePointAt(0);
		const wide =
			(c >= 0x1100 && c <= 0x115f) ||
			(c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f) ||
			(c >= 0xac00 && c <= 0xd7a3) ||
			(c >= 0xf900 && c <= 0xfaff) ||
			(c >= 0xfe30 && c <= 0xfe6f) ||
			(c >= 0xff00 && c <= 0xff60) ||
			(c >= 0xffe0 && c <= 0xffe6);
		w += wide ? 2 : 1;
	}
	return w;
}

function alignColumnKeywords(cols) {
	const parsed = cols.map((c) => columnCells(c.text));
	if (parsed.filter(Boolean).length < 2) return null;
	const at = (slot) => COL_SLOT_ORDER.indexOf(slot) + 2;
	const widths = [0, 0]; // 0=名称 1=类型
	parsed.forEach((p) => {
		if (!p) return;
		widths[0] = Math.max(widths[0], dispWidth(p.name));
		widths[1] = Math.max(widths[1], dispWidth(p.type));
		Object.entries(p.slots).forEach(([slot, text]) => {
			const idx = at(slot);
			widths[idx] = Math.max(widths[idx] || 0, dispWidth(text));
		});
	});
	// 表里实际用到的关键字列（顺序即槽位顺序），后续按整列补位
	const slotsUsed = COL_SLOT_ORDER.filter((slot) => widths[at(slot)] !== undefined).map((slot) => ({
		slot,
		width: widths[at(slot)] || 0,
	}));
	return cols.map((c, idx) => {
		const p = parsed[idx];
		if (!p) return c.text;
		const row = [p.name, p.type, ...slotsUsed.map((s) => p.slots[s.slot] || '')];
		const rowWidths = [widths[0], widths[1], ...slotsUsed.map((s) => s.width)];
		// 行末的关键字列不必补空格（右边没有要对齐的东西）
		let last = row.length - 1;
		while (last > 1 && !row[last]) last--;
		return row
			.slice(0, last + 1)
			.map((text, i) =>
				text + (i === last ? '' : ' '.repeat(Math.max(0, rowWidths[i] - dispWidth(text))))
			)
			.join(' ');
	});
}

// 表选项：首词补齐到等宽，distribute by / partition by 的 by 与 comment = 的 = 对齐
function alignOptionHeads(options) {
	const heads = options
		.filter((o) => !o.isComment)
		.map((o) => (o.text.match(/^([A-Za-z_][A-Za-z0-9_]*)\b/) || [])[1])
		.filter(Boolean);
	if (heads.length < 2) return null;
	const max = Math.max(...heads.map((h) => h.length));
	return options.map((o) => {
		if (o.isComment) return o.text;
		const m = o.text.match(/^([A-Za-z_][A-Za-z0-9_]*)(\s+)([\s\S]*)$/);
		if (!m) return o.text;
		return m[1] + ' '.repeat(max - m[1].length + 1) + m[3];
	});
}

// ---------------------------------------------------------------------------
// 语句切分与分号检查（不依赖分号数量，用「深度 0 + 顶层语句起始关键字」断句）
// 用途：多语句文件里若某条语句末尾缺分号，平台会当成一条语句解析直接语法错，
// 所以编辑器该给提示；而单语句文件不做任何要求（与 DataGrip 一致）。
// ---------------------------------------------------------------------------
const STMT_START_RE =
	/(^|[^\w$])(select|with|insert|update|delete|create|alter|drop|truncate|grant|revoke|call|use|begin|commit|rollback|explain|show|merge|replace)\b/gi;
// 这些词之后的关键字属于同一语句（union all select / insert into ... 等）
const CONTINUE_WORDS = new Set(
	('union all except intersect minus or and then else when by from into as on in not distinct case if is like between having where join inner left right full cross outer natural using values table exists any some interval partition distribute clustered order group limit offset asc desc duplicate key update delete ignore primary unique').split(
		' '
	)
);

// 注释与字符串内容替换成等长空格，保留位置，避免干扰关键字与分号识别
function maskLiterals(text) {
	const out = text.split('');
	let quote = null;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quote) {
			if (c === quote && text[i - 1] !== '\\') quote = null;
			else if (c !== '\n') out[i] = ' ';
			continue;
		}
		if (c === "'" || c === '"' || c === '`') {
			quote = c;
			if (c !== '\n') out[i] = ' ';
			continue;
		}
		if (c === '-' && text[i + 1] === '-') {
			const nl = text.indexOf('\n', i);
			const end = nl < 0 ? text.length : nl;
			for (let k = i; k < end; k++) out[k] = ' ';
			i = end;
			continue;
		}
		if (c === '/' && text[i + 1] === '*') {
			const end = text.indexOf('*/', i + 2);
			const stop = end < 0 ? text.length : end + 2;
			for (let k = i; k < stop; k++) if (out[k] !== '\n') out[k] = ' ';
			i = stop - 1;
			continue;
		}
	}
	return out.join('');
}

function lastWordBefore(masked, idx) {
	const before = masked.slice(0, idx).trimEnd();
	const m = before.match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/);
	return m ? m[1].toLowerCase() : '';
}

// 返回 { segments: [{start, end, hasSemi}], missing: [{start, length}] }
function findStatements(text) {
	const masked = maskLiterals(text);
	// 一次线性扫描算出每个位置之前的括号深度，避免逐位置重算
	const depthBefore = new Int32Array(masked.length + 1);
	let depth = 0;
	for (let i = 0; i < masked.length; i++) {
		depthBefore[i] = depth;
		const c = masked[i];
		if (c === '(') depth++;
		else if (c === ')') depth = Math.max(0, depth - 1);
	}
	depthBefore[masked.length] = depth;

	const semis = [];
	for (let i = 0; i < masked.length; i++) {
		if (masked[i] === ';' && depthBefore[i] === 0) semis.push(i);
	}

	const starts = [];
	let re = new RegExp(STMT_START_RE.source, 'gi');
	let m;
	while ((m = re.exec(masked))) {
		const idx = m.index + m[1].length;
		if (depthBefore[idx] !== 0) continue;
		const kw = m[2].toLowerCase();
		const prevWord = lastWordBefore(masked, idx);
		if (prevWord && CONTINUE_WORDS.has(prevWord)) continue;
		const prevChar = masked.slice(0, idx).trimEnd().slice(-1);
		// 右括号之后：insert ... (cols) select / with x as (...) select 属同一语句
		if (prevChar === ')' && ['select', 'with', 'values', 'union'].includes(kw)) continue;
		const head = starts.length ? masked.slice(starts[starts.length - 1].start).match(/^[a-z_]+/i) : null;
		const headKw = head ? head[0].toLowerCase() : '';
		if (['insert', 'replace', 'update'].includes(headKw) && ['select', 'with'].includes(kw)) continue;
		if (starts.length && idx - starts[starts.length - 1].start < 8) continue;
		starts.push({ start: idx, length: m[2].length });
	}

	const segments = [];
	const missing = [];
	for (let s = 0; s < starts.length; s++) {
		const next = s + 1 < starts.length ? starts[s + 1].start : masked.length;
		const hasSemi = semis.some((pos) => pos >= starts[s].start && pos < next);
		if (s > 0 && !semis.some((pos) => pos >= starts[s - 1].start && pos < starts[s].start)) {
			missing.push(starts[s]);
		}
		segments.push({ start: starts[s].start, end: next, hasSemi });
	}
	return { segments, missing };
}

// ---------------------------------------------------------------------------
// 建表语句（CREATE TABLE）重排：ADB 表选项要各自一行
//   ) 之后 distribute by / partition by / comment / index_all 等逐行拆开
//   列定义（含 primary key）逐行逗号前置
// 只在通用格式化之后做确定性的文本重排，解析不了就原样返回，不动语句。
// ---------------------------------------------------------------------------
const OPTION_HEADS = [
	'DISTRIBUTED BY', 'DISTRIBUTE BY', 'PARTITIONED BY', 'PARTITION BY',
	'COMMENT', 'INDEX_ALL', 'STORAGE_POLICY', 'TABLE_PROPERTIES', 'ENGINE',
	'BLOCK_SIZE', 'LOCATION', 'PROPERTIES', 'CHARSET', 'COLLATE',
];
// 表选项行里需要小写的 ADB 专有词（mysql 方言不认，通用 keywordCase 管不到）
const OPTION_WORDS = [
	'DISTRIBUTED', 'DISTRIBUTE', 'PARTITIONED', 'PARTITION', 'BY', 'HASH',
	'VALUE', 'BROADCAST', 'LIFECYCLE', 'COMMENT', 'INDEX_ALL', 'STORAGE_POLICY',
	'TABLE_PROPERTIES', 'ENGINE', 'BLOCK_SIZE', 'LOCATION', 'PROPERTIES',
	'CHARSET', 'COLLATE', 'PARTITIONS',
];

// 按括号深度 0 拆分，识别引号 / `--` 行注释 / `/* */` 块注释
function splitTopLevel(text, separator) {
	const parts = [];
	let depth = 0;
	let quote = null;
	let start = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quote) {
			if (c === quote && text[i - 1] !== '\\') quote = null;
			continue;
		}
		if (c === "'" || c === '"' || c === '`') {
			quote = c;
			continue;
		}
		if (c === '-' && text[i + 1] === '-') {
			const nl = text.indexOf('\n', i);
			i = nl < 0 ? text.length : nl;
			continue;
		}
		if (c === '/' && text[i + 1] === '*') {
			const end = text.indexOf('*/', i);
			i = end < 0 ? text.length : end + 1;
			continue;
		}
		if (c === '(') depth++;
		else if (c === ')') depth--;
		else if (c === separator && depth === 0) {
			parts.push(text.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(text.slice(start));
	return parts;
}

// 找到与 start 处左括号配对的右括号下标；找不到返回 -1
function matchParen(text, start) {
	let depth = 0;
	let quote = null;
	for (let i = start; i < text.length; i++) {
		const c = text[i];
		if (quote) {
			if (c === quote && text[i - 1] !== '\\') quote = null;
			continue;
		}
		if (c === "'" || c === '"' || c === '`') {
			quote = c;
			continue;
		}
		if (c === '-' && text[i + 1] === '-') {
			const nl = text.indexOf('\n', i);
			i = nl < 0 ? text.length : nl - 1;
			continue;
		}
		if (c === '/' && text[i + 1] === '*') {
			const end = text.indexOf('*/', i);
			i = end < 0 ? text.length : end + 1;
			continue;
		}
		if (c === '(') depth++;
		else if (c === ')' && --depth === 0) return i;
	}
	return -1;
}

// 折叠引号外的空白为单空格；行注释后的换行必须保留，否则会把后续内容吞进注释
function squeeze(text) {
	let out = '';
	let quote = null;
	let pendingSpace = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quote) {
			out += c;
			if (c === quote && text[i - 1] !== '\\') quote = null;
			continue;
		}
		if (c === "'" || c === '"' || c === '`') {
			if (pendingSpace && out) out += ' ';
			pendingSpace = false;
			quote = c;
			out += c;
			continue;
		}
		if (c === '-' && text[i + 1] === '-') {
			const nl = text.indexOf('\n', i);
			const comment = nl < 0 ? text.slice(i) : text.slice(i, nl);
			out += (pendingSpace && out ? ' ' : '') + comment.trimEnd();
			i += comment.length;
			if (nl < 0) i = text.length;
			pendingSpace = false;
			continue;
		}
		if (c === '/' && text[i + 1] === '*') {
			const end = text.indexOf('*/', i);
			const block = end < 0 ? text.slice(i) : text.slice(i, end + 2);
			out += (pendingSpace && out ? ' ' : '') + squeezeBlockComment(block);
			i += block.length - 1;
			pendingSpace = false;
			continue;
		}
		if (/\s/.test(c)) {
			pendingSpace = true;
			continue;
		}
		if (pendingSpace && out) out += ' ';
		pendingSpace = false;
		out += c;
	}
	return out.trim();
}

function squeezeBlockComment(block) {
	// 块注释内部压成单行，保持 /* ... */ 形态
	return block.replace(/\s+/g, ' ').trim();
}

// 在单个物理行内按表选项关键字切段；返回 [{ text, atHead }]
function splitHeadsInLine(line) {
	const pieces = [];
	let cur = '';
	let curAtHead = false;
	let quote = null;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (quote) {
			cur += c;
			if (c === quote && line[i - 1] !== '\\') quote = null;
			continue;
		}
		if (c === "'" || c === '"' || c === '`') {
			quote = c;
			cur += c;
			continue;
		}
		if (c === '-' && line[i + 1] === '-') {
			// 行尾注释：整段并入当前片段
			cur += line.slice(i);
			i = line.length;
			break;
		}
		const head = OPTION_HEADS.find(
			(h) =>
				new RegExp('^' + h.replace(/ /g, '\\s+') + '(\\b|=)', 'i').test(line.slice(i)) &&
				(i === 0 || /\s/.test(line[i - 1]))
		);
		if (head) {
			if (cur.trim()) pieces.push({ text: cur.trim(), atHead: curAtHead });
			cur = line.slice(i, i + head.length);
			curAtHead = true;
			i += head.length - 1;
			continue;
		}
		cur += c;
	}
	if (cur.trim()) pieces.push({ text: cur.trim(), atHead: curAtHead });
	return pieces;
}

// 表选项区：按物理行分组，一个选项一行。
// 不能整段折叠成一行——`--` 行注释会把后面的 comment '...' 吞进注释里。
function splitOptionLines(tail) {
	const frags = [];
	for (const rawLine of tail.split('\n')) {
		const t = rawLine.trim();
		if (!t) continue;
		if (/^(-{2}|\/\*)/.test(t)) {
			frags.push({ text: t, isComment: true });
			continue;
		}
		splitHeadsInLine(t).forEach((piece) => {
			const last = frags[frags.length - 1];
			if (!piece.atHead && last && !last.isComment && !last.text.includes('--')) {
				last.text = squeeze(last.text + ' ' + piece.text);
				return;
			}
			frags.push({ text: squeeze(piece.text), isComment: false });
		});
	}
	return frags
		.map((fr) => ({
			...fr,
			text: fr.isComment
				? fr.text
				: fr.text
						.replace(/(^|[^'`"])([A-Z_]{2,})(?![A-Za-z0-9_'"'])/g, (m, pre, word) =>
							OPTION_WORDS.includes(word) ? pre + word.toLowerCase() : m
						)
						// 你们仓库写 hash(uid) / value(dt)，不留函数名后的空格
						.replace(/\b(hash|value|values|list)\s+\(/gi, '$1('),
		}))
		.filter((fr) => fr.text);
}

// 找到引号/注释之外的第一个分号下标；没有返回 -1
function findTopLevelSemicolon(text) {
	let quote = null;
	let depth = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quote) {
			if (c === quote && text[i - 1] !== '\\') quote = null;
			continue;
		}
		if (c === "'" || c === '"' || c === '`') {
			quote = c;
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
		if (c === '(') depth++;
		else if (c === ')') depth--;
		else if (c === ';' && depth <= 0) return i;
	}
	return -1;
}

function formatCreateTable(statement) {
	// 表名取到 `(` 之前：先吃反引号整段（里面可能有 ${...} 与 $），再退回普通标识符。
	// 原来的字符类不含 $ —— 表名里一出现 $，headMatch 就只匹配到 $ 之前，
	// 后缀（`$2026` / `${年月...}`）被当成「名字后面的东西」丢掉 = 静默改表名。
	const headMatch = statement.match(/^create\s+table\s+(if\s+not\s+exists\s+)?(`[^`\n]*`|[`0-9a-zA-Z_$.]+)\s*/i);
	if (!headMatch) return null;
	const afterHead = headMatch[0].length;
	const rest = statement.slice(afterHead);
	// CTAS / LIKE 等没有列定义括号的形态一律不动
	const asIdx = rest.search(/\bas\b|\blike\b/i);
	const openIdx = rest.indexOf('(');
	if (openIdx < 0) return null;
	if (asIdx >= 0 && asIdx < openIdx) return null;
	const closeIdx = matchParen(rest, openIdx);
	if (closeIdx < 0) return null;
	const body = rest.slice(openIdx + 1, closeIdx);
	const tail = rest.slice(closeIdx + 1);
	// 括号内其实是子查询（create table t (select ...)），或括号后还有查询体：不重排
	if (/^\s*(\/\*[\s\S]*?\*\/|--[^\n]*\n|\s)*select\b/i.test(body)) return null;
	const semiIdx = findTopLevelSemicolon(tail);
	const hadSemi = semiIdx >= 0;
	const tailCode = hadSemi ? tail.slice(0, semiIdx) : tail;
	const tailAfter = (hadSemi ? tail.slice(semiIdx + 1) : '').split('\n').map(squeeze).filter(Boolean);
	if (/\bselect\b/i.test(tailCode)) return null;
	// `insert into t (列...) 换行 select ...`：右括号后的内容其实是查询体，形态有歧义，不重排
	if (/^\s*(insert|replace|with|select|union)\b/i.test(tailCode)) return null;

	const header = squeeze(headMatch[0]);

	// 列条目：按物理行区分注释行与代码行。
	// 注释行只缩进不加逗号，代码行按逗号前置排版（首个代码条目不加逗号）。
	const items = splitTopLevel(body, ',');
	const cols = [];
	let seenCode = false;
	for (const rawItem of items) {
		if (!rawItem.trim()) continue;
		const itemLines = rawItem
			.split('\n')
			.map((l) => l.trim())
			.filter(Boolean);
		let codeDone = false;
		for (const l of itemLines) {
			const isComment = /^(-{2}|\/\*)/.test(l);
			if (isComment) {
				cols.push({ text: l, comma: false });
				continue;
			}
			const needComma = seenCode && !codeDone;
			cols.push({ text: l, comma: needComma });
			seenCode = true;
			codeDone = true;
		}
	}
	if (!cols.some((c) => !/^(-{2}|\/\*)/.test(c.text))) return null;

	return { header, cols, options: splitOptionLines(tailCode), hadSemi, after: tailAfter };
}

// 跨行累计括号深度（跳过引号与注释），用于判断语句边界
function advanceDepth(text, startDepth) {
	let depth = startDepth;
	let quote = null;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (quote) {
			if (c === quote && text[i - 1] !== '\\') quote = null;
			continue;
		}
		if (c === "'" || c === '"' || c === '`') {
			quote = c;
			continue;
		}
		if (c === '-' && text[i + 1] === '-') break;
		if (c === '/' && text[i + 1] === '*') {
			const end = text.indexOf('*/', i + 2);
			i = end < 0 ? text.length : end + 1;
			continue;
		}
		if (c === '(') depth++;
		else if (c === ')') depth--;
	}
	return depth;
}

const NEW_STMT_RE =
	/^(insert|update|delete|select|with|create|alter|drop|truncate|grant|revoke|set|call|explain|show|use|begin|commit|rollback)\b/i;

function reformatDdl(text) {
	const lines = text.split('\n');
	const out = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!/^(\s*)create\s+table\s/i.test(line)) {
			out.push(line);
			continue;
		}
		const indent = line.match(/^\s*/)[0];
		// 从这一行起按括号深度累计整条语句：分号结尾，或遇到下一条顶层语句，或到文件末尾
		const parts = [];
		let depth = 0;
		let j = i;
		while (j < lines.length) {
			const raw = lines[j];
			const trimmed = raw.trim();
			if (parts.length && depth === 0 && NEW_STMT_RE.test(trimmed)) break;
			parts.push(trimmed);
			depth = advanceDepth(raw, depth);
			const ended = depth <= 0 && /;\s*$/.test(trimmed);
			j++;
			if (ended) break;
		}
		const stmt = parts.join('\n').trim();
		const rebuilt = stmt ? formatCreateTable(stmt) : null;
		if (!rebuilt) {
			out.push(line);
			continue;
		}
		const body = [];
		const rawOpts = rebuilt.options;
		// 分号只能落在最后一条非注释选项上，否则会掉进行注释里
		let lastCodeIdx = -1;
		rawOpts.forEach((o, idx) => {
			if (!o.isComment) lastCodeIdx = idx;
		});
		// 关键字纵向对齐：只在解析得出固定形态时启用，否则保持原样
		const alignedCols = alignColumnKeywords(rebuilt.cols);
		const alignedHeads = alignOptionHeads(rawOpts);
		const opts = rawOpts.map((o, idx) => ({ ...o, text: alignedHeads ? alignedHeads[idx] : o.text }));
		body.push(indent + rebuilt.header);
		body.push(indent + '(');
		rebuilt.cols.forEach((c, idx) => {
			// 对齐后首条列没有 `, ` 前缀，补 2 空格才能与逗号行的列名对齐
			const lead = c.comma ? ', ' : alignedCols ? '  ' : '';
			body.push(indent + '	' + lead + (alignedCols ? alignedCols[idx] : c.text));
		});
		if (opts.length) {
			body.push(indent + ')');
			opts.forEach((o, idx) =>
				body.push(indent + o.text + (idx === lastCodeIdx && rebuilt.hadSemi ? ';' : ''))
			);
		} else {
			body.push(indent + ')' + (rebuilt.hadSemi ? ';' : ''));
		}
		rebuilt.after.forEach((line) => body.push(indent + line));
		out.push(...body);
		i = j - 1;
	}
	return out.join('\n');
}

// ---------------------------------------------------------------------------
// `--` 行注释收在字段末尾时，sql-formatter 会先把注释换行收尾、再给前置逗号换行，
// 于是字段行与下一个逗号行之间凭空多一个空行 —— 每个带行尾注释的字段多占一行（行数翻倍）。
// 这里只吃掉这种空行：中间那行是空行、上一行带行内注释、下一行以逗号开头。
// 空行只可能来自排版器（sql-formatter 不保留用户写的空行），所以不做其它猜测。
// ---------------------------------------------------------------------------
function hasTrailingLineComment(line) {
	let quote = null;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (quote) {
			if (c === quote && line[i - 1] !== '\\') quote = null;
			continue;
		}
		if (c === "'" || c === '"' || c === '`') {
			quote = c;
			continue;
		}
		if (c === '-' && line[i + 1] === '-') return true;
		if (c === '/' && line[i + 1] === '*') {
			const end = line.indexOf('*/', i + 2);
			if (end < 0) return false;
			i = end + 1;
		}
	}
	return false;
}

function collapseCommaCommentGaps(text) {
	const lines = text.split('\n');
	const out = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const gap =
			!line.trim() &&
			out.length > 0 &&
			/^\s*,/.test(lines[i + 1] || '') &&
			hasTrailingLineComment(out[out.length - 1]);
		if (!gap) out.push(line);
	}
	return out.join('\n');
}

// ---------------------------------------------------------------------------
// 结构缩进（可选）：adbSqlFormatter.indentMode
//   flat      = 现状：from / join / where / and 全挤在同一列
//   nested    = 每个子句行 / join 行开启一个「体」，属于它的续行深一级
//   nested-on = nested + 把 `left join t on <cond>` 拆成两行，on 再深一级
// 这一层在 tab 层做（toTabs 之后、reformatDdl 之前），只改行首缩进，内容一个字符都不动：
//   - 多行字符串 / 块注释内部的行一律原样放行 —— 把 tab 打进引号里就是改数据，
//     ab 闸会判「真动代码」；
//   - 括号块随开括号那一行的增量整体平移，块内相对结构不变；
//   - 幂等：owner 只在「基准缩进相同」的行之间认领，所以再跑一遍结果不变。
// ---------------------------------------------------------------------------
const STRUCT_CLAUSE_RE =
	/^(select|from|where|group by|having|order by|limit|offset|window|values|set|insert|create table|union)\b/i;
const STRUCT_JOIN_RE =
	/^(?:(?:left|right|inner|cross|full|natural|straight_join)\s+)*(?:outer\s+)?join\b/i;
const STRUCT_CONT_RE = /^(and|or)\b/i;

// 行首是否落在多行字符串 / 块注释内部（这些行不许重排缩进）
function startsInLiteral(text) {
	const count = text.split('\n').length;
	const flags = new Array(count).fill(false);
	let quote = null;
	let block = false;
	let line = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === '\n') {
			line++;
			if (line < count) flags[line] = !!quote || block;
			continue;
		}
		if (quote) {
			if (c === quote && text[i - 1] !== '\\') quote = null;
			continue;
		}
		if (block) {
			if (c === '*' && text[i + 1] === '/') {
				block = false;
				i++;
			}
			continue;
		}
		if (c === "'" || c === '"' || c === '`') quote = c;
		else if (c === '/' && text[i + 1] === '*') {
			block = true;
			i++;
		}
	}
	return flags;
}

// 本行里深度 0 处的 `on`（入参已掩码，引号/注释内容被抹成空格），nested-on 据此拆行
function topLevelOnIndex(masked) {
	let depth = 0;
	for (let i = 0; i < masked.length; i++) {
		const c = masked[i];
		if (c === '(') depth++;
		else if (c === ')') depth = Math.max(0, depth - 1);
		else if (
			depth === 0 &&
			(c === 'o' || c === 'O') &&
			/^on\s/i.test(masked.slice(i, i + 3)) &&
			(i === 0 || /\s/.test(masked[i - 1]))
		) return i;
	}
	return -1;
}

function applyStructureIndent(text, mode) {
	if (mode !== 'nested' && mode !== 'nested-on') return text;
	const splitOn = mode === 'nested-on';
	const lines = text.split('\n');
	const maskedLines = maskLiterals(text).split('\n');
	const literal = startsInLiteral(text);
	const scopes = new Map();
	const frame = [];
	const out = [];
	let depth = 0;
	const scopeAt = (d) => {
		if (!scopes.has(d)) scopes.set(d, { clause: null, join: null });
		return scopes.get(d);
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const base = (line.match(/^\t*/) || [''])[0].length;
		const body = line.slice(base);
		const masked = maskLiterals(body).replace(/^\s+/, '');
		const xParent = frame.length ? frame[frame.length - 1] : 0;
		const sc = scopeAt(depth);
		const skip = literal[i];
		const isClause = !skip && STRUCT_CLAUSE_RE.test(masked);
		const isJoin = !skip && !isClause && STRUCT_JOIN_RE.test(masked);
		const isCont = !skip && !isClause && !isJoin && STRUCT_CONT_RE.test(masked);
		let x = xParent;
		if (isJoin) {
			if (sc.clause && sc.clause.base === base) x = sc.clause.x + 1;
		} else if (isCont) {
			const owner =
				sc.join && sc.join.base === base ? sc.join : sc.clause && sc.clause.base === base ? sc.clause : null;
			if (owner) x = owner.x + 1;
		}
		const onAt = splitOn && isJoin ? topLevelOnIndex(maskLiterals(body)) : -1;
		const pad = '\t'.repeat(Math.max(0, base + x));
		if (onAt > 0) {
			// 拆行：`left join t on <cond>` → 表/别名一行、on 条件再深一级
			out.push(pad + body.slice(0, onAt).replace(/[ \t]+$/, ''));
			out.push('\t'.repeat(Math.max(0, base + x + 1)) + body.slice(onAt).replace(/^\s+/, ''));
		} else {
			out.push(skip ? line : pad + body);
		}
		// 括号深度与帧：每行按原始行只算一次（拆成两行时不能重复计）
		for (const ch of maskedLines[i]) {
			if (ch === '(') {
				frame.push(x);
				depth++;
			} else if (ch === ')') {
				depth = Math.max(0, depth - 1);
				frame.pop();
			}
		}
		if (skip) continue;
		if (isJoin) sc.join = { base, x };
		else if (isClause) {
			sc.clause = { base, x };
			sc.join = null;
		}
	}
	return out.join('\n');
}

// ---------------------------------------------------------------------------
// 换行策略：A 长逗号列表按行宽打包 / B 短括号块合回一行 / C 条件同类合行
// 三步都放在 reformatDdl 之后 —— 那时缩进与对齐都已是最终形态，行宽才算得准。
// 共同约束（三条规则各自都要能独立守住）：
//   1. 只改换行与空白，不改任何 token：运算符顺序、括号结构一律不动；
//   2. 带行内注释的块一律不动 —— 拼到一行会把后面的内容吞进注释里；
//   3. 跨行字符串 / 块注释内部一律不动（那是数据，不是空白）；
//   4. create table 整段跳过 —— 列定义对齐是本扩展的既有产出。
// ---------------------------------------------------------------------------

// 行宽：tab 按 tabWidth 展开，中日韩字符按 2 列（复用 DDL 对齐那套 dispWidth）
function lineWidth(text, tabWidth) {
	return dispWidth(String(text).split('\t').join(' '.repeat(tabWidth)));
}

function indentOfLine(line) {
	const m = line.match(/^[ \t]*/);
	return m ? m[0] : '';
}

// 每行是否落在 create table 语句里（DDL 整体跳过）
function createTableFlags(lines) {
	const flags = new Array(lines.length).fill(false);
	let inDdl = false;
	for (let i = 0; i < lines.length; i++) {
		if (/^\s*create\s+table\b/i.test(lines[i])) inDdl = true;
		flags[i] = inDdl;
		if (inDdl && /;\s*$/.test(lines[i])) inDdl = false;
	}
	return flags;
}

// 引号之外的注释（`--` 或未闭合的 `/*`）：带注释的行不许参与任何拼行
function hasCommentOutsideQuote(line) {
	let quote = null;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (quote) {
			if (c === quote && line[i - 1] !== '\\') quote = null;
			continue;
		}
		if (c === "'" || c === '"' || c === '`') {
			quote = c;
			continue;
		}
		if (c === '-' && line[i + 1] === '-') return true;
		if (c === '/' && line[i + 1] === '*') {
			const end = line.indexOf('*/', i + 2);
			if (end < 0) return true;
			i = end + 1;
		}
	}
	return false;
}

// ---------------------------------------------------------------------------
// 规则 A：逐条一行的逗号列表按行宽打包
// 只认「`<前缀>(` 收行的开口行 + 每行 `, 条目`（首条不带逗号）+ 纯 `)` 收尾行」这一种形态。
// 条目自己就超宽时退化成一行一条，不会比现在更差。
// ---------------------------------------------------------------------------
function readCommaListBlock(lines, i, ddlFlags) {
	if (ddlFlags[i]) return null;
	const line = lines[i];
	if (!line.includes('(') || !/[(,]\s*$/.test(line)) return null;
	if (hasCommentOutsideQuote(line)) return null;
	if (i + 1 >= lines.length) return null;
	const firstLine = lines[i + 1];
	if (!firstLine.trim() || /^\s*,/.test(firstLine)) return null;
	if (hasCommentOutsideQuote(firstLine)) return null;
	const items = [firstLine.trim()];
	let j = i + 2;
	while (j < lines.length && /^\s*,/.test(lines[j])) {
		if (hasCommentOutsideQuote(lines[j])) return null;
		items.push(lines[j].trim().replace(/^,\s*/, ''));
		j++;
	}
	if (j >= lines.length || hasCommentOutsideQuote(lines[j])) return null;
	// 收尾行只有 `)` / `);` / `) then 1` 这类形态（右边不允许再出现括号）
	const close = lines[j].match(/^[ \t]*\)([^()]*)$/);
	if (!close) return null;
	return { items, closeTail: close[1], itemIndent: indentOfLine(firstLine), endLine: j };
}

function packLongCommaLists(text, width, tabWidth) {
	const lines = text.split('\n');
	const ddlFlags = createTableFlags(lines);
	const out = [];
	for (let i = 0; i < lines.length; i++) {
		const block = readCommaListBlock(lines, i, ddlFlags);
		if (!block || block.items.length < 2) {
			out.push(lines[i]);
			continue;
		}
		const { items, closeTail, itemIndent, endLine } = block;
		// 整段能塞进一行就直接一行（含收尾括号与尾随的 `;`）
		const single = lines[i].replace(/[ \t]+$/, '') + items.join(', ') + ')' + closeTail;
		if (lineWidth(single, tabWidth) <= width) {
			out.push(single);
			i = endLine;
			continue;
		}
		const indentW = lineWidth(itemIndent, tabWidth);
		const packed = [];
		let cur = '';
		for (const item of items) {
			if (cur && indentW + lineWidth(cur + ', ' + item, tabWidth) > width) {
				packed.push(cur);
				cur = '';
			}
			cur = cur ? cur + ', ' + item : item;
		}
		if (cur) packed.push(cur);
		if (packed.length >= items.length) {
			out.push(lines[i]);
			i = endLine;
			continue;
		}
		out.push(lines[i]);
		// 首行不带前置逗号，续行沿用 commaPosition=before 的 `, ` 风格
		packed.forEach((p, idx) => out.push(itemIndent + (idx === 0 ? p : ', ' + p)));
		out.push(lines[endLine]);
		i = endLine;
	}
	return out.join('\n');
}

// ---------------------------------------------------------------------------
// 规则 B：短括号块合回一行（条件分组 / 子查询 / CTE 体 / 派生表）
// 从最内层往外合，整行宽度（含缩进）不超过 expressionWidth 才合；
// 合完仍然超宽就保持多行 —— 所以长条件会停在「or 分组各占一行」这种可读粒度。
// ---------------------------------------------------------------------------
function flattenBlockText(blockText) {
	let out = '';
	let quote = null;
	let pending = false;
	const pad = () => {
		if (pending && out && !out.endsWith('(') && !out.endsWith(', ')) out += ' ';
		pending = false;
	};
	for (let i = 0; i < blockText.length; i++) {
		const c = blockText[i];
		if (quote) {
			out += c;
			if (c === quote && blockText[i - 1] !== '\\') quote = null;
			continue;
		}
		if (c === "'" || c === '"' || c === '`') {
			pad();
			quote = c;
			out += c;
			continue;
		}
		if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
			pending = true;
			continue;
		}
		if (c === ',' || c === ')') {
			out = out.replace(/[ \t]+$/, '');
			pending = false;
			out += c === ',' ? ', ' : ')';
			continue;
		}
		if (c === '(') {
			pad();
			out += '(';
			continue;
		}
		pad();
		out += c;
	}
	return out.replace(/[ \t]+$/, '').replace(/[ \t]+\)/g, ')');
}

// 从 (lineIdx, col) 的左括号找到配对的右括号；带注释 / 跨行字符串 / 进了 DDL 一律放弃
function findBlockEnd(lines, lineIdx, col, ddlFlags) {
	let depth = 0;
	let quote = null;
	for (let i = lineIdx; i < lines.length; i++) {
		if (ddlFlags[i] && i > lineIdx) return null;
		const seg = i === lineIdx ? lines[i].slice(col) : lines[i];
		for (let k = 0; k < seg.length; k++) {
			const c = seg[k];
			if (quote) {
				if (c === quote && seg[k - 1] !== '\\') quote = null;
				continue;
			}
			if (c === "'" || c === '"' || c === '`') {
				quote = c;
				continue;
			}
			if (c === '-' && seg[k + 1] === '-') return null;
			if (c === '/' && seg[k + 1] === '*') return null;
			if (c === '(') depth++;
			else if (c === ')') {
				depth--;
				if (depth === 0) return { line: i, col: k };
			}
		}
		if (quote) return null; // 跨行字符串：合行会改到字面量内容
	}
	return null;
}

function collapseShortBlocks(text, width, tabWidth) {
	let lines = text.split('\n');
	// 一轮只合一层（内层先合，外层下一轮再判），嵌套深度有限，轮数不会失控
	for (let pass = 0; pass < 8; pass++) {
		const joined = lines.join('\n');
		const ddlFlags = createTableFlags(lines);
		const literalFlags = startsInLiteral(joined);
		let changed = false;
		for (let i = 0; i < lines.length; i++) {
			if (ddlFlags[i] || literalFlags[i]) continue;
			const line = lines[i];
			let quote = null;
			let collapsed = false;
			for (let k = 0; k < line.length && !collapsed; k++) {
				const c = line[k];
				if (quote) {
					if (c === quote && line[k - 1] !== '\\') quote = null;
					continue;
				}
				if (c === "'" || c === '"' || c === '`') {
					quote = c;
					continue;
				}
				if (c === '-' && line[k + 1] === '-') break;
				if (c === '/' && line[k + 1] === '*') break;
				if (c !== '(') continue;
				const end = findBlockEnd(lines, i, k, ddlFlags);
				if (!end || end.line === i) continue;
				const inner = lines.slice(i, end.line + 1);
				inner[0] = line.slice(k);
				inner[inner.length - 1] = lines[end.line].slice(0, end.col + 1);
				const single =
					line.slice(0, k) + flattenBlockText(inner.join('\n')) + lines[end.line].slice(end.col + 1);
				if (lineWidth(single, tabWidth) > width) continue;
				lines = lines.slice(0, i).concat([single], lines.slice(end.line + 1));
				changed = true;
				collapsed = true;
			}
		}
		if (!changed) break;
	}
	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 规则 C：where / having / join … on 的条件链「同类同义尽量同线」
// 同类判定只看相邻两条，且不跨 and/or：
//   ① 同一个左值（`dt >= …` 与 `dt <= …`）—— 同义；
//   ② 同一个运算符（都 `=` / 都 `in` / 都 `between`）—— 同类。
// 先按同类黏成簇，再整簇按行宽装填（整簇放不下一行时才拆）。
// ---------------------------------------------------------------------------
function condTopicOf(text) {
	const t = text.replace(/[;,]\s*$/, '').trim();
	const m = t.match(/^(.+?)\s+(not\s+in|not\s+like|is\s+not|=|<>|!=|>=|<=|>|<|in|like|is|between)\s/i);
	if (!m) return null;
	let op = m[2].toLowerCase().replace(/\s+/g, ' ');
	if (op === '!=') op = '<>';
	if (op === 'is not') op = 'is';
	return { subject: m[1].replace(/\s+/g, ' ').toLowerCase(), op };
}

function condSameTopic(a, b) {
	if (!a || !b) return false;
	return a.subject === b.subject || a.op === b.op;
}

function splitCondJoiner(line) {
	const m = line.match(/^([ \t]*)(and|or)\s+(.*)$/i);
	if (!m) return null;
	return { pad: m[1], joiner: m[2].toLowerCase(), body: m[3] };
}

const COND_CLAUSE_KEYWORDS = [
	'where', 'having', 'on', 'from', 'group by', 'order by', 'limit', 'offset', 'window',
	'left join', 'right join', 'inner join', 'full join', 'cross join', 'join',
	'union all', 'union', 'select', 'with', 'set', 'values', 'insert', 'create table',
];

function isCondClauseHead(line) {
	const t = line.trim().toLowerCase();
	if (/^(and|or)\s/.test(t)) return false;
	return COND_CLAUSE_KEYWORDS.some((k) => t === k || t.startsWith(k + ' '));
}

// 把 head 行拆成「前缀 + 条件正文」：`where x` / `having x` / `join b on x`
function splitCondHead(line) {
	const m = line.match(/^([ \t]*(?:[a-z]+ )*?)(on|where|having)\s+(.*)$/i);
	if (!m) return null;
	return { prefix: m[1] + m[2] + ' ', body: m[3] };
}

// 逐行跟踪括号深度（条件块里的括号自成一层，块内不当作 and/or 拆行点）
function depthScanner() {
	let depth = 0;
	let quote = null;
	return (line) => {
		const start = depth;
		for (let i = 0; i < line.length; i++) {
			const c = line[i];
			if (quote) {
				if (c === quote && line[i - 1] !== '\\') quote = null;
				continue;
			}
			if (c === "'" || c === '"' || c === '`') {
				quote = c;
				continue;
			}
			if (c === '-' && line[i + 1] === '-') break;
			if (c === '(') depth++;
			else if (c === ')') depth = Math.max(0, depth - 1);
		}
		return start;
	};
}

// 收集一个条件子句：head 单元 + 每条 and/or 单元（单元可跨多行，如已打包的 IN 列表）
function collectCondUnits(lines, i, ddlFlags) {
	if (ddlFlags[i] || hasCommentOutsideQuote(lines[i])) return null;
	const head = splitCondHead(lines[i]);
	if (!head) return null;
	const nextDepth = depthScanner();
	nextDepth(lines[i]);
	const units = [
		{ prefix: head.prefix, body: head.body, joiner: null, topic: condTopicOf(head.body), extra: [] },
	];
	let cur = units[0];
	let j = i + 1;
	let contPad = null;
	while (j < lines.length) {
		const line = lines[j];
		if (hasCommentOutsideQuote(line)) return null;
		const d = nextDepth(line);
		const sp = d === 0 ? splitCondJoiner(line) : null;
		if (sp) {
			if (contPad === null) {
				if (sp.pad.length < indentOfLine(lines[i]).length) break;
				contPad = sp.pad;
			}
			if (sp.pad === contPad) {
				cur = { prefix: sp.pad + sp.joiner + ' ', body: sp.body, joiner: sp.joiner, topic: condTopicOf(sp.body), extra: [] };
				units.push(cur);
				j++;
				continue;
			}
		}
		if (d === 0 && isCondClauseHead(line)) break;
		cur.extra.push(line);
		j++;
	}
	if (units.length < 2) return null;
	return { units, endLine: j - 1, pad: units[1].prefix.match(/^[ \t]*/)[0] };
}

function packConditions(text, width, tabWidth) {
	const lines = text.split('\n');
	const ddlFlags = createTableFlags(lines);
	const out = [];
	for (let i = 0; i < lines.length; i++) {
		const info = collectCondUnits(lines, i, ddlFlags);
		if (!info) {
			out.push(lines[i]);
			continue;
		}
		const { units, endLine, pad } = info;
		const meta = units.map((u) => ({
			single: u.extra.length === 0,
			prefix: u.prefix,
			body: u.body,
			joiner: u.joiner,
			topic: u.topic,
			extra: u.extra,
		}));

		// 同类黏成簇
		const clusters = [];
		meta.forEach((m, k) => {
			if (k === 0) {
				clusters.push([m]);
				return;
			}
			const prev = meta[k - 1];
			const last = clusters[clusters.length - 1];
			const canGlue =
				m.single &&
				prev.single &&
				m.joiner === prev.joiner &&
				condSameTopic(prev.topic, m.topic) &&
				last.every((x) => x.single && x.joiner === m.joiner);
			if (canGlue) last.push(m);
			else clusters.push([m]);
		});

		let cur = meta[0].prefix + meta[0].body;
		let hasUnit = false;
		let blocked = !meta[0].single;
		const flush = () => {
			if (cur !== null) out.push(cur);
			cur = null;
			hasUnit = false;
			blocked = false;
		};
		if (blocked) {
			// head 行自带多行块：head + 块内容原样送出，后续条件另起一行
			out.push(cur);
			for (const l of meta[0].extra) out.push(l);
			cur = null;
			blocked = false;
		}

		for (let ci = 1; ci < clusters.length; ci++) {
			const cl = clusters[ci];
			if (cl.some((m) => !m.single)) {
				// 含多行单元：先收行，再逐个送出（多行块原样；单行单元各自装填）
				if (cur !== null) flush();
				for (const m of cl) {
					if (!m.single) {
						if (cur) {
							out.push(cur);
							cur = null;
						}
						out.push(m.prefix + m.body);
						for (const l of m.extra) out.push(l);
						continue;
					}
					const add = ' ' + m.joiner + ' ' + m.body;
					if (cur !== null && lineWidth(cur + add, tabWidth) > width) {
						out.push(cur);
						cur = null;
					}
					cur = cur !== null ? cur + add : m.prefix + m.body;
					hasUnit = true;
				}
				continue;
			}
			const joined = cl
				.map((m, k) => (k === 0 ? m.joiner + ' ' + m.body : ' ' + m.joiner + ' ' + m.body))
				.join('');
			if (cur !== null && !blocked && lineWidth(cur + ' ' + joined, tabWidth) <= width) {
				cur += ' ' + joined;
				hasUnit = true;
				continue;
			}
			// 整簇单独一行放得下、而当前行已有条件 → 换行让它独占（同类不被拆开）
			if (cur !== null && hasUnit && lineWidth(pad + joined, tabWidth) <= width) {
				flush();
				cur = pad + joined;
				hasUnit = true;
				continue;
			}
			for (const m of cl) {
				const add = ' ' + m.joiner + ' ' + m.body;
				if (cur !== null && !blocked && lineWidth(cur + add, tabWidth) <= width) {
					cur += add;
					hasUnit = true;
					continue;
				}
				if (cur !== null) flush();
				cur = m.prefix + m.body;
				hasUnit = true;
			}
		}
		if (cur !== null) flush();
		i = endLine;
	}
	return out.join('\n');
}

// 三步串起来：短块合行 → 长列表打包 → 条件同类合行（顺序不能换：先合块，列表与条件的宽度才是最终值）
function applyWrapRules(text, cfg, tabWidth) {
	const width = cfg.expressionWidth || 100;
	let out = text;
	if (cfg.wrapShortBlocks !== false) out = collapseShortBlocks(out, width, tabWidth);
	if (cfg.packLongLists !== false) out = packLongCommaLists(out, width, tabWidth);
	if (cfg.packConditions !== false) out = packConditions(out, width, tabWidth);
	return out;
}

// ---------------------------------------------------------------------------
// 换行符归一：核心只认 \n
// sql-formatter 会把块注释内容原样带出 —— CRLF 文档里注释正文的 \r 就这样活到输出里，
// 而后面每一环（toTabs / joinShortLists / reformatDdl）都按 \n 切分再 join，
// 于是输出成了「SQL 行只有 \n、注释行还带 \r」的混合换行。
// 扩展按文档换行符回写时做 \n → \r\n，这些注释行就变成 \r\r\n；
// 编辑器把孤立的 \r 也当换行，表面现象就是「块注释每行后面凭空多一个空行」，
// 而且每保存一次多一层 —— 空行越滚越多。故入口与出口各归一次，核心对外只产出 \n。
// ---------------------------------------------------------------------------
function normalizeEol(text) {
	return text.replace(/\r\n?/g, '\n');
}

// 按文档换行符回写：先归一到 \n 再拼，避免把残留的 \r 拼成 \r\r\n
function toEol(text, eol) {
	const lf = normalizeEol(text);
	return eol === '\r\n' ? lf.replace(/\n/g, '\r\n') : lf;
}

function formatSql(text, cfg, tabWidth) {
	const guarded = protectParams(normalizeEol(text));
	let formatted;
	try {
		formatted = formatDialect(guarded.text, {
			dialect: buildDialect(),
			keywordCase: cfg.keywordCase,
			commaPosition: 'before',
			useTabs: false,
			tabWidth,
			expressionWidth: cfg.expressionWidth,
			linesBetweenQueries: cfg.linesBetweenQueries,
			logicalOperatorNewline: cfg.logicalOperatorNewline,
			paramTypes: { custom: [{ regex: PARAM_REGEX }] },
		});
	} catch (e) {
		// 报错正文里会带出错片段，里面可能是占位标记 —— 换回原文再交给 describeFormatError
		if (e && typeof e.message === 'string') e.message = restoreParams(e.message, guarded.marks);
		throw e;
	}
	// 行尾注释后面多出来的空行先吃掉（见 collapseCommaCommentGaps），再折算 tab 缩进
	const tabbed = toTabs(collapseCommaCommentGaps(formatted), tabWidth);
	const merged = joinShortLists(tabbed, cfg.expressionWidth);
	const windowed = inlineWindowSpecs(merged, cfg.expressionWidth);
	// 结构缩进（可选）：flat = 现状；nested / nested-on 见 applyStructureIndent
	const indented = applyStructureIndent(windowed, cfg.indentMode || 'flat');
	// 换行策略：短括号块合行 → 长逗号列表打包 → 条件同类合行（必须在 reformatDdl 之后，行宽才准）
	const wrapped = applyWrapRules(reformatDdl(indented), cfg, tabWidth);
	return restoreParams(normalizeEol(wrapped), guarded.marks);
}

// ---------------------------------------------------------------------------
// 排版失败时的报错翻译：sql-formatter v13 抛的是 nearley 解析器原文 ——
// 第一行有用（`Parse error: Unexpected "'abc" at line 1 column 8`），
// 后面跟着几百行「我期望看到哪些 token」，直接甩给用户没意义。
// 这里只取第一行并拆出行列号，供诊断波浪线与提示定位。
// ---------------------------------------------------------------------------
function describeFormatError(err) {
	const raw = err && err.message ? String(err.message) : String(err);
	const firstLine = raw.split('\n')[0].trim();
	const loc = raw.match(/at line (\d+) column (\d+)/i);
	const message = firstLine.replace(/\s*at line \d+ column \d+\s*$/i, '').trim() || firstLine;
	return {
		message,
		line: loc ? Number(loc[1]) : null,
		column: loc ? Number(loc[2]) : null,
	};
}

module.exports = {
	formatSql,
	findStatements,
	// 换行符工具：extension.js 回写用 toEol，测试用 normalizeEol（核心对外只产出 LF）
	normalizeEol,
	toEol,
	// 排版失败时把解析器原文收敛成「一句话 + 行列号」（扩展拿去弹提示、画诊断）
	describeFormatError,
	// 补进方言函数表的 ADB/DataWorks 函数名；测试据此断言「紧贴括号」行为，避免名单两处维护
	EXTRA_FUNCTION_NAMES,
	// 结构缩进：indentMode 的三个取值由它实现，测试据此逐步比对
	applyStructureIndent,
	// 供测试脚本逐步排查内部环节
	_internals: {
		formatDialect,
		buildDialect,
		toTabs,
		joinShortLists,
		squeeze,
		splitTopLevel,
		matchParen,
		splitOptionLines,
		formatCreateTable,
		reformatDdl,
		inlineWindowSpecs,
		flattenSpec,
		alignColumnKeywords,
		alignOptionHeads,
		columnCells,
		maskLiterals,
		normalizeEol,
		toEol,
		collapseCommaCommentGaps,
		hasTrailingLineComment,
		applyStructureIndent,
		startsInLiteral,
		topLevelOnIndex,
		describeFormatError,
		lineWidth,
		createTableFlags,
		hasCommentOutsideQuote,
		packLongCommaLists,
		collapseShortBlocks,
		packConditions,
		applyWrapRules,
	},
};
