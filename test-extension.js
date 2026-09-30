// 用最小 vscode API 桩，验证诊断接线与 quick fix 插入点：node test-extension.js
const path = require('path');
const Module = require('module');

// ---------- 位置/文档桩 ----------
class Position {
	constructor(line, character) {
		this.line = line;
		this.character = character;
	}
}
class Range {
	constructor(start, end) {
		this.start = start;
		this.end = end;
	}
}
class FakeDocument {
	constructor(text, languageId = 'sql') {
		this.languageId = languageId;
		this.uri = { scheme: 'file', fsPath: path.resolve('mock.sql'), toString: () => 'file:///mock.sql' };
		this._text = text;
		this._lines = text.split('\n');
	}
	getText() {
		return this._text;
	}
	lineOffsetAt(line) {
		let off = 0;
		for (let i = 0; i < line; i++) off += this._lines[i].length + 1;
		return off;
	}
	positionAt(offset) {
		let line = 0;
		let acc = 0;
		while (line < this._lines.length - 1 && acc + this._lines[line].length + 1 <= offset) {
			acc += this._lines[line].length + 1;
			line++;
		}
		return new Position(line, offset - acc);
	}
	offsetAt(pos) {
		return this.lineOffsetAt(pos.line) + pos.character;
	}
}

// ---------- vscode 桩 ----------
const registered = { codeActionProvider: null, formattingProvider: null };
const diagnosticsMap = new Map();
const settings = {
	keywordCase: 'lower',
	expressionWidth: 100,
	logicalOperatorNewline: 'before',
	linesBetweenQueries: 1,
	requireSemicolonBetweenStatements: true,
	missingSemicolonSeverity: 'warning',
};

const vscodeStub = {
	Position,
	Range,
	// 模拟中文显示语言：t() 查 l10n/bundle.l10n.zh-cn.json，键即代码里的英文源文
	l10n: {
		t: (msg) => {
			const bundle = require('./l10n/bundle.l10n.zh-cn.json');
			return Object.prototype.hasOwnProperty.call(bundle, msg) ? bundle[msg] : msg;
		},
	},
	Diagnostic: class {
		constructor(range, message, severity) {
			this.range = range;
			this.message = message;
			this.severity = severity;
		}
	},
	DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
	CodeAction: class {
		constructor(title, kind) {
			this.title = title;
			this.kind = kind;
		}
	},
	CodeActionKind: { QuickFix: { value: 'quickfix' } },
	WorkspaceEdit: class {
		constructor() {
			this.edits = [];
		}
		insert(uri, pos, text) {
			this.edits.push({ pos, text });
		}
	},
	Disposable: class {
		dispose() {}
	},
	TextEdit: {
		replace: (range, newText) => ({ range, newText }),
		insert: (pos, newText) => ({ range: new Range(pos, pos), newText }),
	},
	workspace: {
		textDocuments: [],
		getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d) }),
		onDidOpenTextDocument: () => ({ dispose() {} }),
		onDidChangeTextDocument: () => ({ dispose() {} }),
		onDidSaveTextDocument: () => ({ dispose() {} }),
		onDidCloseTextDocument: () => ({ dispose() {} }),
		onDidChangeConfiguration: () => ({ dispose() {} }),
	},
	languages: {
		createDiagnosticCollection: () => ({
			set: (uri, diags) => diagnosticsMap.set(String(uri), diags),
			delete: (uri) => diagnosticsMap.delete(String(uri)),
			dispose() {},
		}),
		registerDocumentFormattingEditProvider: (sel, p) => {
			registered.formattingProvider = p;
			return { dispose() {} };
		},
		registerDocumentRangeFormattingEditProvider: () => ({ dispose() {} }),
		registerCodeActionsProvider: (sel, p) => {
			registered.codeActionProvider = p;
			return { dispose() {} };
		},
	},
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
	if (request === 'vscode') return vscodeStub;
	return origLoad.apply(this, arguments);
};

const ext = require('./extension');
ext.activate({ subscriptions: [] });

// ---------- 用例 ----------
let fail = 0;
function check(name, cond, extra = '') {
	if (!cond) fail++;
	console.log(`${cond ? '  OK  ' : ' FAIL '} ${name}${extra ? '  ' + extra : ''}`);
}

// 1. 单语句文件：不产生任何诊断
const docSingle = new FakeDocument("create table t (a int) comment 'x'");
vscodeStub.workspace.textDocuments = [docSingle];
ext.activate({ subscriptions: [] });
check('单语句文件不报缺分号', (diagnosticsMap.get(String(docSingle.uri)) || []).length === 0);

