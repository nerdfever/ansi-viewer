// ANSI Viewer — render a file's ANSI escape sequences in a WebView panel. Scales to large files
// because the browser engine renders HTML <span> tags, instead of VS Code's per-byte text-
// decoration API which doesn't (the architectural reason iliazeus stalls on multi-MB logs).
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

// Standard 16-color SGR palette (basic + bright), with terminal-typical hex values.
const FG = {
    '30':'#000000','31':'#cd3131','32':'#0dbc79','33':'#e5e510',
    '34':'#2472c8','35':'#bc3fbc','36':'#11a8cd','37':'#e5e5e5',
    '90':'#666666','91':'#f14c4c','92':'#23d18b','93':'#f5f543',
    '94':'#3b8eea','95':'#d670d6','96':'#29b8db','97':'#ffffff'
};
const BG = Object.fromEntries(Object.entries(FG).map(([k,v]) => [String(+k+10), v]));

function escapeHtml(s) {
    return s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
}

// Diagnostic: count SGR sequences and lines so the debug strip can confirm parsing actually saw them.
function ansiCountStats(text) {
    const m = text.match(/\x1b\[[0-9;]*m/g);
    return { escapes: m ? m.length : 0, lines: text.split('\n').length };
}

// Render the text to HTML, one <div class="ln"> per source line. SGR state is carried ACROSS lines
// (a color left open on one line continues on the next, like a terminal). Line numbers are NOT emitted
// here -- they're drawn by a CSS counter on .ln (see the stylesheet), so they stay out of Ctrl+F find
// and copy/paste. Each line is its own element so the counter increments once per line.
function ansiLinesToHtml(text) {
    const re = /\x1b\[([0-9;]*)m/g;
    const state = { fg: null, bg: null, bold: false, italic: false, underline: false };

    function spanOpen() {
        const css = [];
        if (state.fg) css.push('color:' + state.fg);
        if (state.bg) css.push('background:' + state.bg);
        if (state.bold) css.push('font-weight:bold');
        if (state.italic) css.push('font-style:italic');
        if (state.underline) css.push('text-decoration:underline');
        return css.length ? '<span style="' + css.join(';') + '">' : '';
    }

    function applyCodes(codes) {
        for (const c of codes) {
            if (c === '' || c === '0') Object.assign(state, { fg: null, bg: null, bold: false, italic: false, underline: false });
            else if (c === '1') state.bold = true;
            else if (c === '3') state.italic = true;
            else if (c === '4') state.underline = true;
            else if (c === '22') state.bold = false;
            else if (c === '23') state.italic = false;
            else if (c === '24') state.underline = false;
            else if (c === '39') state.fg = null;
            else if (c === '49') state.bg = null;
            else if (FG[c]) state.fg = FG[c];
            else if (BG[c]) state.bg = BG[c];
        }
    }

    const out = [];
    for (const line of text.split('\n')) {
        let html = '';
        let open = spanOpen();          // reopen the carried-over state at the start of the line
        let inSpan = !!open;
        html += open;
        let last = 0, m;
        re.lastIndex = 0;
        while ((m = re.exec(line)) !== null) {
            html += escapeHtml(line.substring(last, m.index));
            last = m.index + m[0].length;
            if (inSpan) { html += '</span>'; inSpan = false; }
            applyCodes(m[1] ? m[1].split(';') : ['0']);
            open = spanOpen();
            if (open) { html += open; inSpan = true; }
        }
        html += escapeHtml(line.substring(last));
        if (inSpan) html += '</span>';
        out.push('<div class="ln">' + html + '</div>');
    }
    return out.join('');
}

const VERSION = require('./package.json').version;
const TAG = 'ansi-viewer:';
const TARGET_EXTS = ['.log', '.ansi', '.ans'];

// Toggle state. `panels` maps a file's uri string to its open viewer panel — at most one per file, so
// the View<->Edit toggle reuses a single tab instead of spawning duplicates. activeViewerPanel/Uri
// track the focused viewer (for the title-bar buttons). `suppressed` holds uri strings the user chose
// to edit as text; autoOpen skips those so the file stays editable until they re-open it in the viewer.
const panels = new Map();
let activeViewerPanel = null;
let activeViewerUri = null;
const suppressed = new Set();
// Markdown uses VS Code's BUILT-IN preview (we don't own that webview). lastMdPreviewUri remembers the
// file we last previewed so the "Edit Markdown Source" button can suppress its auto-re-preview.
let lastMdPreviewUri = null;

// Build the full WebView HTML for `text`. wrap=true turns on CSS line wrapping (with a hanging indent
// so wrapped rows line up past the line-number gutter); wrap=false keeps each line on one row with
// horizontal scroll. Line numbers are a CSS counter on .ln rendered via ::before, so they don't appear
// in Ctrl+F searches or copied text; position:sticky pins the number column during horizontal scroll;
// :empty::after gives blank lines a full line-box so numbering stays aligned.
function buildHtml(text, wrap) {
    // CSP allows inline styles only -- no scripts. The panel has no interactive JS: its controls
    // (Edit / Toggle Wrap) live in the editor title bar, contributed via package.json.
    const csp = "default-src 'none'; style-src 'unsafe-inline'";
    const stats = ansiCountStats(text);
    const gutterCh = String(stats.lines).length;    // line-number column width, in characters
    const gut = gutterCh + 'ch + 1em + 16px';        // total horizontal space the number column occupies
    const header = '<div class="hdr">' +
                   'ANSI Viewer v' + VERSION + ' — ' + stats.escapes + ' SGR sequences, ' +
                   stats.lines + ' lines, ' + (text.length / 1024).toFixed(1) + ' KB' + (wrap ? ' — wrap on' : '') +
                   '</div>';
    return '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
        '<meta http-equiv="Content-Security-Policy" content="' + csp + '">' +
        '<style>' +
        'body{font-family:\"Cascadia Code\",Consolas,\"Courier New\",monospace;font-size:13px;line-height:1.4;' +
        'background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);' +
        'margin:0;padding:0;counter-reset:ln;}' +
        '.hdr{font-family:sans-serif;font-size:11px;opacity:0.55;padding:4px 8px;border-bottom:1px solid #444;' +
        'position:sticky;top:0;left:0;background:var(--vscode-editor-background);z-index:2;}' +
        '.ln{counter-increment:ln;white-space:' + (wrap ? 'pre-wrap' : 'pre') + ';' +
        (wrap ? 'overflow-wrap:anywhere;padding-left:calc(' + gut + ');text-indent:calc(-1 * (' + gut + '));'
              : 'padding-right:8px;') + '}' +
        '.ln:empty::after{content:\" \";}' +
        '.ln::before{content:counter(ln);display:inline-block;box-sizing:content-box;width:' + gutterCh + 'ch;' +
        'padding:0 1em 0 8px;margin-right:8px;text-align:right;text-indent:0;' +
        'color:var(--vscode-editorLineNumber-foreground,#858585);background:var(--vscode-editor-background);' +
        'border-right:1px solid #333;user-select:none;position:sticky;left:0;z-index:1;}' +
        '</style></head>' +
        '<body>' + header + ansiLinesToHtml(text) + '</body></html>';
}

// Read `uri` and (re)render it into `panel` with the given wrap mode.
function renderViewer(panel, uri, wrap) {
    let text;
    try { text = fs.readFileSync(uri.fsPath, 'utf8'); }
    catch (e) {
        panel.webview.html = '<!DOCTYPE html><html><body><pre>Read failed: ' + escapeHtml(String(e)) + '</pre></body></html>';
        return;
    }
    panel.webview.html = buildHtml(text, wrap);
}

// Open `uri` in the ANSI Viewer: reveal the existing panel for this file if one is open, else create a
// new one (line wrap off). One panel per file is what keeps the View<->Edit toggle on a single tab.
function openViewer(uri) {
    const key = uri.toString();
    const existing = panels.get(key);
    if (existing) { existing.reveal(vscode.ViewColumn.Active); return; }
    const panel = vscode.window.createWebviewPanel(
        'nerdfever.ansi-viewer',
        'ANSI: ' + path.basename(uri.fsPath || uri.path),
        vscode.ViewColumn.Active,
        // No scripts: the panel is static HTML; its controls live in the editor title bar.
        // enableFindWidget gives the panel VS Code's native Ctrl+F find over the rendered text.
        { enableScripts: false, enableFindWidget: true, retainContextWhenHidden: true }
    );
    panel.ansiUri = uri; panel.ansiWrap = false;
    panels.set(key, panel);
    activeViewerPanel = panel; activeViewerUri = uri;
    panel.onDidChangeViewState(e => { if (e.webviewPanel.active) { activeViewerPanel = panel; activeViewerUri = uri; } });
    panel.onDidDispose(() => {
        if (panels.get(key) === panel) panels.delete(key);
        if (activeViewerPanel === panel) { activeViewerPanel = null; activeViewerUri = null; }
    });
    renderViewer(panel, uri, false);
}

function isTarget(doc) {
    if (!doc || (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'untitled')) return false;
    const p = (doc.uri.fsPath || doc.uri.path).toLowerCase();
    return TARGET_EXTS.some(ext => p.endsWith(ext));
}

function isMarkdown(doc) {
    if (!doc || (doc.uri.scheme !== 'file' && doc.uri.scheme !== 'untitled')) return false;
    if (doc.languageId === 'markdown') return true;
    const p = (doc.uri.fsPath || doc.uri.path).toLowerCase();
    return p.endsWith('.md') || p.endsWith('.markdown');
}

function activate(context) {
    console.log(TAG, 'activate (v' + VERSION + ')');

    // Close any raw text-editor tab(s) showing `uri`. Viewer (webview) tabs have no .input.uri, so this
    // only closes the editable text editor, never the rendered panel.
    async function closeRawTabs(uri) {
        const key = uri.toString();
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                const input = tab.input;
                if (input && input.uri && input.uri.toString() === key) {
                    try { await vscode.window.tabGroups.close(tab); }
                    catch (e) { console.error(TAG, 'close tab threw:', e); }
                }
            }
        }
    }

    // Close the built-in Markdown PREVIEW tab(s) for `uri` (webview tabs have a viewType but no .uri, so
    // we match the markdown.preview viewType plus the file's basename in the tab label).
    async function closeMdPreviewTabs(uri) {
        const base = (uri.path || '').split('/').pop();
        for (const group of vscode.window.tabGroups.all) {
            for (const tab of group.tabs) {
                const input = tab.input;
                if (input && input.viewType && String(input.viewType).indexOf('markdown.preview') >= 0 &&
                    (!base || (tab.label || '').indexOf(base) >= 0)) {
                    try { await vscode.window.tabGroups.close(tab); }
                    catch (e) { console.error(TAG, 'close md preview tab threw:', e); }
                }
            }
        }
    }

    // Show `uri` as the rendered viewer: drop edit-suppression, open/reveal the single viewer panel,
    // then close the raw editor tab so only the viewer remains.
    async function showViewer(uri) {
        suppressed.delete(uri.toString());
        openViewer(uri);
        await closeRawTabs(uri);
    }

    // Show `uri` as editable text: suppress auto-flip, open the raw editor, dispose the viewer panel.
    async function showEditor(uri) {
        suppressed.add(uri.toString());
        await vscode.commands.executeCommand('vscode.openWith', uri, 'default', { viewColumn: vscode.ViewColumn.Active });
        const panel = panels.get(uri.toString());
        if (panel) panel.dispose();
    }

    // Show `uri` as the built-in Markdown preview: drop suppression, run the built-in showPreview, then
    // close the source tab so only the preview remains. We don't own the preview webview, so we just
    // orchestrate the built-in commands.
    async function showMdPreview(uri) {
        suppressed.delete(uri.toString());
        lastMdPreviewUri = uri;
        await vscode.commands.executeCommand('markdown.showPreview', uri);
        await closeRawTabs(uri);
    }

    // Auto-flip a freshly-opened/-focused document, unless the user is editing it. .log/.ansi/.ans go to
    // our ANSI viewer; .md goes to the built-in Markdown preview. openViewer dedups, so no duplicate tabs.
    function autoOpen(doc, reason) {
        if (!doc) return;
        if (suppressed.has(doc.uri.toString())) return;
        if (isMarkdown(doc)) { console.log(TAG, 'md-preview (' + reason + ')', doc.uri.toString()); showMdPreview(doc.uri); return; }
        if (!isTarget(doc)) return;
        console.log(TAG, 'auto-open (' + reason + ')', doc.uri.toString());
        showViewer(doc.uri);
    }

    context.subscriptions.push(
        // "Open in ANSI Viewer" (command palette + title-bar "V" button on .log/.ansi/.ans text editors).
        vscode.commands.registerCommand('nerdfever.ansi-viewer.open', (arg) => {
            let uri = arg && arg.fsPath ? arg : null;
            if (!uri && vscode.window.activeTextEditor) uri = vscode.window.activeTextEditor.document.uri;
            if (!uri) { vscode.window.showWarningMessage('ANSI Viewer: no file to open.'); return; }
            showViewer(uri);
        }),
        // "Edit as Text" (title-bar pencil button, shown while a viewer is active): show the raw editor.
        vscode.commands.registerCommand('nerdfever.ansi-viewer.edit', () => {
            if (activeViewerUri) showEditor(activeViewerUri);
        }),
        // "Toggle Line Wrap" (title-bar word-wrap button in the viewer): flip the active panel's wrap mode
        // and re-render it (rebuild its HTML with the new wrap setting).
        vscode.commands.registerCommand('nerdfever.ansi-viewer.toggleWrap', () => {
            const panel = activeViewerPanel;
            if (!panel) return;
            panel.ansiWrap = !panel.ansiWrap;
            renderViewer(panel, panel.ansiUri || activeViewerUri, panel.ansiWrap);
        }),
        // "Open Markdown Preview" (title-bar "V" button on a .md text editor).
        vscode.commands.registerCommand('nerdfever.ansi-viewer.mdPreview', (arg) => {
            let uri = arg && arg.fsPath ? arg : null;
            if (!uri && vscode.window.activeTextEditor) uri = vscode.window.activeTextEditor.document.uri;
            if (uri) showMdPreview(uri);
        }),
        // "Edit Markdown Source" (title-bar "E" button on the built-in Markdown preview): suppress the
        // auto-re-preview for that file, then show its source via the built-in command.
        vscode.commands.registerCommand('nerdfever.ansi-viewer.mdSource', async () => {
            if (lastMdPreviewUri) suppressed.add(lastMdPreviewUri.toString());
            await vscode.commands.executeCommand('markdown.showSource');
            const ed = vscode.window.activeTextEditor;
            if (ed && isMarkdown(ed.document)) {
                suppressed.add(ed.document.uri.toString());
                await closeMdPreviewTabs(ed.document.uri);   // leave only the source tab
            }
        }),
        vscode.workspace.onDidOpenTextDocument(d => autoOpen(d, 'onDidOpenTextDocument')),
        vscode.window.onDidChangeActiveTextEditor(e => { if (e) autoOpen(e.document, 'onDidChangeActiveTextEditor'); })
    );

    // The file that triggered activation (onLanguage:log) is already open by the time activate() runs.
    vscode.workspace.textDocuments.forEach(d => autoOpen(d, 'startup'));
}

function deactivate() {}

module.exports = { activate, deactivate };
