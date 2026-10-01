const vscode = require('vscode');
const { formatSql, findStatements } = require('./formatter-core');

const EXT_ID = 'YipTszkwan.adb-sql-formatter';
const DIAG_SOURCE = 'ADB SQL Formatter';
const DIAG_CODE = 'missing-semicolon';
const LANGUAGES = ['sql', 'mysql'];
// 「editor.defaultFormatter 指向没装的扩展」提示过就不再提（globalState 里的键）
const FORMATTER_WARNED = 'defaultFormatterWarningShown';
// 「要不要开启保存即格式化」只问一次（可先用 adbSqlFormatter.formatOnSave 表态，表过态就不再问）
const FORMAT_ON_SAVE_ASKED = 'formatOnSaveOffered';
// 「我们自己那层关了、但编辑器自带的 editor.formatOnSave 还开着」只提示一次
const EDITOR_FOS_NOTICED = 'editorFormatOnSaveNoticeShown';
// manifest 里 Ctrl/Cmd+S 那条绑定带 when: adbSqlFormatter.takeOverSaveKey，
// 由设置 adbSqlFormatter.takeOverSaveKey 通过 setContext 开关（VS Code 不允许扩展运行时声明键位，
// 所以「换一个键」只能由用户在键位设置里改本扩展的命令绑定）
const SAVE_KEY_CONTEXT = 'adbSqlFormatter.takeOverSaveKey';

// vscode.l10n 自 1.73 起提供；低版本退回英文源文，因此不把 engines 抬到 1.73 以上。
// 中文文案在 l10n/bundle.l10n.zh-cn.json，键即这里的英文源文。
function t(msg) {
	return vscode.l10n && typeof vscode.l10n.t === 'function' ? vscode.l10n.t(msg) : msg;
}

function getConfig() {
	const c = vscode.workspace.getConfiguration('adbSqlFormatter');
	return {
		keywordCase: c.get('keywordCase', 'lower'),
		expressionWidth: c.get('expressionWidth', 100),
		logicalOperatorNewline: c.get('logicalOperatorNewline', 'before'),
		linesBetweenQueries: c.get('linesBetweenQueries', 1),
		semicolonCheck: c.get('requireSemicolonBetweenStatements', true),
		severity: c.get('missingSemicolonSeverity', 'warning'),
		formatOnSave: c.get('formatOnSave', false),
		takeOverSaveKey: c.get('takeOverSaveKey', true),
	};
}

// 让 manifest 里那条 Ctrl/Cmd+S 绑定跟着设置开关（改设置即时生效，不用重载窗口）。
// 只有「保存即格式化」开着时才接管这个键 —— 否则连 Cmd+S 都不该被动到。
function syncSaveKeyContext() {
	try {
		const cfg = getConfig();
		return Promise.resolve(
			vscode.commands.executeCommand('setContext', SAVE_KEY_CONTEXT, !!(cfg.formatOnSave && cfg.takeOverSaveKey))
		).catch((e) => console.error('[adb-sql-formatter]', e));
	} catch (e) {
		console.error('[adb-sql-formatter]', e);
		return Promise.resolve();
	}
}

// 首次使用提示：默认不碰用户的文件（与 VS Code 自己的约定一致），但那样容易「装了没反应」，
// 所以在用户还没表过态时问一次。globalState 先记再问 —— 宁可少问一次，也不反复打扰。
async function maybeOfferFormatOnSave(context) {
	const store = context && context.globalState;
	if (store && typeof store.get === 'function' && store.get(FORMAT_ON_SAVE_ASKED)) return;
	const cfg = vscode.workspace.getConfiguration('adbSqlFormatter');
	const info = cfg && typeof cfg.inspect === 'function' ? cfg.inspect('formatOnSave') : null;
	const decided =
		info && [info.globalValue, info.workspaceValue, info.workspaceFolderValue].some((v) => v !== undefined);
	if (decided) return;
	if (store && typeof store.update === 'function') await store.update(FORMAT_ON_SAVE_ASKED, true);
	const yes = t('Enable on save');
	const no = t('No thanks');
	const choice = await vscode.window.showInformationMessage(
		t('Format sql / mysql files on save? This extension leaves your files alone until you turn it on.'),
		yes,
		no
	);
	if (choice === yes) {
		await cfg.update('formatOnSave', true, vscode.ConfigurationTarget.Global);
		await syncSaveKeyContext();
	}
}

