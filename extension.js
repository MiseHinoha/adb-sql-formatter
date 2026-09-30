const vscode = require('vscode');
const { formatSql, findStatements } = require('./formatter-core');

const EXT_ID = 'YipTszkwan.adb-sql-formatter';
const DIAG_SOURCE = 'ADB SQL Formatter';
const DIAG_CODE = 'missing-semicolon';
const LANGUAGES = ['sql', 'mysql'];

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
	};
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
		return [vscode.TextEdit.replace(range || fullRange(document), result)];
	} catch (e) {
		// 半截 SQL / 解析失败时不改文档，错误写入输出面板便于排查
		console.error('[adb-sql-formatter]', e);
		return undefined;
	}
}

class AdbSqlFormattingProvider {
	provideDocumentFormattingEdits(document, options) {
		return makeEdits(document, null, options);
	}
	provideDocumentRangeFormattingEdits(document, range, options) {
		return makeEdits(document, range, options);
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
			spaced.edit.insert(document.uri, pos, ';\n');
			spaced.diagnostics = [d];
			actions.push(spaced);
		});
		return actions;
	}
}

function activate(context) {
	const collection = vscode.languages.createDiagnosticCollection('adbSqlFormatter');
	context.subscriptions.push(collection);

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
		vscode.workspace.onDidChangeConfiguration(() => {
			vscode.workspace.textDocuments.forEach((d) => validateDocument(d, collection));
		})
	);

	// 重新加载窗口后，补齐此刻已打开文档的诊断
	vscode.workspace.textDocuments.forEach((d) => validateDocument(d, collection));
}

function deactivate() {}

module.exports = { activate, deactivate };
