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
// DataWorks 调度占位符 ${bizdate} / ${yesterday} 等，按自定义参数识别避免被拆坏
const PARAM_REGEX = String.raw`\$\{[a-zA-Z0-9_.]+\}`;

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
	const headMatch = statement.match(/^create\s+table\s+(if\s+not\s+exists\s+)?([`0-9a-zA-Z_.]+)\s*/i);
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

function formatSql(text, cfg, tabWidth) {
	const formatted = formatDialect(text, {
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
	const tabbed = toTabs(formatted, tabWidth);
	const merged = joinShortLists(tabbed, cfg.expressionWidth);
	const windowed = inlineWindowSpecs(merged, cfg.expressionWidth);
	return reformatDdl(windowed);
}

module.exports = {
	formatSql,
	findStatements,
	// 补进方言函数表的 ADB/DataWorks 函数名；测试据此断言「紧贴括号」行为，避免名单两处维护
	EXTRA_FUNCTION_NAMES,
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
	},
};