// 语言级设置的值与它写在哪个作用域（global / workspace / folder）
function languageLevelSetting(languageId, key) {
	const cfg = vscode.workspace.getConfiguration('editor', { languageId });
	if (!cfg || typeof cfg.inspect !== 'function') return null;
	const info = cfg.inspect(key);
	if (!info) return null;
	const targets = (vscode.ConfigurationTarget || {});
	const rows = [
		[info.globalLanguageValue, targets.Global],
		[info.workspaceLanguageValue, targets.Workspace],
		[info.workspaceFolderLanguageValue, targets.WorkspaceFolder],
	];
	const hit = rows.find(([value]) => value !== undefined);
	return hit && hit[1] !== undefined ? { cfg, value: hit[0], target: hit[1] } : null;
}

// 「保存时自动格式化」= adbSqlFormatter.formatOnSave，这是唯一的开关。但编辑器自带的
// editor.formatOnSave 是**另一条路**（VS Code 自己调我们的 provider），运行时拦不住（见 provider 处注释），
// 所以把它与开关**对齐**：开关关着时，[sql] / [mysql] 的 editor.formatOnSave 若是 true 就一起关掉。
// 触发点：① 用户把本扩展开关关掉的那一刻（并告知、可一键撤销）；② 激活时检测到这种组合 → 问一次。
async function alignEditorFormatOnSave(options) {
	const rows = LANGUAGES.map((languageId) => {
		const fos = languageLevelSetting(languageId, 'formatOnSave');
		return fos && fos.value === true ? { languageId, fos } : null;
	}).filter(Boolean);
	if (!rows.length) return false;
	for (const row of rows) {
		await row.fos.cfg.update('formatOnSave', false, row.fos.target, true);
	}
	if (options && options.notify) {
		const undo = t('Undo');
		const choice = await vscode.window.showInformationMessage(
			t(
				"Turned editor.formatOnSave off for {0} too, so saving really only saves. (The editor's own switch is a separate path this extension's switch cannot reach at runtime.)"
			).replace('{0}', rows.map((r) => r.languageId).join(' / ')),
			undo
		);
		if (choice === undo) {
			for (const row of rows) {
				await row.fos.cfg.update('formatOnSave', true, row.fos.target, true);
			}
		}
	}
	return true;
}

// 激活自检：本扩展开关关着、编辑器自己的 formatOnSave 还开着 → 保存照样会被重排（用户会以为「关了没用」）。
// 提示一次，可一键把编辑器那个开关也关掉。
async function checkEditorFormatOnSave(context) {
	if (getConfig().formatOnSave !== false) return;
	const store = context && context.globalState;
	if (store && typeof store.get === 'function' && store.get(EDITOR_FOS_NOTICED)) return;
	const rows = LANGUAGES.filter((languageId) => {
		const fos = languageLevelSetting(languageId, 'formatOnSave');
		if (!fos || fos.value !== true) return false;
		const def = languageLevelSetting(languageId, 'defaultFormatter');
		const id = def && typeof def.value === 'string' ? def.value.toLowerCase() : null;
		// 没配默认格式化程序时 VS Code 会自动用唯一可用的格式化程序，很可能就是我们，所以也算
		return def === null || id === null || id === EXT_ID.toLowerCase();
	});
	if (!rows.length) return;
	if (store && typeof store.update === 'function') await store.update(EDITOR_FOS_NOTICED, true);
	const close = t('Turn it off there too');
	const keep = t('Keep it');
	const choice = await vscode.window.showInformationMessage(
		t(
			"editor.formatOnSave is still on for {0}: VS Code calls this extension's formatter on save, so files are still reformatted even though adbSqlFormatter.formatOnSave is off. Turn the editor setting off as well?"
		).replace('{0}', rows.join(' / ')),
		close,
		keep
	);
	if (choice === close) await alignEditorFormatOnSave({ notify: false });
}


