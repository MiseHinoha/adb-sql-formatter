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
let docSeq = 0;
class FakeDocument {
	constructor(text, languageId = 'sql') {
		this.languageId = languageId;
		// 每个文档一个独立 uri：保存状态、诊断集合都按 uri 索引，共用 uri 会让用例互相串味
		const id = ++docSeq;
		this.uri = { scheme: 'file', fsPath: path.resolve('mock.sql'), toString: () => 'file:///mock' + id + '.sql' };
		this._text = text;
		this._lines = text.split('\n');
		this.version = 1;
	}
	applyText(text) {
		this._text = text;
		this._lines = text.split('\n');
		this.version++;
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
const saveHandlers = [];
const saveCompleteHandlers = [];
const configHandlers = [];
const commandHandlers = new Map();
const contexts = new Map();
const warnCalls = [];
const infoCalls = [];
const stateUpdates = [];
let infoResponse = undefined;
const configUpdates = [];
let warnResponse = undefined;
let saveCalls = 0;
const diagnosticsMap = new Map();
const settings = {
	formatOnSave: true, // 用户显式打开（扩展默认是关的）
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
		// 语言级覆盖（[sql] 段里的 editor.*）会带 section 前缀查，桩里同样支持
		getConfiguration: (section, scope) => ({
			get: (k, d) => {
				const key = section ? section + '.' + k : k;
				if (key in settings) return settings[key];
				return k in settings ? settings[k] : d;
			},
			// 诊断用：inspect 返回语言级覆盖值，update 记录被写回的目标
			inspect: (k) => settings['inspect.' + k] || { defaultValue: undefined },
			update: (k, value, target, overrideInLanguage) => {
				settings[k] = value; // 桩里同步生效，模拟 VS Code 真写设置
				configUpdates.push({
					section,
					languageId: scope && scope.languageId,
					key: k,
					value,
					target,
					overrideInLanguage,
				});
				return Promise.resolve();
			},
		}),
		onDidOpenTextDocument: () => ({ dispose() {} }),
		onDidChangeTextDocument: () => ({ dispose() {} }),
		onDidSaveTextDocument: (handler) => {
			saveCompleteHandlers.push(handler);
			return { dispose() {} };
		},
		onDidCloseTextDocument: () => ({ dispose() {} }),
		onWillSaveTextDocument: (handler) => {
			saveHandlers.push(handler);
			return { dispose() {} };
		},
		onDidChangeConfiguration: (handler) => {
			configHandlers.push(handler);
			return { dispose() {} };
		},
	},
	window: {
		activeTextEditor: null,
		visibleTextEditors: [],
		showWarningMessage: (message, ...actions) => {
			warnCalls.push({ message, actions });
			return Promise.resolve(warnResponse);
		},
		showInformationMessage: (message, ...actions) => {
			infoCalls.push({ message, actions });
			return Promise.resolve(infoResponse);
		},
	},
	commands: {
		registerCommand: (id, handler) => {
			commandHandlers.set(id, handler);
			return { dispose() {} };
		},
		executeCommand: (id, ...args) => {
			if (id === 'setContext') {
				contexts.set(args[0], args[1]);
				return Promise.resolve();
			}
			if (id === 'workbench.action.files.save') {
				saveCalls++;
				return Promise.resolve();
			}
			const handler = commandHandlers.get(id);
			return handler ? Promise.resolve(handler()) : Promise.resolve(undefined);
		},
	},
	ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
	TextDocumentSaveReason: { Manual: 1, AfterDelay: 2, FocusOut: 3 },
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
		registerDocumentRangeFormattingEditProvider: (sel, p) => {
			registered.rangeProvider = p;
			return { dispose() {} };
		},
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

// 10. Ctrl+S 保存即格式化：不给编辑器配 formatOnSave / defaultFormatter 也要生效
async function runSaveTests() {
	const handlerFor = () => {
		saveHandlers.length = 0;
		ext.activate({ subscriptions: [] });
		return saveHandlers[saveHandlers.length - 1];
	};
	const saveEdits = async (document) => {
		let promise = null;
		handlerFor()({ document, waitUntil: (p) => (promise = p) });
		return promise ? await promise : null;
	};

	const plain = new FakeDocument('select a,b from t');
	let edits = await saveEdits(plain);
	check(
		'Ctrl+S 会先格式化（编辑器 formatOnSave 关着也算）',
		Array.isArray(edits) && /,\s*b/.test(edits[0].newText),
		edits ? '' : '无 edits'
	);
	check(
		'保存时的输出与「格式化文档」命令一致',
		!!edits &&
			edits[0].newText ===
				registered.formattingProvider.provideDocumentFormattingEdits(plain, { tabSize: 4 })[0].newText
	);

	// 编辑器自己会格式化时不重复插手（同一次保存里两次全文替换会互相踩）
	settings['editor.formatOnSave'] = true;
	settings['editor.defaultFormatter'] = 'YipTszkwan.adb-sql-formatter';
	check('VS Code 自己会格式化时不重复插手', (await saveEdits(new FakeDocument('select a,b from t'))) === null);
	// 指错 ID（扩展不存在）时本扩展接管：这正是「按 Ctrl+S 没反应」的现场配置
	delete settings['editor.defaultFormatter'];
	settings['editor.defaultFormatter'] = 'misehino.adb-sql-formatter';
	check(
		'默认格式化程序指向不存在的扩展时本扩展接手',
		!!(await saveEdits(new FakeDocument('select a,b from t')))
	);
	// 指向另一个真实装着的扩展：让它去格式化，避免同一次保存里两个全文替换互踩
	vscodeStub.extensions = { getExtension: (id) => (id === 'esbenp.prettier-vscode' ? {} : null) };
	settings['editor.defaultFormatter'] = 'esbenp.prettier-vscode';
	check('默认格式化程序是别的扩展时不插手', (await saveEdits(new FakeDocument('select a,b from t'))) === null);
	delete settings['editor.formatOnSave'];
	delete settings['editor.defaultFormatter'];

	settings.formatOnSave = false;
	check('adbSqlFormatter.formatOnSave=false 时不插手', (await saveEdits(new FakeDocument('select a,b from t'))) === null);
	settings.formatOnSave = true;

	check('非 sql 语言不插手', (await saveEdits(new FakeDocument('select a,b from t', 'plaintext'))) === null);

	// tabSize 跟随可见编辑器：tabSize=2 时逗号行必须有缩进（1.5.0 修的 bug）
	const doc2 = new FakeDocument('select a, b, c from t');
	vscodeStub.window.visibleTextEditors = [{ document: doc2, options: { tabSize: 2, insertSpaces: true } }];
	edits = await saveEdits(doc2);
	check(
		'tabSize=2 时逗号行有缩进',
		!!edits && /\n\ta\n\t, b\n\t, c\n/.test(edits[0].newText),
		edits ? JSON.stringify(edits[0].newText) : '无 edits'
	);
	vscodeStub.window.visibleTextEditors = [];

	// 自动保存（AfterDelay）不插手：与 VS Code 自带 formatOnSave 一致
	{
		const handler = handlerFor();
		let captured = 'none';
		handler({
			document: new FakeDocument('select a,b from t'),
			reason: vscodeStub.TextDocumentSaveReason.AfterDelay,
			waitUntil: () => (captured = 'edits'),
		});
		check('自动保存不格式化', captured === 'none', captured);
	}

	// CRLF 文档：全文替换必须按 CRLF 回写，否则保存即格式化会把整篇文件的换行符换掉
	const crlfDoc = new FakeDocument('select a,b from t\r\nwhere a = 1\r\n');
	edits = await saveEdits(crlfDoc);
	check(
		'CRLF 文档回写仍是 CRLF',
		!!edits && !/[^\r]\n/.test(edits[0].newText) && /\r\n/.test(edits[0].newText),
		edits ? JSON.stringify(edits[0].newText) : '无 edits'
	);
	const lfDoc = new FakeDocument('select a,b from t\nwhere a = 1\n');
	edits = await saveEdits(lfDoc);
	check('LF 文档不会被改成 CRLF', !!edits && !/\r/.test(edits[0].newText));

	// ---- Ctrl+S 命令：文件没改动时也要格式化并保存 ----
	const fakeEditor = (doc) => ({
		document: doc,
		edit: (cb) => {
			const ops = [];
			cb({
				replace: (range, text) =>
					ops.push({ start: doc.offsetAt(range.start), end: doc.offsetAt(range.end), text }),
			});
			let next = doc.getText();
			ops.sort((a, b) => b.start - a.start).forEach((op) => {
				next = next.slice(0, op.start) + op.text + next.slice(op.end);
			});
			doc.applyText(next);
			return Promise.resolve(true);
		},
	});

	const clean = new FakeDocument('select a, b, c from t');
	vscodeStub.window.activeTextEditor = fakeEditor(clean);
	saveCalls = 0;
	await vscodeStub.commands.executeCommand('adbSqlFormatter.formatAndSave');
	check(
		'Ctrl+S 命令：没改动的文件也会被格式化',
		/\n\t, b\n\t, c\n/.test(clean.getText()),
		JSON.stringify(clean.getText())
	);
	check('Ctrl+S 命令：格式化后确实调了保存', saveCalls === 1, '调用 ' + saveCalls + ' 次');
	check('Ctrl+S 命令：随后的保存不会重复格式化', (await saveEdits(clean)) === null);

	// 手动命令不看保存开关：开关关着时它照样格式化（等同 Shift+Alt+F + 保存）
	settings.formatOnSave = false;
	{
		const manualDoc = new FakeDocument('select a, b, c from t');
		vscodeStub.window.activeTextEditor = fakeEditor(manualDoc);
		await vscodeStub.commands.executeCommand('adbSqlFormatter.formatAndSave');
		check(
			'保存开关关着时，手动「格式化并保存」仍会格式化',
			/\n\t, b\n\t, c\n/.test(manualDoc.getText()),
			JSON.stringify(manualDoc.getText())
		);
	}
	settings.formatOnSave = true;

	vscodeStub.window.activeTextEditor = undefined;
	saveCalls = 0;
	await vscodeStub.commands.executeCommand('adbSqlFormatter.formatAndSave');
	check('Ctrl+S 命令：没有活动编辑器时仍然保存', saveCalls === 1, '调用 ' + saveCalls + ' 次');

	// ---- 诊断：editor.defaultFormatter 指向没装的扩展 ----
	const ctx = { subscriptions: [], globalState: { get: () => false, update: () => {} } };
	settings['inspect.defaultFormatter'] = {
		defaultValue: undefined,
		globalLanguageValue: 'misehino.adb-sql-formatter',
	};
	warnCalls.length = 0;
	configUpdates.length = 0;
	warnResponse = vscodeStub.l10n.t('Fix the setting'); // 取当前语言包下「修正设置」按钮的文案
	ext.activate(ctx);
	await new Promise((r) => setImmediate(r));
	check(
		'配置里的格式化程序不存在时给出提示',
		warnCalls.length === 1 && /misehino\.adb-sql-formatter/.test(warnCalls[0].message),
		warnCalls.length ? warnCalls[0].message : '没有提示'
	);
	check(
		'点「修正设置」写回真实扩展 ID',
		configUpdates.every(
			(u) => u.value === 'YipTszkwan.adb-sql-formatter' && u.overrideInLanguage === true
		) && configUpdates.length > 0,
		JSON.stringify(configUpdates)
	);
	check(
		'出问题的语言一次全改（sql + mysql）',
		new Set(configUpdates.map((u) => u.languageId)).size === 2,
		JSON.stringify(configUpdates.map((u) => u.languageId))
	);

	settings['inspect.defaultFormatter'] = {
		defaultValue: undefined,
		globalLanguageValue: 'esbenp.prettier-vscode',
	};
	warnCalls.length = 0;
	vscodeStub.extensions = { getExtension: (id) => (id === 'esbenp.prettier-vscode' ? {} : null) };
	ext.activate(ctx);
	await new Promise((r) => setImmediate(r));
	check('配的是真实存在的扩展时不提示', warnCalls.length === 0, '提示 ' + warnCalls.length + ' 次');
	delete settings['inspect.defaultFormatter'];
	vscodeStub.extensions = { getExtension: () => null };

	// ---- Ctrl/Cmd+S 接管的开关（用户可关；换键走键位设置） ----
	contexts.clear();
	settings.takeOverSaveKey = true;
	ext.activate(ctx);
	await new Promise((r) => setImmediate(r));
	check(
		'默认接管 Ctrl/Cmd+S',
		contexts.get('adbSqlFormatter.takeOverSaveKey') === true,
		JSON.stringify([...contexts])
	);
	contexts.clear();
	settings.takeOverSaveKey = false;
	ext.activate(ctx);
	await new Promise((r) => setImmediate(r));
	check(
		'关掉后不再占 Ctrl/Cmd+S',
		contexts.get('adbSqlFormatter.takeOverSaveKey') === false,
		JSON.stringify([...contexts])
	);
	settings.takeOverSaveKey = true;
	ext.activate(ctx);
	await new Promise((r) => setImmediate(r));

	const manifest = require('./package.json');
	const ctrlBindings = (manifest.contributes.keybindings || []).filter(
		(kb) => kb.command === 'adbSqlFormatter.formatAndSave'
	);
	check(
		'manifest 的 Ctrl/Cmd+S 绑定挂着这个开关',
		ctrlBindings.length === 2 &&
			ctrlBindings.every(
				(kb) =>
					kb.key === 'ctrl+s' &&
					kb.mac === 'cmd+s' &&
					kb.command === 'adbSqlFormatter.formatAndSave' &&
					/adbSqlFormatter\.takeOverSaveKey/.test(kb.when)
			),
		JSON.stringify(manifest.contributes.keybindings)
	);

	// ---- 默认不改用户文件（opt-in）+ 只问一次 ----
	const ctxWith = (asked) => ({
		subscriptions: [],
		globalState: {
			get: () => asked,
			update: (k, v) => {
				stateUpdates.push([k, v]);
				return Promise.resolve();
			},
		},
	});
	const tick = () => new Promise((r) => setImmediate(r));

	delete settings.formatOnSave; // 用户没表过态
	delete settings['inspect.formatOnSave'];
	contexts.clear();
	stateUpdates.length = 0;
	infoCalls.length = 0;
	infoResponse = undefined; // 直接关掉提示
	ext.activate(ctxWith(false));
	await tick();
	check(
		'没表态时默认不接管 Ctrl/Cmd+S',
		contexts.get('adbSqlFormatter.takeOverSaveKey') === false,
		JSON.stringify([...contexts])
	);
	check(
		'问一次「要不要保存即格式化」',
		infoCalls.length === 1 && infoCalls[0].actions.length === 2,
		JSON.stringify(infoCalls)
	);
	check(
		'问之前先记「已问过」（避免反复打扰）',
		stateUpdates.some(([k, v]) => k === 'formatOnSaveOffered' && v === true),
		JSON.stringify(stateUpdates)
	);

	infoCalls.length = 0;
	ext.activate(ctxWith(true)); // 下次开窗口：已问过
	await tick();
	check('已问过就不再问', infoCalls.length === 0, '问了 ' + infoCalls.length + ' 次');

	infoCalls.length = 0;
	settings['inspect.formatOnSave'] = { defaultValue: false, globalValue: false };
	ext.activate(ctxWith(false));
	await tick();
	check('用户已明确表态（关了）就不再问', infoCalls.length === 0, '问了 ' + infoCalls.length + ' 次');
	delete settings['inspect.formatOnSave'];

	configUpdates.length = 0;
	contexts.clear();
	infoResponse = vscodeStub.l10n.t('Enable on save');
	ext.activate(ctxWith(false));
	await tick();
	check(
		'点「开启」写入 adbSqlFormatter.formatOnSave=true',
		configUpdates.some((u) => u.section === 'adbSqlFormatter' && u.key === 'formatOnSave' && u.value === true),
		JSON.stringify(configUpdates)
	);
	check(
		'开启后立刻恢复接管 Ctrl/Cmd+S',
		contexts.get('adbSqlFormatter.takeOverSaveKey') === true,
		JSON.stringify([...contexts])
	);
	delete settings.formatOnSave;
	infoResponse = undefined;

	// ---- 我们那层关了、但编辑器自带的 editor.formatOnSave 还开着 → 提示一次并允许一起关 ----
	// 用户设置：扩展自己的开关 = false（globalValue），而 [sql]/[mysql] 的 editor.formatOnSave = true
	settings['inspect.formatOnSave'] = { defaultValue: false, globalValue: false, globalLanguageValue: true };
	settings['inspect.defaultFormatter'] = {
		defaultValue: undefined,
		globalLanguageValue: 'YipTszkwan.adb-sql-formatter',
	};
	infoCalls.length = 0;
	stateUpdates.length = 0;
	configUpdates.length = 0;
	contexts.clear();
	infoResponse = undefined; // 先直接关掉提示
	ext.activate(ctxWith(false));
	await tick();
	check(
		'检测到「编辑器自己的 formatOnSave 还开着」并提示',
		infoCalls.length === 1 && /editor\.formatOnSave/.test(infoCalls[0].message),
		JSON.stringify(infoCalls)
	);
	check(
		'提示只记一次（不反复打扰）',
		stateUpdates.some(([k, v]) => k === 'editorFormatOnSaveNoticeShown' && v === true),
		JSON.stringify(stateUpdates)
	);

	infoResponse = vscodeStub.l10n.t('Turn it off there too');
	configUpdates.length = 0;
	infoCalls.length = 0;
	ext.activate(ctxWith(false));
	await tick();
	const off = configUpdates.filter((u) => u.section === 'editor' && u.key === 'formatOnSave');
	check(
		'点「也关掉」把 sql / mysql 的编辑器开关都写成 false',
		off.length === 2 && off.every((u) => u.value === false && u.overrideInLanguage === true),
		JSON.stringify(off)
	);
	check(
		'两个语言都改到（不是只改一个）',
		new Set(off.map((u) => u.languageId)).size === 2,
		JSON.stringify(off.map((u) => u.languageId))
	);
	// 我们那层开着时不该再提示编辑器那个开关
	settings.formatOnSave = true;
	infoCalls.length = 0;
	ext.activate(ctxWith(false));
	await tick();
	check(
		'我们那层开着时不提示编辑器开关',
		!infoCalls.some((c) => /editor\.formatOnSave/.test(c.message)),
		JSON.stringify(infoCalls)
	);
	delete settings.formatOnSave;
	infoResponse = undefined;

	// ---- 唯一开关：管的是「保存时自动格式化」，手动入口永远可用 ----
	const docP = new FakeDocument('select a, b, c from t');
	delete settings.formatOnSave; // 本扩展开关 = 关
	ext.activate(ctxWith(false));
	await tick();

	let out = registered.formattingProvider.provideDocumentFormattingEdits(docP, { tabSize: 4 });
	check(
		'开关关着：编辑器那套手动入口（Shift+Alt+F / 右键「格式化文档」）照常排版',
		Array.isArray(out) && out.length > 0 && /\n\t, b\n/.test(out[0].newText),
		JSON.stringify(out && out[0] && out[0].newText)
	);
	out = registered.rangeProvider.provideDocumentRangeFormattingEdits(
		docP,
		{ start: docP.positionAt(0), end: docP.positionAt(10) },
		{ tabSize: 4 }
	);
	check('开关关着：选区排版也照常', Array.isArray(out) && out.length > 0, JSON.stringify(out));

	// 手动命令（命令面板 / 右键菜单项）
	vscodeStub.window.activeTextEditor = fakeEditor(docP);
	await vscodeStub.commands.executeCommand('adbSqlFormatter.formatDocument');
	check(
		'开关关着：手动「格式化文档」命令照样排版',
		/\n\t, b\n\t, c\n/.test(docP.getText()),
		JSON.stringify(docP.getText())
	);
	vscodeStub.window.activeTextEditor = undefined;

	// 开关被关掉那一刻：自动把编辑器自带的 formatOnSave 也对齐关掉（并提示、可撤销）
	settings['inspect.formatOnSave'] = { defaultValue: false, globalLanguageValue: true };
	configUpdates.length = 0;
	infoCalls.length = 0;
	infoResponse = undefined;
	configHandlers[configHandlers.length - 1]({ affectsConfiguration: () => true });
	await tick();
	const aligned = configUpdates.filter((u) => u.section === 'editor' && u.key === 'formatOnSave');
	check(
		'开关关掉后：编辑器自带的 formatOnSave 被对齐关掉（这是「保存只保存」的保证）',
		aligned.length === 2 && aligned.every((u) => u.value === false),
		JSON.stringify(aligned)
	);
	check(
		'并告知用户（带可撤销入口）',
		infoCalls.some((c) => /editor\.formatOnSave/.test(c.message) && c.actions.includes('Undo')),
		JSON.stringify(infoCalls)
	);
	infoResponse = vscodeStub.l10n.t('Undo');
	configUpdates.length = 0;
	settings['inspect.formatOnSave'] = { defaultValue: false, globalLanguageValue: true };
	configHandlers[configHandlers.length - 1]({ affectsConfiguration: () => true });
	await tick();
	const undoWrites = configUpdates.filter(
		(u) => u.section === 'editor' && u.key === 'formatOnSave' && u.value === true
	);
	check('点「撤销」把编辑器开关写回 true', undoWrites.length === 2, JSON.stringify(configUpdates));
	delete settings['inspect.formatOnSave'];
	infoResponse = undefined;

	// 开关打开：编辑器那套入口照常（输出一致）
	settings.formatOnSave = true;
	ext.activate(ctxWith(false));
	await tick();
	out = registered.formattingProvider.provideDocumentFormattingEdits(docP, { tabSize: 4 });
	check(
		'开关打开：编辑器那套入口同样产出',
		Array.isArray(out) && out.length > 0 && /\n\t, b\n/.test(out[0].newText),
		JSON.stringify(out && out[0] && out[0].newText)
	);
	delete settings.formatOnSave;

	// manifest：不再接管 Shift+Alt+F（标准入口本来就能用），只保留 Ctrl/Cmd+S 两条
	{
		const pkg = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'package.json'), 'utf8'));
		const cont = pkg.contributes;
		check(
			'manifest：声明了 formatDocument 命令（命令面板可用）',
			cont.commands.some((c) => c.command === 'adbSqlFormatter.formatDocument')
		);
		check(
			'manifest：没有接管 Shift+Alt+F（手动排版回到编辑器标准入口）',
			cont.keybindings.every((k) => k.key !== 'shift+alt+f'),
			JSON.stringify(cont.keybindings.map((k) => k.key))
		);
		check(
			'manifest：keybindings 只留 Ctrl/Cmd+S 两条',
			cont.keybindings.length === 2 &&
				cont.keybindings.every((k) => k.command === 'adbSqlFormatter.formatAndSave'),
			JSON.stringify(cont.keybindings)
		);
		const menu = (cont.menus && cont.menus['editor/context']) || [];
		check(
			'manifest：右键菜单项按语言限定（不挂开关条件）',
			menu.length === 1 && menu[0].when === 'editorLangId == sql || editorLangId == mysql',
			JSON.stringify(menu)
		);
	}

	console.log(fail ? `\n${fail} 个用例失败` : '\n全部用例通过');
	process.exit(fail ? 1 : 0);
}

runSaveTests();