// 2. 多语句缺分号：报一条 warning，位置落在第二条语句关键字上
const text2 = "create table t (a int) comment 'x'\ninsert into t values (1)";
const doc2 = new FakeDocument(text2);
vscodeStub.workspace.textDocuments = [doc2];
ext.activate({ subscriptions: [] });
const diags2 = diagnosticsMap.get(String(doc2.uri)) || [];
check('多语句缺分号报 1 条', diags2.length === 1, `实际 ${diags2.length}`);
check('级别为 Warning', diags2[0] && diags2[0].severity === vscodeStub.DiagnosticSeverity.Warning);
check(
	'波浪线落在 insert 上',
	diags2[0] && text2.slice(doc2.offsetAt(diags2[0].range.start), doc2.offsetAt(diags2[0].range.end)) === 'insert',
	diags2[0] ? `行${diags2[0].range.start.line + 1}` : ''
);

// 3. 多语句已带分号：不报
const doc3 = new FakeDocument("create table t (a int) comment 'x';\ninsert into t values (1)");
vscodeStub.workspace.textDocuments = [doc3];
ext.activate({ subscriptions: [] });
check('带分号不报', (diagnosticsMap.get(String(doc3.uri)) || []).length === 0);

// 4. insert ... select 是同一句：不报
const doc4 = new FakeDocument('insert into t (a, b)\nselect a, b from u');
vscodeStub.workspace.textDocuments = [doc4];
ext.activate({ subscriptions: [] });
check('insert...select 不误报', (diagnosticsMap.get(String(doc4.uri)) || []).length === 0);

// 5. quick fix 插入点与文本
const actions = registered.codeActionProvider.provideCodeActions(doc2, diags2[0].range, {
	diagnostics: [diags2[0]],
});
check('提供两个 quick fix', Array.isArray(actions) && actions.length === 2, actions ? `${actions.length}` : '无');
if (actions && actions.length) {
	const insertPos = actions[0].edit.edits[0].pos;
	const offset = doc2.offsetAt(insertPos);
	check(
		'插入点紧贴上一条语句末尾（非空白）',
		/\S/.test(text2[offset - 1]) && /\s/.test(text2[offset]),
		JSON.stringify(text2.slice(Math.max(0, offset - 12), offset + 8))
	);
	const applied = text2.slice(0, offset) + ';' + text2.slice(offset);
	check('应用后两条语句各自终结', /'x';\ninsert/.test(applied), JSON.stringify(applied.split('\n')[0]));
	const spaced = actions[1].edit.edits[0].text;
	check('第二个选项带换行', spaced === ';\n');
}

// 6. 关开关后清空诊断
settings.requireSemicolonBetweenStatements = false;
vscodeStub.workspace.textDocuments = [doc2];
ext.activate({ subscriptions: [] });
check('关掉检查后不报', (diagnosticsMap.get(String(doc2.uri)) || []).length === 0);
settings.requireSemicolonBetweenStatements = true;

// 7. 提升为 error 生效
settings.missingSemicolonSeverity = 'error';
vscodeStub.workspace.textDocuments = [doc2];
ext.activate({ subscriptions: [] });
const diagsErr = diagnosticsMap.get(String(doc2.uri)) || [];
check('severity=error 时标红', diagsErr[0] && diagsErr[0].severity === vscodeStub.DiagnosticSeverity.Error);
settings.missingSemicolonSeverity = 'warning';

// 8. 格式化链路仍然工作（provider 注册成功且能产出 edits）
const edits = registered.formattingProvider.provideDocumentFormattingEdits(
	new FakeDocument('select a,b from t'),
	{ insertSpaces: false, tabSize: 4 }
);
check('格式化 provider 正常', Array.isArray(edits) && /,\s*b/.test(edits[0].newText), edits ? '' : '无 edits');

// 9. 文案本地化：中文显示语言下走 l10n 语言包；低版本 VSCode（无 vscode.l10n）退回英文源文不崩
check('诊断文案走中文语言包', /上一条语句末尾缺少分号/.test(diags2[0].message));
check(
	'quick fix 标题走中文语言包',
	actions[0].title === '插入分号' && actions[1].title === '插入分号并空一行',
	`${actions[0].title} / ${actions[1].title}`
);
delete vscodeStub.l10n;
vscodeStub.workspace.textDocuments = [doc2];
ext.activate({ subscriptions: [] });
const diagsBare = diagnosticsMap.get(String(doc2.uri)) || [];
const actsBare = registered.codeActionProvider.provideCodeActions(doc2, diagsBare[0] && diagsBare[0].range, {
	diagnostics: diagsBare,
});
check(
	'无 vscode.l10n 时退回英文源文',
	/Missing semicolon/.test(diagsBare[0].message) && actsBare[0].title === 'Insert semicolon',
	actsBare[0].title
);
vscodeStub.l10n = { t: (msg) => msg };

console.log(fail ? `\n${fail} 个用例失败` : '\n全部用例通过');
process.exit(fail ? 1 : 0);