function fullRange(document) {
	return new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
}

// 选区格式化：按选区首行基准缩进整体去 / 回缩进，保证选区内相对层次不变
function dedent(text) {
	const lines = text.split('\n');
	let base = '';
	for (const line of lines) {
		if (line.trim()) {
			base = line.match(/^[ \t]*/)[0];
			break;
		}
	}
	return {
		body: lines.map((l) => (base && l.startsWith(base) ? l.slice(base.length) : l)).join('\n'),
		base,
	};
}

// 文档原本用 CRLF（Windows 侧脚本、DataWorks 常见）就按 CRLF 回写：
// 全文替换用的是 `\n`，不还原的话「保存即格式化」会把整篇文件的换行符换掉，diff 全红。
function eolOf(document) {
	return /\r\n/.test(document.getText()) ? '\r\n' : '\n';
}

function makeEdits(document, range, options) {
	try {
		const cfg = getConfig();
		const tabWidth = options.tabSize || 4;
		const isRange = !!range;

		let source = document.getText();
		let base = '';
		if (isRange) {
			const d = dedent(source);
			source = d.body;
			base = d.base;
		}

		let result = formatSql(source, cfg, tabWidth);
		if (isRange && base) {
			result = result.split('\n').map((l) => (l ? base + l : l)).join('\n');
		}
		if (eolOf(document) === '\r\n') result = result.replace(/\n/g, '\r\n');
		return [vscode.TextEdit.replace(range || fullRange(document), result)];
	} catch (e) {
		// 半截 SQL / 解析失败时不改文档，错误写入输出面板便于排查
		console.error('[adb-sql-formatter]', e);
		return undefined;
	}
}

class AdbSqlFormattingProvider {
	// 手动排版入口（Shift+Alt+F / 右键「格式化文档」/ 命令面板 / 我们自己的命令）走的就是这里，
	// **永远提供排版** —— 保存开关管的是「保存时自动格式化」，不该让手动入口跟着失效。
	// 「关着时保存不排版」由两件事保证：① 我们自己的键位层与保存钩子层按开关停掉；
	// ② 编辑器自带的 editor.formatOnSave 与开关对齐（见 alignEditorFormatOnSave）。
	// 之所以用「对齐设置」而不是在 provider 里拒绝：实测 VS Code 的 formatOnSave 会在扩展收到
	// onWillSaveTextDocument 之前就调用 provider（早 10~50ms），运行时根本分不出这次调用是不是保存。
	provideDocumentFormattingEdits(document, options) {
		return makeEdits(document, null, options);
	}
	provideDocumentRangeFormattingEdits(document, range, options) {
		return makeEdits(document, range, options);
	}
}


// ---------------------------------------------------------------------------
// 保存即格式化（Ctrl+S：先格式化，再落盘）
// 走 save participant（onWillSaveTextDocument）而不是编辑器自己的 formatOnSave：
//   - 不依赖 editor.defaultFormatter 指对扩展 ID（指错时 VS Code 找不到格式化程序，保存变成纯保存）
//   - 不受「同名语言有多个格式化程序」的选择提示影响
//   - 不抢 Ctrl+S 这个键位本身
// 拿到编辑器的 tabSize 才能与「格式化文档」命令输出一致；save participant 不发 options，故兜底自取。
// ---------------------------------------------------------------------------
function indentOptions(document) {
	const editors = (vscode.window && vscode.window.visibleTextEditors) || [];
	const found = editors.find((e) => e.document === document);
	if (found && found.options && found.options.tabSize) {
		return { tabSize: found.options.tabSize, insertSpaces: !!found.options.insertSpaces };
	}
	const c = vscode.workspace.getConfiguration('editor', document);
	return { tabSize: c.get('tabSize', 4), insertSpaces: c.get('insertSpaces', false) };
}

// VS Code 自己会格式化时（formatOnSave 开 + 默认格式化程序是一个真实存在的扩展）不重复插手：
// 同一次保存里两个 save participant 都做全文替换会互相踩。
// 指错 ID（扩展并不存在）时不算 —— 那种配置下 VS Code 根本找不到格式化程序，保存会退化成纯保存，
// 正是本扩展要接手的情形。
function vscodeWillFormatOnSave(document) {
	const c = vscode.workspace.getConfiguration('editor', document);
	if (!c.get('formatOnSave', false)) return false;
	const def = c.get('defaultFormatter', null);
	if (typeof def !== 'string' || !def) return false;
	if (def.toLowerCase() === EXT_ID.toLowerCase()) return true;
	const api = vscode.extensions;
	return !!(api && typeof api.getExtension === 'function' && api.getExtension(def));
}

function formatOnWillSave(event) {
	const document = event.document;
	if (!LANGUAGES.includes(document.languageId)) return;
	// 自动保存（reason = AfterDelay）不格式化 —— 与 VS Code 自带 formatOnSave 的取舍一致，
	// 否则开着自动保存的用户每打几个字整篇就被重排一次，光标乱跳。
	const auto = vscode.TextDocumentSaveReason && vscode.TextDocumentSaveReason.AfterDelay;
	if (auto !== undefined && event.reason === auto) return;
	// 刚才的 Ctrl+S 命令已经格式化到当前版本，这次保存不要再动一遍
	const key = document.uri.toString();
	const doneAt = justFormatted.get(key);
	justFormatted.delete(key);
	if (doneAt === document.version) return;
	if (!getConfig().formatOnSave) return;
	if (vscodeWillFormatOnSave(document)) return;
	const edits = makeEdits(document, null, indentOptions(document));
	if (edits && edits.length) event.waitUntil(Promise.resolve(edits));
}

// ---------------------------------------------------------------------------
// Ctrl+S / Cmd+S：先格式化，再保存
// 为什么不能只靠 save participant：VS Code 的保存路径对「没有改动」的文件会当场返回
// （storedFileWorkingCopy.doSave 里 `if (!options.force && !this.dirty) return`），
// 根本不跑保存参与者 —— 于是刚打开、没编辑过的文件按 Ctrl+S 什么都不会发生，日志里也没有任何痕迹。
// 覆盖这个场景只能自己接住键位：先格式化（把文档变脏），再走正常的保存。
// ---------------------------------------------------------------------------
const FORMAT_AND_SAVE = 'adbSqlFormatter.formatAndSave';
// 自己刚格式化过的 uri → 版本号，避免紧接着的保存再格式化一遍
const justFormatted = new Map();

// 把当前编辑器里的 sql / mysql 文档按本扩展规则重排；返回是否真的改了内容
async function reformatActiveEditor() {
	const editor = vscode.window.activeTextEditor;
	if (!editor || !LANGUAGES.includes(editor.document.languageId)) return false;
	try {
		const edits = makeEdits(editor.document, null, indentOptions(editor.document));
		if (!edits || !edits.length) return false;
		const applied = await editor.edit((builder) => {
			edits.forEach((e) => builder.replace(e.range, e.newText));
		});
		if (applied) justFormatted.set(editor.document.uri.toString(), editor.document.version);
		return !!applied;
	} catch (e) {
		console.error('[adb-sql-formatter]', e);
		return false;
	}
}

const FORMAT_DOCUMENT = 'adbSqlFormatter.formatDocument';

// 手动排版（不保存）。开关关着时本扩展不再向编辑器那套入口提供格式化，
// Shift+Alt+F / 右键菜单由 manifest 绑到这里，保证「手动随时可用」。
async function formatDocument() {
	await reformatActiveEditor();
}

async function formatAndSave() {
	// 手动动作（等同 Shift+Alt+F + 保存），**不看**保存开关：开关只管「保存时自动格式化」那件事
	await reformatActiveEditor();
	// 抢下了保存键就必须保证保存一定发生：格式化失败也要落盘
	await vscode.commands.executeCommand('workbench.action.files.save');
}

// ---------------------------------------------------------------------------
// 诊断：editor.defaultFormatter 指向一个没装的扩展
// VS Code 对这种情况会报 "Extension '{0}' is configured as formatter but not available"，
// 并且整条 formatOnSave 路径都不格式化 —— 这是「按了保存没反应」最常见的成因。
// 本扩展自己能接手，但留着这条坏配置会让 VS Code 那条路径一直是坏的，所以提示一次并提供一键修正。
// ---------------------------------------------------------------------------
function unavailableFormatter(languageId) {
	const cfg = vscode.workspace.getConfiguration('editor', { languageId });
	const info = cfg && typeof cfg.inspect === 'function' ? cfg.inspect('defaultFormatter') : null;
	if (!info) return null;
	const targets = vscode.ConfigurationTarget || {};
	const rows = [
		[info.globalLanguageValue, targets.Global],
		[info.workspaceLanguageValue, targets.Workspace],
		[info.workspaceFolderLanguageValue, targets.WorkspaceFolder],
	];
	const hit = rows.find(
		([value]) => typeof value === 'string' && value && !vscode.extensions.getExtension(value)
	);
	return hit ? { value: hit[0], target: hit[1], cfg } : null;
}

async function checkFormatterSetting(context) {
	const bad = LANGUAGES.map(unavailableFormatter).filter(Boolean);
	if (!bad.length) return;
	const store = context && context.globalState;
	if (store && typeof store.get === 'function' && store.get(FORMATTER_WARNED)) return;
	const fix = t('Fix the setting');
	const never = t('Do not show again');
	const message = t(
		"The extension in editor.defaultFormatter is not installed ({0}), so VS Code will not format on save. Switch to ADB SQL Formatter?"
	).replace('{0}', bad[0].value);
	const choice = await vscode.window.showWarningMessage(message, fix, never);
	if (choice === fix) {
		// sql / mysql 都出问题时一次改完，别让用户点两遍
		for (const item of bad) {
			if (item.target !== undefined) {
				await item.cfg.update('defaultFormatter', EXT_ID, item.target, true);
			}
		}
	} else if (choice === never && store && typeof store.update === 'function') {
		await store.update(FORMATTER_WARNED, true);
	}
}

// ---------------------------------------------------------------------------
// 缺分号诊断：单语句文件不检查；多语句文件里非末条语句缺分号才提示
// ---------------------------------------------------------------------------
function validateDocument(document, collection) {
	if (!LANGUAGES.includes(document.languageId) || !getConfig().semicolonCheck) {
		collection.set(document.uri, []);
		return;
	}
	let missing = [];
	try {
		const { segments, missing: gaps } = findStatements(document.getText());
		// 只有一条语句时不做任何分号要求（与 DataGrip 一致）
		if (segments.length > 1) missing = gaps;
	} catch (e) {
		console.error('[adb-sql-formatter]', e);
		collection.set(document.uri, []);
		return;
	}
	const cfg = getConfig();
	const severity =
		cfg.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning;
	const diagnostics = missing.map((m) => {
		const start = document.positionAt(m.start);
		const end = document.positionAt(m.start + m.length);
		const d = new vscode.Diagnostic(
			new vscode.Range(start, end),
			t(
				'Missing semicolon after the previous statement: a multi-statement file without it is parsed as a single statement by the platform and fails with a syntax error. Click the lightbulb on the squiggle to insert one.'
			),
			severity
		);
		d.source = DIAG_SOURCE;
		d.code = DIAG_CODE;
		return d;
	});
	collection.set(document.uri, diagnostics);
}

// ---------------------------------------------------------------------------
// Quick fix：在上一条语句末尾补分号（可选顺手空一行）
// ---------------------------------------------------------------------------
function insertOffsetOf(document, diagnostic) {
	const offset = document.offsetAt(diagnostic.range.start);
	const text = document.getText();
	let i = offset - 1;
	while (i >= 0 && /\s/.test(text[i])) i--;
	return Math.max(0, i + 1);
}

class SemicolonCodeActionProvider {
	provideCodeActions(document, range, context) {
		const target = context.diagnostics.filter(
			(d) => d.source === DIAG_SOURCE && d.code === DIAG_CODE
		);
		if (!target.length) return undefined;
		const actions = [];
		target.forEach((d) => {
			const pos = document.positionAt(insertOffsetOf(document, d));
			const simple = new vscode.CodeAction(t('Insert semicolon'), vscode.CodeActionKind.QuickFix);
			simple.edit = new vscode.WorkspaceEdit();
			simple.edit.insert(document.uri, pos, ';');
			simple.diagnostics = [d];
			simple.isPreferred = true;
			simple.command = { command: 'editor.action.formatDocument', title: '', arguments: [] };
			actions.push(simple);

			const spaced = new vscode.CodeAction(
				t('Insert semicolon and a blank line'),
				vscode.CodeActionKind.QuickFix
			);
			spaced.edit = new vscode.WorkspaceEdit();
			spaced.edit.insert(document.uri, pos, ';' + eolOf(document));
			spaced.diagnostics = [d];
			actions.push(spaced);
		});
		return actions;
	}
}

function activate(context) {
	const collection = vscode.languages.createDiagnosticCollection('adbSqlFormatter');
	context.subscriptions.push(collection);

	// 先让 Ctrl/Cmd+S 那条绑定的开关就位，避免激活瞬间按键落到别处
	syncSaveKeyContext();

	const formattingSelector = LANGUAGES.map((language) => ({ language }));
	const provider = new AdbSqlFormattingProvider();

	context.subscriptions.push(
		vscode.languages.registerDocumentFormattingEditProvider(formattingSelector, provider),
		vscode.languages.registerDocumentRangeFormattingEditProvider(formattingSelector, provider),
		vscode.languages.registerCodeActionsProvider(
			formattingSelector,
			new SemicolonCodeActionProvider(),
			{ providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
		),
		vscode.workspace.onDidOpenTextDocument((d) => validateDocument(d, collection)),
		vscode.workspace.onDidChangeTextDocument((e) => validateDocument(e.document, collection)),
		vscode.workspace.onDidSaveTextDocument((d) => validateDocument(d, collection)),
		vscode.workspace.onDidCloseTextDocument((d) => collection.delete(d.uri)),
		// Ctrl+S 先格式化再落盘（不依赖编辑器设置的开关，见 formatOnWillSave）
		vscode.workspace.onWillSaveTextDocument((e) => formatOnWillSave(e)),
		// Ctrl+S 自己接住：先格式化再保存（含「文件没改动」这种不跑保存参与者的场景）
		vscode.commands.registerCommand(FORMAT_DOCUMENT, formatDocument),
		vscode.commands.registerCommand(FORMAT_AND_SAVE, formatAndSave),
		vscode.workspace.onDidChangeConfiguration(() => {
			vscode.workspace.textDocuments.forEach((d) => validateDocument(d, collection));
			syncSaveKeyContext();
			// 本扩展开关刚被关掉 → 把编辑器自带的 formatOnSave 也对齐关掉（否则保存仍会被重排）
			if (!getConfig().formatOnSave) {
				Promise.resolve(alignEditorFormatOnSave({ notify: true })).catch((e) =>
					console.error('[adb-sql-formatter]', e)
				);
			}
		})
	);

	// 重新加载窗口后，补齐此刻已打开文档的诊断
	vscode.workspace.textDocuments.forEach((d) => validateDocument(d, collection));

	// editor.defaultFormatter 指着没装的扩展时提示一次（不阻塞激活，失败也不影响其它功能）
	Promise.resolve(checkFormatterSetting(context)).catch((e) =>
		console.error('[adb-sql-formatter]', e)
	);

	// 用户还没表过态时问一次要不要「保存即格式化」（默认关，见 getConfig）
	Promise.resolve(maybeOfferFormatOnSave(context)).catch((e) =>
		console.error('[adb-sql-formatter]', e)
	);

	// 我们自己那层关着、但编辑器自带的 editor.formatOnSave 还开着时提示一次
	Promise.resolve(checkEditorFormatOnSave(context)).catch((e) =>
		console.error('[adb-sql-formatter]', e)
	);
}

function deactivate() {}

module.exports = { activate, deactivate };
