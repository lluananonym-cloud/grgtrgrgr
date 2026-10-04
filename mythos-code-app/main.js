const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, Notification, nativeImage, powerSaveBlocker, session, desktopCapturer, safeStorage } = require("electron");
const fs = require("fs"); const path = require("path"); const http = require("http"); const crypto = require("crypto"); const { exec, execFile, spawn } = require("child_process");
const { McpManager } = require("./mcp.js");
// Sprachmodus: mehrere Threads für die lokale Spracherkennung, falls keine Grafikkarte (WebGPU) nutzbar ist.
app.commandLine.appendSwitch("enable-features", "SharedArrayBuffer");

// ---------- Gemeinsame Werkzeuge (CLI + Desktop-App) ----------
// Wird roh in bin/mythos.js (CLI, ESM) und main.js (App, CommonJS) eingefügt.
// Erwartet, dass `fs` und `path` im umgebenden Code schon importiert sind.

const TOOL_PROMPT = [
  "Werkzeuge – antworte pro Schritt mit GENAU EINEM Block:",
  '<tool>{"name":"run","cmd":"..."}</tool>  Shell-Befehl ausführen (Ausgabe läuft live mit)',
  '<tool>{"name":"read","path":"..."}</tool>  Datei lesen',
  '<tool>{"name":"edit","path":"...","old":"exakter alter Text","new":"neuer Text"}</tool>  Datei gezielt ändern (bevorzugt! "old" muss genau einmal vorkommen, sonst "all":true)',
  '<tool>{"name":"write","path":"...","content":"..."}</tool>  Neue Datei anlegen oder komplett neu schreiben',
  '<tool>{"name":"search","pattern":"regex","path":".","glob":"*.ts"}</tool>  Im Projekt suchen (path und glob optional)',
  '<tool>{"name":"ls","path":"."}</tool>  Ordner auflisten',
  '<tool>{"name":"websearch","query":"..."}</tool>  Im Internet suchen (z. B. Doku, Fehlermeldungen)',
  '<tool>{"name":"fetch","url":"https://..."}</tool>  Webseite als Text lesen',
  '<tool>{"name":"todo","items":[{"text":"Schritt","done":false}]}</tool>  Aufgabenliste anlegen/aktualisieren (bei größeren Aufgaben zuerst planen, dann Punkte abhaken; immer die komplette Liste senden)',
  "Nach jedem Werkzeug bekommst du das Ergebnis. Suche erst, statt Dateien blind zu lesen. Ändere bestehende Dateien mit edit statt write.",
  "Arbeite Schritt für Schritt, bis die Aufgabe erledigt ist, dann antworte normal ohne <tool> (Markdown erlaubt).",
].join("\n");

// Modelle, die v1-messages versteht (siehe mapModel dort).
const MODELS = [
  { id: "mythos-code", label: "MythosCode", desc: "Standard fürs Programmieren" },
  { id: "mythos-v2", label: "Mythos v2", desc: "am stärksten, etwas langsamer" },
  { id: "mythos-sonnet", label: "Mythos v1", desc: "ausgewogen" },
  { id: "mythos-lite", label: "Mythos Lite", desc: "am schnellsten" },
];
/** Grobe Token-Schätzung (≈ 4 Zeichen pro Token, Bilder pauschal). */
function estimateTokens(system, messages) {
  let chars = String(system || "").length, images = 0;
  for (const m of messages) {
    if (typeof m.content === "string") chars += m.content.length;
    else for (const b of m.content || []) { if (b.type === "image") images++; else chars += String(b.text || "").length; }
  }
  return Math.ceil(chars / 4) + images * 1500;
}
const fmtTokens = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + " Mio." : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));

const MEMORY_FILE = "MYTHOS.md";
const memoryPrompt = (mem) => mem
  ? "\n\nProjekt-Gedächtnis (" + MEMORY_FILE + " im Projektordner – halte dich daran, ergänze es bei wichtigen neuen Erkenntnissen per edit):\n" + mem
  : "";
const goalPrompt = (goal) => goal
  ? "\n\nZIEL (/goal): " + goal +
    "\nDer Auftraggeber ist NICHT am Rechner und liest erst viel später mit, was hier im Chat passiert ist – frage ihn nichts, er kann nicht antworten. Behandle jede Entscheidung, jede Rückfrage und jedes Hindernis als etwas, das du selbst lösen musst:" +
    "\n- Gib bei Fehlern NIEMALS auf. Ein fehlgeschlagener Befehl, eine fehlende Abhängigkeit, ein kaputter Build sind Aufgaben, keine Endstationen: lies die Fehlermeldung genau, versuche eine andere Vorgehensweise, installiere Fehlendes selbst (z. B. per npm/pip/winget), nutze bei Bedarf websearch/fetch um die Lösung nachzuschlagen, und probiere es erneut. Erst wenn du wirklich mehrere grundverschiedene Ansätze erfolglos versucht hast, notierst du das Problem knapp und machst mit dem Rest der Aufgabe weiter." +
    "\n- Triff sinnvolle Annahmen statt zu fragen, und schreib kurz dazu, welche Annahme du getroffen hast." +
    "\n- Beginne SOFORT mit einer kurzen Bestätigung und deinem Plan (2–6 Stichpunkte) als normalen Text, BEVOR du das erste Werkzeug nutzt – so sieht der Auftraggeber direkt, dass du das Ziel verstanden hast." +
    "\n- Teile deinen Fortschritt normal im Chat mit (was du tust und warum), aber warte nicht auf eine Antwort. Schreibe vor jedem größeren Schritt einen kurzen Satz dazu." +
    "\n- Baue große Projekte in vielen kleinen Dateien (je höchstens ca. 300 Zeilen) statt in einer riesigen Datei auf einmal." +
    "\n- Das ist eine große, langlaufende Aufgabe: Plane für 1 bis 5 Stunden durchgehende Arbeit in vielen kleinen Schritten, nicht für ein paar Minuten. Höre nicht zu früh auf – arbeite lieber zu gründlich als zu knapp." +
    "\nArbeite komplett selbstständig weiter, bis das Ziel vollständig erreicht und überprüft ist. Erst dann schreibe in deiner letzten Antwort eine eigene Zeile: ZIEL ERREICHT"
  : "";
/** Kurzer Live-Status aus der gerade gestreamten Antwort, z. B. „✍ schreibt src/main.js · 12 KB“. */
function streamActivity(full) {
  if (!full) return "denkt nach…";
  const k = full.lastIndexOf("<tool>");
  if (k < 0 || full.indexOf("</tool>", k) >= 0) return "schreibt Antwort…";
  const t = full.slice(k + 6), kb = (t.length / 1024).toFixed(1).replace(".", ",") + " KB";
  const f = (key) => { const m = t.match(new RegExp('"' + key + '"\\s*:\\s*"([^"\\\\]{0,120})')); return m ? m[1] : ""; };
  const name = f("name"), path = f("path");
  if (name === "write" || name === "edit") return "✍ " + (name === "write" ? "schreibt " : "ändert ") + (path || "eine Datei") + " · " + kb;
  if (name === "run") return "⚙ bereitet Befehl vor: " + f("cmd").slice(0, 60);
  return "🔧 bereitet " + (name || "Werkzeug") + " vor…";
}
const GOAL_NUDGE = "Das Ziel ist noch nicht als erreicht gemeldet. Der Auftraggeber ist nicht da – gib bei Problemen nicht auf, sondern versuche einen anderen Weg, nutze websearch/fetch für Lösungen und arbeite selbstständig weiter, ohne Rückfragen. Wenn es wirklich vollständig erledigt und geprüft ist, schreibe ZIEL ERREICHT.";
const SUMMARY_PROMPT = "Fasse jetzt kurz auf Deutsch zusammen, OHNE Werkzeuge:\n**Geändert:** welche Dateien und was\n**Geklappt:** was funktioniert (und wie geprüft)\n**Offen:** was noch fehlt oder beachtet werden muss\nMaximal 12 Zeilen.";

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "out", "coverage", ".cache", "vendor", "__pycache__", ".venv", "venv", "target"]);

function readText(file) { try { return fs.readFileSync(file, "utf8"); } catch { return null; } }

// Windows-Konsolenprogramme (cmd, dir, …) schreiben in Pipes im OEM-Zeichensatz (CP850), Node/Git in UTF-8.
const CP850 = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜø£Ø×ƒáíóúñÑªº¿®¬½¼¡«»░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐└┴┬├─┼ãÃ╚╔╩╦╠═╬¤ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀ÓßÔÒõÕµþÞÚÛÙýÝ¯´­±‗¾¶§÷¸°¨·¹³²■ ";
const fromCp850 = (b) => { let s = ""; for (const c of b) s += c < 128 ? String.fromCharCode(c) : CP850[c - 128]; return s; };
/** Decoder für eine Ausgabe-Pipe: jedes Stück als UTF-8, sonst (Windows) als CP850. Angefangene UTF-8-Zeichen werden aufgehoben. */
function outputDecoder() {
  let pending = Buffer.alloc(0);
  return (chunk) => {
    let b = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let i = b.length - 1, cont = 0;
    while (i >= 0 && cont < 3 && (b[i] & 0xc0) === 0x80) { i--; cont++; }
    const need = i >= 0 ? (b[i] >= 0xf0 ? 4 : b[i] >= 0xe0 ? 3 : b[i] >= 0xc0 ? 2 : 1) : 1;
    const cut = need > 1 && b.length - i < need ? i : b.length;
    pending = Buffer.from(b.subarray(cut)); b = b.subarray(0, cut);
    try { return new TextDecoder("utf-8", { fatal: true }).decode(b); }
    catch { return process.platform === "win32" ? fromCp850(b) : b.toString("latin1"); }
  };
}

/** Zeilen-Diff mit Kontext: { added, removed, lines: [[op, text]] }, op = " " | "+" | "-" | "@" (Lücke). */
function lineDiff(a, b, ctx = 3, maxLines = 400) {
  // Zeilenumbruch am Dateiende ist keine eigene Zeile.
  const toLines = (t) => (t ? t.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n") : []);
  const A = toLines(a), B = toLines(b);
  let s = 0; while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let ea = A.length, eb = B.length; while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
  const x = A.slice(s, ea), y = B.slice(s, eb);
  let ops = [];
  if (x.length * y.length <= 4e6) {
    const n = x.length, m = y.length, L = [];
    for (let i = 0; i <= n; i++) L.push(new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (x[i] === y[j]) { ops.push([" ", x[i]]); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) ops.push(["-", x[i++]]);
      else ops.push(["+", y[j++]]);
    }
    while (i < n) ops.push(["-", x[i++]]);
    while (j < m) ops.push(["+", y[j++]]);
  } else ops = x.map((l) => ["-", l]).concat(y.map((l) => ["+", l]));
  const all = A.slice(0, s).map((l) => [" ", l]).concat(ops, A.slice(ea).map((l) => [" ", l]));
  const keep = new Uint8Array(all.length);
  let added = 0, removed = 0;
  all.forEach((o, k) => {
    if (o[0] === " ") return;
    if (o[0] === "+") added++; else removed++;
    for (let d = Math.max(0, k - ctx); d <= Math.min(all.length - 1, k + ctx); d++) keep[d] = 1;
  });
  const lines = [];
  let gap = false;
  for (let k = 0; k < all.length; k++) {
    if (!keep[k]) { gap = true; continue; }
    if (lines.length >= maxLines) { lines.push(["@", "… (gekürzt)"]); break; }
    if (gap && lines.length) lines.push(["@", "…"]);
    gap = false; lines.push(all[k]);
  }
  return { added, removed, lines };
}

/** Gezieltes Ändern: `old` muss genau einmal vorkommen (oder all=true). */
function editFile(file, oldText, newText, all) {
  const cur = readText(file);
  if (cur == null) return { error: "Datei nicht gefunden: " + file };
  if (!oldText) return { error: '"old" fehlt – gib den exakten Text an, der ersetzt werden soll.' };
  let o = String(oldText), n = String(newText ?? "");
  // CRLF-Dateien mit LF-Suchtext trotzdem treffen.
  if (!cur.includes(o) && cur.includes("\r\n")) { o = o.replace(/\r?\n/g, "\r\n"); n = n.replace(/\r?\n/g, "\r\n"); }
  const count = cur.split(o).length - 1;
  if (count === 0) return { error: "Text nicht gefunden in " + file + " – lies die Datei neu und nimm den exakten Text (inkl. Einrückung)." };
  if (count > 1 && !all) return { error: "Text kommt " + count + "-mal vor in " + file + ' – nimm mehr umgebenden Kontext oder setze "all":true.' };
  const at = cur.indexOf(o);
  const next = all ? cur.split(o).join(n) : cur.slice(0, at) + n + cur.slice(at + o.length);
  fs.writeFileSync(file, next);
  return { diff: lineDiff(cur, next), count: all ? count : 1 };
}

function globToRe(glob) {
  const g = String(glob).replace(/\\/g, "/").replace(/[.+^${}()|[\]]/g, "\\$&")
    .replace(/\*\*\/?/g, "\u0001").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0001/g, ".*");
  return new RegExp("(^|/)" + g + "$", "i");
}

/** Projekt durchsuchen (Regex, Groß-/Kleinschreibung egal, ohne node_modules & Co.). */
function searchFiles(root, pattern, glob, max = 200) {
  let re;
  try { re = new RegExp(pattern, "i"); } catch { re = new RegExp(String(pattern).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); }
  const gre = glob ? globToRe(glob) : null;
  const hits = [];
  let files = 0;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (hits.length >= max || files > 20000) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full); continue; }
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (gre && !gre.test(rel)) continue;
      let st; try { st = fs.statSync(full); } catch { continue; }
      if (st.size > 1e6) continue;
      files++;
      const text = readText(full);
      if (text == null || text.includes("\u0000")) continue;
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length && hits.length < max; i++) {
        if (re.test(lines[i])) hits.push(rel + ":" + (i + 1) + ": " + lines[i].trim().slice(0, 200));
      }
    }
  };
  walk(root);
  if (!hits.length) return "Keine Treffer für /" + pattern + "/" + (glob ? " in " + glob : "") + ".";
  return hits.join("\n") + (hits.length >= max ? "\n… (mehr als " + max + " Treffer – Suche eingrenzen)" : "");
}

// ---------- Sicherheitsnetz für Befehle ----------
// Diese Befehle fragen IMMER nach (auch mit Vollzugriff) und werden im /goal-Modus blockiert,
// weil dann niemand da ist, der sie bestätigen könnte.
const DANGER = [
  [/\brm\s+-[a-z]*(?:rf|fr)[a-z]*\s+(?:--no-preserve-root\s+)?(?:\/|~|\*|\$HOME|%USERPROFILE%)(?:\s|$)/i, "löscht rekursiv ein System- oder Home-Verzeichnis"],
  [/\bformat(?:\.com)?\s+[a-z]:/i, "formatiert ein Laufwerk"],
  [/\b(?:rd|rmdir)\s+\/s\b[^&|;]*\b[a-z]:\\?\s*(?:$|[&|;])/i, "löscht ein ganzes Laufwerk"],
  [/\b(?:del|erase)\b[^&|;]*\/s\b[^&|;]*\b[a-z]:\\\*?\s*(?:$|[&|;])/i, "löscht ein ganzes Laufwerk"],
  [/Remove-Item\b[^|;]*-Recurse[^|;]*\s["']?[a-z]:\\?["']?(?:\s|$|;)/i, "löscht rekursiv ein ganzes Laufwerk"],
  [/\bgit\s+push\b[^;&|]*\s(?:--force(?:-with-lease)?|-f)\b/i, "überschreibt die Git-Historie auf dem Server (Force-Push)"],
  [/\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-z]*f/i, "verwirft lokale Änderungen unwiderruflich"],
  [/\b(?:shutdown|restart-computer|stop-computer)\b/i, "fährt den PC herunter oder startet ihn neu"],
  [/\breg(?:\.exe)?\s+delete\b|Remove-Item(?:Property)?\b[^|;]*\bHK(?:LM|CU):/i, "löscht Einträge in der Windows-Registry"],
  [/\b(?:curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^|]*\|\s*(?:sh|bash|zsh|iex|invoke-expression|powershell|pwsh)\b/i, "lädt ein Skript aus dem Internet und führt es sofort aus"],
  [/\bmkfs(?:\.\w+)?\b|\bdd\s+[^|;]*\bof=\/dev\//i, "überschreibt ein Laufwerk"],
  [/:\(\)\s*\{\s*:\|:&\s*\};:/, "startet eine Fork-Bombe"],
  [/\b(?:npm|pnpm|yarn)\s+publish\b|\bgh\s+release\s+create\b|\bgh\s+repo\s+delete\b/i, "veröffentlicht oder löscht etwas öffentlich"],
  [/\b(?:Set-MpPreference|netsh\s+advfirewall\s+set)\b/i, "ändert Windows-Sicherheitseinstellungen (Virenschutz/Firewall)"],
];
/** Grund, warum ein Befehl gefährlich ist, oder null. */
function dangerCheck(cmd) {
  const c = String(cmd || "");
  for (const [re, why] of DANGER) if (re.test(c)) return why;
  return null;
}

/** Liegt `p` (relativ zu root) innerhalb des Projektordners? */
function insideRoot(root, p) {
  const r = path.relative(path.resolve(root), path.resolve(root, p || "."));
  return !(r.startsWith("..") || path.isAbsolute(r));
}

/** read/write/edit/search/ls ausführen. `run` macht jede Oberfläche selbst (Live-Ausgabe). */
function fileTool(t, root) {
  const P = (p) => path.resolve(root, p || ".");
  // Schreiben nur innerhalb des Projekts – und nie in Gits interne Dateien.
  if (t.name === "write" || t.name === "edit") {
    if (!insideRoot(root, t.path)) return { result: "FEHLER: Schreiben außerhalb des Projektordners ist gesperrt (" + t.path + "). Arbeite nur mit Dateien im Projekt." };
    if (/^\.git(?:[\\/]|$)/.test(path.relative(path.resolve(root), P(t.path)))) return { result: "FEHLER: Gits interne Dateien (.git/) werden nicht direkt bearbeitet – nutze git-Befehle." };
  }
  try {
    if (t.name === "read") {
      const c = readText(P(t.path));
      return { result: c == null ? "FEHLER: Datei nicht gefunden: " + t.path : c.slice(0, 20000) + (c.length > 20000 ? "\n…[gekürzt – Datei ist länger]" : "") };
    }
    if (t.name === "write") {
      const file = P(t.path), before = readText(file) ?? "", content = String(t.content ?? "");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      const d = lineDiff(before, content);
      return { result: "OK geschrieben: " + t.path + " (+" + d.added + " −" + d.removed + ")", diff: d };
    }
    if (t.name === "edit") {
      const r = editFile(P(t.path), t.old, t.new, t.all);
      if (r.error) return { result: "FEHLER: " + r.error };
      return { result: "OK geändert: " + t.path + " (" + r.count + "×, +" + r.diff.added + " −" + r.diff.removed + ")", diff: r.diff };
    }
    if (t.name === "search") return { result: searchFiles(P(t.path), String(t.pattern || ""), t.glob) };
    if (t.name === "ls") return { result: fs.readdirSync(P(t.path), { withFileTypes: true }).map((e) => (e.isDirectory() ? "[D] " : "    ") + e.name).join("\n") || "(leer)" };
    return { result: "Unbekanntes Werkzeug: " + t.name };
  } catch (e) { return { result: "FEHLER: " + e.message }; }
}

// ---------- Web: Seite lesen & Suche ----------
const WEB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 MythosCode";
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", auml: "ä", ouml: "ö", uuml: "ü", Auml: "Ä", Ouml: "Ö", Uuml: "Ü", szlig: "ß" };
const decodeEntities = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
  e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENTITIES[e] ?? m);
function htmlToText(html) {
  return decodeEntities(html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer|pre|blockquote)>|<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t\f\v]+/g, " ").replace(/\n\s*\n\s*/g, "\n\n").trim();
}
async function webGet(url) {
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, { headers: { "user-agent": WEB_UA, "accept-language": "de,en;q=0.8" }, redirect: "follow", signal: ctl.signal });
    const type = r.headers.get("content-type") || "";
    const buf = Buffer.from(await r.arrayBuffer()).subarray(0, 3e6);
    return { ok: r.ok, status: r.status, type, text: buf.toString("utf8"), url: r.url };
  } finally { clearTimeout(to); }
}
async function webTool(t) {
  try {
    if (t.name === "fetch") {
      const url = String(t.url || "");
      if (!/^https?:\/\//i.test(url)) return { result: "FEHLER: Bitte eine vollständige http(s)-URL angeben." };
      const r = await webGet(url);
      if (!r.ok) return { result: "FEHLER: HTTP " + r.status + " für " + url };
      const text = /html/i.test(r.type) ? htmlToText(r.text) : r.text;
      return { result: "Inhalt von " + r.url + ":\n\n" + text.slice(0, 20000) + (text.length > 20000 ? "\n…[gekürzt]" : "") };
    }
    if (t.name === "websearch") {
      const q = String(t.query || "").trim();
      if (!q) return { result: "FEHLER: query fehlt." };
      const r = await webGet("https://html.duckduckgo.com/html/?q=" + encodeURIComponent(q));
      const hits = [];
      // Jeder Treffer ist ein eigener Block mit Titel-Link und (meist) Kurzbeschreibung.
      for (const block of r.text.split(/<div[^>]+class="[^"]*\bresult\b/).slice(1)) {
        if (hits.length >= 8) break;
        const a = block.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
        if (!a) continue;
        let href = decodeEntities(a[1]);
        const u = href.match(/[?&]uddg=([^&]+)/); if (u) href = decodeURIComponent(u[1]);
        if (/duckduckgo\.com\/y\.js|result--ad/.test(href + block.slice(0, 200))) continue; // Werbung
        const sn = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/);
        hits.push((hits.length + 1) + ". " + htmlToText(a[2]) + "\n   " + href + (sn ? "\n   " + htmlToText(sn[1]).slice(0, 300) : ""));
      }
      return { result: hits.length ? "Suchergebnisse für „" + q + "“:\n\n" + hits.join("\n\n") + "\n\nMit fetch kannst du eine Seite genauer lesen." : "Keine Suchergebnisse für „" + q + "“." };
    }
    return { result: "Unbekanntes Werkzeug: " + t.name };
  } catch (e) { return { result: "FEHLER: " + (e.name === "AbortError" ? "Zeitüberschreitung" : e.message) }; }
}
const isWebTool = (t) => t.name === "fetch" || t.name === "websearch";

// ---------- Aufgabenliste (todo) ----------
/** Werkzeug-Eingabe prüfen → saubere Liste [{ text, done }]. */
function normalizeTodos(t) {
  const items = Array.isArray(t && t.items) ? t.items : [];
  return items.slice(0, 40).map((x) => (typeof x === "string" ? { text: x, done: false } : { text: String((x && x.text) || "").slice(0, 200), done: !!(x && x.done) })).filter((x) => x.text);
}
const todoSummary = (items) => "Aufgabenliste aktualisiert (" + items.filter((x) => x.done).length + "/" + items.length + " erledigt).";

// ---------- Eigene Befehle: .mythos/commands/<name>.md ----------
// Erste Zeile = Beschreibung (optional mit "# "), Rest = Anweisung an Mythos. $ARGUMENTS wird ersetzt.
function loadCommands(dirs) {
  const out = new Map();
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((f) => /\.md$/i.test(f)); } catch { continue; }
    for (const f of names) {
      const text = readText(path.join(dir, f));
      if (!text || !text.trim()) continue;
      const name = f.replace(/\.md$/i, "").toLowerCase().replace(/[^a-z0-9äöüß_-]/g, "-");
      const lines = text.replace(/\r\n/g, "\n").split("\n");
      const desc = lines[0].replace(/^#+\s*/, "").trim().slice(0, 100);
      out.set(name, { name: "/" + name, desc: desc || "Eigener Befehl", body: text.trim(), file: path.join(dir, f) });
    }
  }
  return [...out.values()];
}
const fillCommand = (cmd, args) => (cmd.body.includes("$ARGUMENTS") ? cmd.body.split("$ARGUMENTS").join(args || "") : cmd.body + (args ? "\n\n" + args : ""));
const COMMAND_TEMPLATE = "# Tests schreiben für eine Datei\nSchreibe gründliche Tests für $ARGUMENTS.\nNutze das Test-Framework, das im Projekt schon verwendet wird, und führe die Tests am Ende aus.\n";

// ---------- Code-Review ----------
const REVIEW_PROMPT = "Führe ein gründliches Code-Review der folgenden Änderungen durch. ÄNDERE KEINE DATEIEN – nur lesen und bewerten.\n" +
  "Gliedere die Antwort so:\n**🐞 Fehler** (echte Bugs, mit Datei:Zeile)\n**⚠️ Risiken** (Sicherheit, Randfälle, Performance)\n**💡 Verbesserungen** (Lesbarkeit, Vereinfachung)\n**✅ Gut gelöst**\n" +
  "Wenn eine Kategorie leer ist, schreib „nichts gefunden“. Sei konkret, keine allgemeinen Floskeln.";

// ---------- Projektstatistik ----------
const LANG = { js: "JavaScript", mjs: "JavaScript", cjs: "JavaScript", jsx: "JavaScript (JSX)", ts: "TypeScript", tsx: "TypeScript (TSX)", py: "Python", java: "Java", kt: "Kotlin", cs: "C#", cpp: "C++", cc: "C++", c: "C", h: "C/C++ Header", go: "Go", rs: "Rust", rb: "Ruby", php: "PHP", swift: "Swift", html: "HTML", css: "CSS", scss: "SCSS", vue: "Vue", svelte: "Svelte", json: "JSON", md: "Markdown", yml: "YAML", yaml: "YAML", sql: "SQL", sh: "Shell", ps1: "PowerShell", bat: "Batch", lua: "Lua", dart: "Dart", xml: "XML", toml: "TOML" };
function projectStats(root) {
  const byLang = new Map(), big = [];
  let files = 0, lines = 0, bytes = 0, skipped = 0;
  const walk = (dir) => {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (files > 30000) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full); continue; }
      const ext = path.extname(e.name).slice(1).toLowerCase(), lang = LANG[ext];
      if (!lang) { skipped++; continue; }
      let st; try { st = fs.statSync(full); } catch { continue; }
      if (st.size > 2e6) { skipped++; continue; }
      const text = readText(full); if (text == null) continue;
      const n = text ? text.split("\n").length : 0;
      files++; lines += n; bytes += st.size;
      const l = byLang.get(lang) || { files: 0, lines: 0 }; l.files++; l.lines += n; byLang.set(lang, l);
      big.push({ file: path.relative(root, full).split(path.sep).join("/"), lines: n });
    }
  };
  walk(root);
  big.sort((a, b) => b.lines - a.lines);
  const langs = [...byLang.entries()].sort((a, b) => b[1].lines - a[1].lines);
  const fmt = (n) => n.toLocaleString("de-DE");
  let md = "### 📊 Projektstatistik: " + path.basename(root) + "\n\n";
  md += "**" + fmt(files) + " Code-Dateien · " + fmt(lines) + " Zeilen · " + (bytes / 1024 / 1024).toFixed(1) + " MB**" + (skipped ? " (" + fmt(skipped) + " andere Dateien übersprungen)" : "") + "\n\n";
  if (langs.length) {
    md += "| Sprache | Dateien | Zeilen | Anteil |\n|---|---:|---:|---:|\n";
    md += langs.slice(0, 12).map(([name, v]) => "| " + name + " | " + fmt(v.files) + " | " + fmt(v.lines) + " | " + Math.round((v.lines / Math.max(1, lines)) * 100) + " % |").join("\n") + "\n\n";
  }
  if (big.length) md += "**Größte Dateien:**\n" + big.slice(0, 5).map((b) => "- `" + b.file + "` – " + fmt(b.lines) + " Zeilen").join("\n") + "\n";
  return md;
}

// ---------- Chat als Markdown ----------
function chatToMarkdown(title, messages) {
  const date = new Date().toLocaleString("de-DE");
  let md = "# " + (title || "Mythos-Chat") + "\n\n_Exportiert aus Mythos Code am " + date + "_\n\n---\n\n";
  for (const m of messages) md += (m.role === "user" ? "## 🧑 Du\n\n" : m.role === "tool" ? "#### ⚙ " : "## ✦ Mythos\n\n") + String(m.text || "").trim() + "\n\n";
  return md;
}

function readMemory(root) { const t = readText(path.join(root, MEMORY_FILE)); return t ? t.slice(0, 8000) : ""; }
function addMemory(root, text) {
  const f = path.join(root, MEMORY_FILE);
  const cur = readText(f) || "# Projekt-Gedächtnis\n\nMythos liest diese Datei bei jeder Aufgabe mit.\n";
  fs.writeFileSync(f, cur.replace(/\s*$/, "\n") + "- " + String(text).trim() + "\n");
  return f;
}

/** Handy-Benachrichtigung: ntfy.sh-Thema, Discord-Webhook oder beliebige URL (JSON-POST). */
async function pushNotify(url, title, message) {
  if (!url) return false;
  try {
    const u = new URL(url);
    let target = url, body;
    if (/(^|\.)discord(app)?\.com$/.test(u.hostname)) body = { content: "**" + title + "**\n" + message };
    else if (/ntfy/.test(u.hostname)) { target = u.origin; body = { topic: u.pathname.replace(/^\/+|\/+$/g, ""), title, message }; }
    else body = { title, message };
    const r = await fetch(target, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return r.ok;
  } catch { return false; }
}


const CFG = () => path.join(app.getPath("userData"), "mythos.json");
const canEncrypt = () => { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } };
function load() {
  let c; try { c = JSON.parse(fs.readFileSync(CFG(), "utf8")); } catch { return {}; }
  if (c.keyEnc) { try { c.key = safeStorage.decryptString(Buffer.from(c.keyEnc, "base64")); } catch { /* auf anderem PC verschlüsselt */ } delete c.keyEnc; }
  return c;
}
function save(c) {
  const out = Object.assign({}, c);
  if (out.key && canEncrypt()) { out.keyEnc = safeStorage.encryptString(out.key).toString("base64"); delete out.key; }
  const tmp = CFG() + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(out, null, 2)); fs.renameSync(tmp, CFG());
}
/** Nur Projekte, denen der Nutzer vertraut, dürfen eigene Hooks und MCP-Server starten. */
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const isTrusted = (cwd) => !!cwd && (load().trusted || []).some((t) => samePath(t, cwd));
// Unerwartete Fehler protokollieren statt die App abstürzen zu lassen.
const logError = (e) => { try { fs.appendFileSync(path.join(app.getPath("userData"), "error.log"), new Date().toISOString() + " " + (e && e.stack || e) + "\n"); } catch { /* egal */ } };
process.on("uncaughtException", logError);
process.on("unhandledRejection", logError);
let w = null, tray = null, working = false, quitting = false, blocker = null;
const showWin = () => { if (w) { w.show(); w.focus(); } };
function win() {
  w = new BrowserWindow({ width: 1200, height: 820, minWidth: 720, minHeight: 520, backgroundColor: "#0a0a0a", title: "Mythos Code",
    icon: path.join(__dirname, "icon.png"),
    autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false } });
  w.webContents.setWindowOpenHandler(({ url }) => { if (safeUrl(url)) shell.openExternal(url); return { action: "deny" }; });
  w.webContents.on("will-navigate", (e, url) => { if (!url.startsWith("file:")) { e.preventDefault(); if (safeUrl(url)) shell.openExternal(url); } });
  w.loadFile("index.html");
  // AFK: Schließen, während Mythos arbeitet, versteckt das Fenster nur – die Arbeit läuft im Tray weiter.
  w.on("close", (e) => { if (working && !quitting) { e.preventDefault(); w.hide(); toTray(); } });
}
function toTray() {
  if (!tray) {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, "icon.png")).resize({ width: 16, height: 16 }));
    tray.setToolTip("Mythos Code");
    tray.setContextMenu(Menu.buildFromTemplate([{ label: "Öffnen", click: showWin }, { label: "Beenden", click: () => { quitting = true; app.quit(); } }]));
    tray.on("click", showWin);
  }
  if (Notification.isSupported()) new Notification({ title: "Mythos Code", body: "Mythos arbeitet im Hintergrund weiter. Klick auf das Symbol unten rechts zum Öffnen." }).show();
}
const single = app.requestSingleInstanceLock();
if (!single) app.quit(); else app.on("second-instance", showWin);
app.whenReady().then(() => {
  const allowed = new Set(["media", "display-capture", "notifications", "clipboard-read", "clipboard-sanitized-write", "fullscreen"]);
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(allowed.has(perm) && wc === (w && w.webContents)));
  session.defaultSession.setPermissionCheckHandler((wc, perm) => allowed.has(perm));
  // Sprachmodus „Bildschirm teilen“: nur auf Knopfdruck im Fenster, dann den Hauptbildschirm freigeben.
  session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
    desktopCapturer.getSources({ types: ["screen"] }).then((src) => cb(src.length ? { video: src[0] } : {})).catch(() => cb({}));
  });
  win();
});
app.on("before-quit", () => { quitting = true; });
app.on("window-all-closed", () => app.quit());

// ---------- Browser-Plugin: sichere lokale Brücke (nur dieser PC) ----------
const browserBridge = { server: null, port: 0, token: "", code: "", paired: false, lastSeen: 0, tasks: [], events: [], stopped: false, pending: new Map() };
const tokenOk = (t) => { const a = Buffer.from(String(t || "")), b = Buffer.from(browserBridge.token); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const bridgeJson = (res, status, body) => { const origin = String(res.req.headers.origin || ""); res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": origin.startsWith("chrome-extension://") ? origin : "null", "Access-Control-Allow-Headers": "content-type,x-mythos-token", "Vary": "Origin" }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve) => { let s = ""; req.on("data", (d) => { s += d; if (s.length > 100000) req.destroy(); }); req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch { resolve({}); } }); });
function bridgeState() { return { running: !!browserBridge.server, port: browserBridge.port, code: browserBridge.code, paired: browserBridge.paired, connected: browserBridge.paired && Date.now() - browserBridge.lastSeen < 7000 }; }
function bridgeEvent(ev) { const item = { id: crypto.randomUUID(), at: Date.now(), ...ev }; browserBridge.events.push(item); browserBridge.events = browserBridge.events.slice(-200); send("browser-event", item); if (item.taskId && (item.kind === "done" || item.kind === "error")) { const w = browserBridge.pending.get(item.taskId); if (w) { browserBridge.pending.delete(item.taskId); w(item); } } }
async function startBrowserBridge() {
  if (browserBridge.server) return bridgeState();
  browserBridge.token = crypto.randomBytes(32).toString("hex"); browserBridge.code = String(crypto.randomInt(100000, 1000000));
  browserBridge.server = http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") { const origin = String(req.headers.origin || ""); res.writeHead(204, { "Access-Control-Allow-Origin": origin.startsWith("chrome-extension://") ? origin : "null", "Access-Control-Allow-Headers": "content-type,x-mythos-token", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Vary": "Origin" }); return res.end(); }
    const url = new URL(req.url, "http://127.0.0.1"); const body = await readBody(req);
    if (url.pathname === "/pair" && req.method === "POST") {
      if (String(body.code || "") !== browserBridge.code) return bridgeJson(res, 403, { error: "Kopplungscode falsch" });
      browserBridge.paired = true; browserBridge.lastSeen = Date.now(); bridgeEvent({ kind: "status", text: "Browser-Plugin verbunden" });
      return bridgeJson(res, 200, { token: browserBridge.token, name: "Mythos Code" });
    }
    if (!browserBridge.paired || !tokenOk(req.headers["x-mythos-token"])) return bridgeJson(res, 401, { error: "Nicht gekoppelt" });
    browserBridge.lastSeen = Date.now();
    if (url.pathname === "/status") return bridgeJson(res, 200, { ok: true, stopped: browserBridge.stopped });
    if (url.pathname === "/tasks") { const tasks = browserBridge.tasks.splice(0); return bridgeJson(res, 200, { tasks }); }
    if (url.pathname === "/events" && req.method === "POST") { bridgeEvent(body); return bridgeJson(res, 200, { ok: true }); }
    if (url.pathname === "/stop" && req.method === "POST") { browserBridge.stopped = true; bridgeEvent({ kind: "status", text: "Browser-Aufgabe gestoppt" }); return bridgeJson(res, 200, { ok: true }); }
    return bridgeJson(res, 404, { error: "Unbekannter Pfad" });
  });
  await new Promise((resolve, reject) => { browserBridge.server.once("error", reject); browserBridge.server.listen(47831, "127.0.0.1", resolve); });
  browserBridge.port = browserBridge.server.address().port; return bridgeState();
}
ipcMain.handle("browser:start", () => startBrowserBridge());
ipcMain.handle("browser:state", () => bridgeState());
ipcMain.handle("browser:pair-reset", async () => { browserBridge.paired = false; browserBridge.token = crypto.randomBytes(32).toString("hex"); browserBridge.code = String(crypto.randomInt(100000, 1000000)); browserBridge.tasks = []; return startBrowserBridge(); });
ipcMain.handle("browser:task", async (_e, task) => { await startBrowserBridge(); if (!browserBridge.paired) return { ok: false, error: "Browser-Plugin ist nicht gekoppelt" }; const item = { id: crypto.randomUUID(), task: String(task || "").slice(0, 1500), at: Date.now() }; browserBridge.stopped = false; browserBridge.tasks.push(item); bridgeEvent({ kind: "task", text: item.task, taskId: item.id }); return { ok: true, id: item.id }; });
ipcMain.handle("browser:stop", () => { browserBridge.stopped = true; bridgeEvent({ kind: "status", text: "Stopp angefordert" }); return true; });
// AFK: Solange Mythos arbeitet, geht der PC nicht in den Energiesparmodus.
ipcMain.handle("working", (_e, on) => {
  working = !!on;
  if (working && blocker == null) blocker = powerSaveBlocker.start("prevent-app-suspension");
  if (!working && blocker != null) { powerSaveBlocker.stop(blocker); blocker = null; }
  return true;
});
ipcMain.handle("notify", (_e, title, body) => {
  if ((w && w.isVisible() && w.isFocused()) || !Notification.isSupported()) return false;
  const n = new Notification({ title, body }); n.on("click", showWin); n.show(); return true;
});
ipcMain.handle("cfg:get", () => load());
ipcMain.handle("cfg:set", (_e, c) => { save(c || {}); return true; });
const safeUrl = (u) => /^(https?:\/\/|mailto:)/i.test(String(u || ""));
ipcMain.handle("open", (_e, url) => (safeUrl(url) ? shell.openExternal(url) : false));
ipcMain.handle("pickFolder", async () => { const r = await dialog.showOpenDialog({ properties: ["openDirectory"] }); return r.canceled ? null : r.filePaths[0]; });
ipcMain.handle("pickFiles", async () => {
  const r = await dialog.showOpenDialog({ properties: ["openFile", "multiSelections"] });
  if (r.canceled) return [];
  const IMG = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
  return r.filePaths.map((p) => {
    const mt = IMG[path.extname(p).slice(1).toLowerCase()];
    if (mt) { try { return { name: path.basename(p), image: { media_type: mt, data: fs.readFileSync(p).toString("base64") } }; } catch {} }
    let c = ""; try { c = fs.readFileSync(p, "utf8").slice(0, 60000); } catch { c = "(Binärdatei)"; }
    return { name: path.basename(p), path: p, content: c };
  });
});
// Gespeicherte Chats: ein JSON pro Chat im Benutzerordner.
const CHATS = () => path.join(app.getPath("userData"), "chats");
const chatFile = (id) => path.join(CHATS(), String(id || "").replace(/[^a-zA-Z0-9_-]/g, "") + ".json");
ipcMain.handle("chats:list", () => {
  let names = []; try { names = fs.readdirSync(CHATS()).filter((f) => f.endsWith(".json")); } catch { return []; }
  return names.map((f) => { try { const c = JSON.parse(fs.readFileSync(path.join(CHATS(), f), "utf8")); return { id: c.id, title: c.title, folder: c.folder, updated: c.updated }; } catch { return null; } })
    .filter(Boolean).sort((a, b) => b.updated - a.updated);
});
ipcMain.handle("chats:get", (_e, id) => { try { return JSON.parse(fs.readFileSync(chatFile(id), "utf8")); } catch { return null; } });
ipcMain.handle("chats:save", (_e, c) => { fs.mkdirSync(CHATS(), { recursive: true }); fs.writeFileSync(chatFile(c.id), JSON.stringify(c)); return true; });
ipcMain.handle("chats:delete", (_e, id) => { try { fs.unlinkSync(chatFile(id)); } catch {} return true; });
// Chats durchsuchen: Titel und Inhalt aller gespeicherten Chats.
ipcMain.handle("chats:search", (_e, q) => {
  const needle = String(q || "").toLowerCase().trim();
  if (!needle) return [];
  let names = []; try { names = fs.readdirSync(CHATS()).filter((f) => f.endsWith(".json")); } catch { return []; }
  const hits = [];
  for (const f of names) {
    let c; try { c = JSON.parse(fs.readFileSync(path.join(CHATS(), f), "utf8")); } catch { continue; }
    let snippet = (c.title || "").toLowerCase().includes(needle) ? c.title : "";
    if (!snippet) for (const m of c.history || []) {
      const t = String(m.content || ""), k = t.toLowerCase().indexOf(needle);
      if (k >= 0) { snippet = (k > 30 ? "…" : "") + t.slice(Math.max(0, k - 30), k + needle.length + 50).replace(/\s+/g, " "); break; }
    }
    if (snippet) hits.push({ id: c.id, title: c.title, folder: c.folder, updated: c.updated, snippet });
  }
  return hits.sort((a, b) => b.updated - a.updated).slice(0, 50);
});

// ---------- Werkzeuge ----------
const send = (ch, payload) => { if (w && !w.isDestroyed()) w.webContents.send(ch, payload); };
const mcp = new McpManager({ onChange: () => send("mcp-changed", mcp.status()) });
app.on("will-quit", () => { mcp.stopAll(); killAll(); });

// System-Prompt: Werkzeuge + verbundene MCP-Werkzeuge + Gedächtnis + Ziel.
function mcpPrompt() {
  const tools = mcp.status().filter((s) => s.status === "connected").flatMap((s) => s.tools.map((t) => ({ server: s.name, ...t })));
  if (!tools.length) return "";
  const args = (t) => (t.inputSchema && t.inputSchema.properties
    ? " · args: " + JSON.stringify(Object.fromEntries(Object.entries(t.inputSchema.properties).map(([k, v]) => [k, (v && v.type) || "any"]))).slice(0, 200) : "");
  return '\n\nMCP-Werkzeuge (externe Server) – Aufruf: <tool>{"name":"mcp","server":"...","tool":"...","args":{...}}</tool>\n' +
    tools.slice(0, 60).map((t) => "- " + t.server + " / " + t.name + ": " + (t.description || "").replace(/\s+/g, " ").slice(0, 160) + args(t)).join("\n");
}
function browserPrompt() {
  if (!bridgeState().connected) return "";
  return '\n\nBrowser-Plugin – Aufruf: <tool>{"name":"browser","task":"konkrete Browser-Aufgabe"}</tool>. Nutze es, wenn die Aufgabe echte Webseiten bedienen oder lesen soll. Logins, Passwörter, Zahlungen und Captchas übernimmt immer der Nutzer.';
}
ipcMain.handle("prompt:system", (_e, folder, goal) => TOOL_PROMPT + mcpPrompt() + browserPrompt() + memoryPrompt(folder ? readMemory(folder) : "") + goalPrompt(goal));
ipcMain.handle("prompts", () => ({ nudge: GOAL_NUDGE, summary: SUMMARY_PROMPT, review: REVIEW_PROMPT, memoryFile: MEMORY_FILE, models: MODELS }));

// Laufende Prozesse je Kennung – mehrere Aufgaben (und das Terminal) laufen parallel.
const children = new Map();
function killTree(p) { try { if (process.platform === "win32") exec("taskkill /pid " + p.pid + " /T /F"); else p.kill(); } catch {} }
function killAll() { for (const p of children.values()) killTree(p); }
ipcMain.handle("abort", (_e, id) => { const p = children.get(id); if (p) killTree(p); return true; });

/** Befehl ausführen, Ausgabe live ans Fenster ({ id, chunk } auf `channel`). Ergebnis: { text, code }. */
function runLive(cmd, cwd, id, channel, timeoutMs = 600000, env) {
  return new Promise((res) => {
    let out = "";
    const p = spawn(cmd, { cwd: cwd || undefined, shell: true, windowsHide: true, env: { ...process.env, ...(env || {}) } });
    children.set(id, p);
    const on = (decode) => (d) => { const s = decode(d); out += s; if (out.length > 200000) out = out.slice(-100000); send(channel, { id, chunk: s }); };
    p.stdout.on("data", on(outputDecoder())); p.stderr.on("data", on(outputDecoder()));
    const to = setTimeout(() => { out += "\n[Nach " + Math.round(timeoutMs / 60000) + " Minuten abgebrochen]"; killTree(p); }, timeoutMs);
    p.on("error", (e) => { out += "\nFEHLER: " + e.message; });
    p.on("close", (code) => { clearTimeout(to); if (children.get(id) === p) children.delete(id); res({ text: out, code: code == null ? 1 : code }); });
  });
}

// ---------- Hooks: <projekt>/.mythos/hooks.json und hooks.json im App-Datenordner ----------
// Format wie bei Claude Code: { "PreToolUse": [{ "matcher": "edit|write", "command": "..." }], "PostToolUse": [...], "Stop": [...] }
// Exit-Code 2 bei PreToolUse blockiert das Werkzeug (Ausgabe geht als Begründung an Mythos).
const readJsonFile = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fallback; } };
function loadHooks(cwd) {
  const all = {};
  const sources = [readJsonFile(path.join(app.getPath("userData"), "hooks.json"), {}), cwd && isTrusted(cwd) ? readJsonFile(path.join(cwd, ".mythos", "hooks.json"), {}) : {}];
  for (const src of sources) for (const [ev, list] of Object.entries(src.hooks || src)) if (Array.isArray(list)) (all[ev] = all[ev] || []).push(...list);
  return all;
}
function hookMatches(h, toolName) {
  if (!h || !h.command || h.disabled) return false;
  if (!h.matcher || !toolName) return true;
  try { return new RegExp("^(" + h.matcher + ")$", "i").test(toolName); } catch { return false; }
}
function runHooks(event, payload, cwd) {
  const list = (loadHooks(cwd)[event] || []).filter((h) => hookMatches(h, payload.tool_name));
  return Promise.all(list.map((h) => new Promise((res) => {
    const p = spawn(h.command, { cwd: cwd || undefined, shell: true, windowsHide: true, env: { ...process.env, MYTHOS_PROJECT_DIR: cwd || "", MYTHOS_HOOK_EVENT: event } });
    let out = "";
    const d1 = outputDecoder(), d2 = outputDecoder();
    const t = setTimeout(() => killTree(p), (h.timeout || 60) * 1000);
    p.stdout.on("data", (d) => (out += d1(d))); p.stderr.on("data", (d) => (out += d2(d)));
    p.on("close", (code) => { clearTimeout(t); res({ event, command: h.command, code: code == null ? 1 : code, out: out.trim().slice(-4000) }); });
    p.on("error", (e) => { clearTimeout(t); res({ event, command: h.command, code: 1, out: e.message }); });
    p.stdin.on("error", () => {});
    p.stdin.end(JSON.stringify({ hook_event_name: event, cwd, ...payload }));
  })));
}
ipcMain.handle("hooks:run", (_e, event, payload, cwd) => runHooks(event, payload, cwd));
ipcMain.handle("hooks:list", (_e, cwd) => loadHooks(cwd));

// Ein Werkzeug ausführen (mit Hooks). Liefert { result, diff?, code?, hooks }.
ipcMain.handle("tool", async (_e, t, cwd, runId) => {
  const root = cwd || process.cwd();
  const toolName = t.name === "mcp" ? "mcp__" + t.server + "__" + t.tool : t.name;
  const pre = await runHooks("PreToolUse", { tool_name: toolName, tool_input: t }, cwd);
  const blocked = pre.filter((h) => h.code === 2);
  if (blocked.length) return { result: "Durch Hook blockiert: " + (blocked.map((h) => h.out).join("\n") || "ohne Begründung"), hooks: pre };
  let r;
  if (t.name === "run") {
    const x = await runLive(t.cmd, root, runId, "tool-output");
    r = { result: (x.text + (x.code ? "\nExit: " + x.code : "")).slice(-8000) || "(keine Ausgabe)", code: x.code };
  } else if (isWebTool(t)) r = await webTool(t);
  else if (t.name === "mcp") { const x = await mcp.call(t.server, t.tool, t.args || {}); r = { result: String(x.output).slice(0, 20000) }; }
  else if (t.name === "browser") { const st = bridgeState(); if (!st.connected) r = { result: "FEHLER: Browser-Plugin nicht verbunden" }; else { const item = { id: crypto.randomUUID(), task: String(t.task || "").slice(0, 1500), at: Date.now() }; browserBridge.stopped = false; const done = new Promise((res) => { browserBridge.pending.set(item.id, res); setTimeout(() => { if (browserBridge.pending.delete(item.id)) res({ kind: "error", text: "Zeitüberschreitung (5 Min)" }); }, 300000); }); browserBridge.tasks.push(item); bridgeEvent({ kind: "task", text: item.task, taskId: item.id }); const ev = await done; r = { result: (ev.kind === "done" ? "Browser-Ergebnis: " : "FEHLER: ") + String(ev.text || "").slice(0, 8000) }; } }
  else r = fileTool(t, root);
  const post = await runHooks("PostToolUse", { tool_name: toolName, tool_input: t, tool_output: r.result.slice(0, 4000) }, cwd);
  const notes = post.filter((h) => h.out || h.code).map((h) => "[Hook „" + h.command + "“ → Exit " + h.code + "]\n" + h.out);
  if (notes.length) r.result += "\n\nHook-Ausgabe:\n" + notes.join("\n");
  return { ...r, hooks: pre.concat(post) };
});

// ---------- Automatisch testen ----------
ipcMain.handle("tests:detect", (_e, cwd) => {
  if (!cwd) return null;
  const has = (f) => fs.existsSync(path.join(cwd, f));
  const pkg = readJsonFile(path.join(cwd, "package.json"), null);
  const t = pkg && pkg.scripts && pkg.scripts.test;
  if (t && !/no test specified/i.test(t)) return "npm test";
  if (has("Cargo.toml")) return "cargo test";
  if (has("go.mod")) return "go test ./...";
  if (has("pytest.ini") || has("conftest.py") || (has("tests") && fs.readdirSync(path.join(cwd, "tests")).some((f) => /^test_.*\.py$|_test\.py$/.test(f)))) return "python -m pytest -q";
  if (has("pom.xml")) return "mvn -q test";
  return null;
});
// CI=1: Test-Runner wie vitest/jest laufen einmal durch statt im Watch-Modus.
ipcMain.handle("tests:run", async (_e, cwd, cmd, runId) => {
  const x = await runLive(cmd, cwd, runId, "tool-output", 600000, { CI: "1", FORCE_COLOR: "0" });
  return { text: x.text.slice(-8000), code: x.code };
});

// ---------- MCP-Server: <projekt>/.mcp.json und mcp.json im App-Datenordner ----------
ipcMain.handle("mcp:configure", (_e, cwd) => {
  const servers = (f) => readJsonFile(f, {}).mcpServers || {};
  mcp.configure(servers(path.join(app.getPath("userData"), "mcp.json")), { cwd, servers: cwd && isTrusted(cwd) ? servers(path.join(cwd, ".mcp.json")) : {} });
  return mcp.status();
});
ipcMain.handle("mcp:status", () => mcp.status());
ipcMain.handle("mcp:restart", (_e, name) => mcp.restart(name));
// Konfigurationsdatei öffnen (bei Bedarf mit Vorlage anlegen).
ipcMain.handle("config:open", (_e, which, cwd) => {
  const file = which === "mcp-global" ? path.join(app.getPath("userData"), "mcp.json")
    : which === "mcp-project" ? path.join(cwd, ".mcp.json")
    : which === "hooks-global" ? path.join(app.getPath("userData"), "hooks.json")
    : path.join(cwd, ".mythos", "hooks.json");
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tpl = /mcp/.test(which)
      ? { mcpServers: { beispiel: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."], disabled: true } } }
      : { PreToolUse: [], PostToolUse: [{ matcher: "edit|write", command: "echo Datei geändert", disabled: true }], Stop: [] };
    fs.writeFileSync(file, JSON.stringify(tpl, null, 2));
  }
  shell.openPath(file);
  return file;
});

// ---------- Live-Vorschau: eigenes Fenster, lädt bei Dateiänderungen neu ----------
let preview = null, watcher = null, reloadTimer = null;
ipcMain.handle("preview:open", (_e, target, cwd) => {
  let url = String(target || "").trim();
  if (!url) {
    const idx = cwd && ["index.html", "public/index.html", "dist/index.html", "build/index.html"].map((f) => path.join(cwd, f)).find((f) => fs.existsSync(f));
    if (!idx) return { error: "Keine index.html gefunden – gib eine Adresse an, z. B. /vorschau http://localhost:5173" };
    url = idx;
  } else if (!/^https?:\/\//i.test(url)) {
    const f = path.resolve(cwd || ".", url);
    if (!fs.existsSync(f)) return { error: "Nicht gefunden: " + url };
    url = f;
  }
  if (!preview || preview.isDestroyed()) {
    preview = new BrowserWindow({ width: 1024, height: 768, title: "Mythos Code – Vorschau", icon: path.join(__dirname, "icon.png"), autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, sandbox: true } });
    preview.webContents.setWindowOpenHandler(({ url: u }) => { shell.openExternal(u); return { action: "deny" }; });
    preview.on("closed", () => { preview = null; if (watcher) { watcher.close(); watcher = null; } });
  }
  if (/^https?:/i.test(url)) preview.loadURL(url); else preview.loadFile(url);
  preview.show(); preview.focus();
  if (watcher) { watcher.close(); watcher = null; }
  if (cwd) {
    try {
      watcher = fs.watch(cwd, { recursive: true }, (_ev, f) => {
        if (!f || /(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(f)) return;
        clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => { if (preview && !preview.isDestroyed()) preview.webContents.reloadIgnoringCache(); }, 400);
      });
    } catch {}
  }
  return { ok: true, url };
});

// ---------- Dateibaum & Editor ----------
const inside = (cwd, rel) => { const f = path.resolve(cwd, rel || "."); const r = path.relative(path.resolve(cwd), f); return r.startsWith("..") || path.isAbsolute(r) ? null : f; };
ipcMain.handle("files:list", (_e, cwd, rel) => {
  const dir = cwd && inside(cwd, rel);
  if (!dir) return [];
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.name !== ".git")
      .map((e) => ({ name: e.name, dir: e.isDirectory(), rel: path.relative(cwd, path.join(dir, e.name)).split(path.sep).join("/") }))
      .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, "de"));
  } catch { return []; }
});
ipcMain.handle("files:read", (_e, cwd, rel) => {
  const f = cwd && inside(cwd, rel);
  if (!f) return { error: "Ungültiger Pfad" };
  try {
    const st = fs.statSync(f);
    if (st.size > 2e6) return { error: "Datei zu groß (" + (st.size / 1e6).toFixed(1) + " MB)" };
    const buf = fs.readFileSync(f);
    if (buf.includes(0)) return { error: "Binärdatei – kann hier nicht angezeigt werden" };
    return { text: buf.toString("utf8") };
  } catch (e) { return { error: e.message }; }
});
ipcMain.handle("files:save", (_e, cwd, rel, text) => {
  const f = cwd && inside(cwd, rel);
  if (!f) return { error: "Ungültiger Pfad" };
  try { const before = readText(f) ?? ""; fs.writeFileSync(f, text); return { ok: true, diff: lineDiff(before, text) }; } catch (e) { return { error: e.message }; }
});
ipcMain.handle("files:reveal", (_e, cwd, rel) => { const f = cwd && inside(cwd, rel); if (f) shell.showItemInFolder(f); return !!f; });

// ---------- Eingebautes Terminal ----------
ipcMain.handle("term:run", (_e, cwd, cmd) => runLive(cmd, cwd, "term", "term-output", 30 * 60000));
ipcMain.handle("term:kill", () => { const p = children.get("term"); if (p) killTree(p); return true; });
ipcMain.handle("term:cd", (_e, cwd, dir) => {
  const d = path.resolve(cwd || require("os").homedir(), dir || require("os").homedir());
  try { return fs.statSync(d).isDirectory() ? d : null; } catch { return null; }
});

// ---------- Projekt-Gedächtnis (MYTHOS.md) ----------
ipcMain.handle("memory:get", (_e, cwd) => (cwd ? readMemory(cwd) : ""));
ipcMain.handle("memory:add", (_e, cwd, text) => { if (!cwd) return false; addMemory(cwd, text); return true; });

// ---------- Handy-Benachrichtigung ----------
ipcMain.handle("push", (_e, url, title, message) => pushNotify(url, title, message));

// ---------- Git ----------
const git = (args, cwd) => new Promise((res) => execFile("git", args, { cwd, timeout: 60000, maxBuffer: 1e7, windowsHide: true },
  (err, so, se) => res({ ok: !err, out: (so || "") + (se || "") })));
ipcMain.handle("git:info", async (_e, cwd) => {
  if (!cwd) return null;
  const b = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (!b.ok) return null;
  const s = await git(["status", "--porcelain"], cwd);
  return { branch: b.out.trim(), changed: s.out.split("\n").filter(Boolean).length, status: s.out };
});
ipcMain.handle("git:diff", async (_e, cwd) => {
  const st = await git(["status", "--short"], cwd);
  let d = await git(["diff", "HEAD"], cwd);
  if (!d.ok) d = await git(["diff"], cwd);
  return st.out + "\n" + d.out.slice(0, 20000);
});
ipcMain.handle("git:commit", async (_e, cwd, msg) => {
  const a = await git(["add", "-A"], cwd);
  if (!a.ok) return a;
  return git(["commit", "-m", msg], cwd);
});
ipcMain.handle("git:push", (_e, cwd) => git(["push"], cwd));

// ---------- Eigene Befehle (.mythos/commands/*.md im Projekt + commands/ im App-Datenordner) ----------
const commandDirs = (cwd) => [path.join(app.getPath("userData"), "commands"), cwd ? path.join(cwd, ".mythos", "commands") : null].filter(Boolean);
ipcMain.handle("commands:list", (_e, cwd) => loadCommands(commandDirs(cwd)).map((c) => ({ name: c.name, desc: c.desc, body: c.body })));
ipcMain.handle("commands:create", (_e, cwd, name) => {
  const safe = String(name || "mein-befehl").toLowerCase().replace(/[^a-z0-9äöüß_-]/g, "-").replace(/^-+|-+$/g, "") || "mein-befehl";
  const dir = cwd ? path.join(cwd, ".mythos", "commands") : path.join(app.getPath("userData"), "commands");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, safe + ".md");
  if (!fs.existsSync(file)) fs.writeFileSync(file, COMMAND_TEMPLATE);
  shell.openPath(file);
  return { name: "/" + safe, file };
});

// ---------- Projektstatistik ----------
ipcMain.handle("project:stats", (_e, cwd) => (cwd ? projectStats(cwd) : "Kein Projektordner gewählt."));

// ---------- Chat als Markdown exportieren ----------
ipcMain.handle("chats:export", async (_e, title, messages) => {
  const name = String(title || "Mythos-Chat").replace(/[\/:*?"<>|]+/g, " ").trim().slice(0, 60) || "Mythos-Chat";
  const r = await dialog.showSaveDialog(w, { defaultPath: path.join(app.getPath("documents"), name + ".md"), filters: [{ name: "Markdown", extensions: ["md"] }] });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, chatToMarkdown(title, messages));
  return r.filePath;
});

// ---------- Pull Request: Branch pushen, per GitHub-CLI (gh) oder im Browser öffnen ----------
ipcMain.handle("git:pr", async (_e, cwd, newBranch) => {
  const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (!head.ok) return { ok: false, out: "Der Projektordner ist kein Git-Repository." };
  const dirty = await git(["status", "--porcelain"], cwd);
  if (dirty.out.trim()) return { ok: false, out: "Es gibt noch nicht committete Änderungen – erst /commit, dann /pr." };
  const origin = await git(["remote", "get-url", "origin"], cwd);
  if (!origin.ok || !origin.out.trim()) return { ok: false, out: "Kein Remote „origin“ eingerichtet – verbinde das Projekt zuerst mit GitHub (git remote add origin <url>)." };
  let branch = head.out.trim();
  // Von main/master aus einen eigenen Branch anlegen, sonst gäbe es nichts zu vergleichen.
  if (/^(main|master)$/.test(branch)) {
    branch = newBranch || "mythos/" + new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    const co = await git(["checkout", "-b", branch], cwd);
    if (!co.ok) return { ok: false, out: co.out };
  }
  const push = await git(["push", "-u", "origin", branch], cwd);
  if (!push.ok) return { ok: false, out: push.out };
  const gh = await new Promise((res) => execFile("gh", ["pr", "create", "--fill"], { cwd, timeout: 120000, windowsHide: true },
    (err, so, se) => res({ ok: !err, out: ((so || "") + (se || "")).trim(), missing: !!err && err.code === "ENOENT" })));
  if (gh.ok) return { ok: true, branch, out: gh.out, url: (gh.out.match(/https:\/\/\S+/) || [])[0] };
  const remote = await git(["remote", "get-url", "origin"], cwd);
  const m = remote.out.trim().match(/github\.com[:/](.+?)(?:\.git)?$/);
  if (!m) return { ok: false, out: gh.out || "Kein GitHub-Remote (origin) gefunden." };
  const url = "https://github.com/" + m[1] + "/compare/" + branch.split("/").map(encodeURIComponent).join("/") + "?expand=1";
  shell.openExternal(url);
  return { ok: true, branch, url, out: gh.missing ? "GitHub-CLI (gh) ist nicht installiert – die PR-Seite ist im Browser geöffnet." : (gh.out ? gh.out + "\n" : "") + "PR-Seite im Browser geöffnet." };
});

// ---------- @-Erwähnungen: Dateien im Projekt finden ----------
ipcMain.handle("files:find", (_e, cwd, query) => {
  if (!cwd) return [];
  const q = String(query || "").toLowerCase().split("\\").join("/");
  const hits = []; let seen = 0;
  const walk = (dir) => {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (hits.length >= 40 || seen > 8000) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(full); continue; }
      seen++;
      const rel = path.relative(cwd, full).split(path.sep).join("/");
      if (!q || rel.toLowerCase().includes(q)) hits.push(rel);
    }
  };
  walk(cwd);
  // Treffer im Dateinamen zuerst, dann kürzere Pfade.
  const score = (r) => (path.basename(r).toLowerCase().startsWith(q) ? 0 : path.basename(r).toLowerCase().includes(q) ? 1 : 2) * 1000 + r.length;
  return hits.sort((a, b) => score(a) - score(b)).slice(0, 12);
});

// ---------- Sicherheit ----------
ipcMain.handle("safety:check", (_e, cmd) => dangerCheck(cmd));
/** Hat das Projekt eigene Hooks / MCP-Server, die Befehle ausführen würden? */
ipcMain.handle("project:config", (_e, cwd) => {
  if (!cwd) return { hooks: 0, mcp: 0, trusted: false };
  const h = readJsonFile(path.join(cwd, ".mythos", "hooks.json"), {}), m = readJsonFile(path.join(cwd, ".mcp.json"), {});
  const hooks = Object.values(h.hooks || h).filter(Array.isArray).reduce((a, l) => a + l.filter((x) => x && x.command && !x.disabled).length, 0);
  const mcpN = Object.values(m.mcpServers || {}).filter((x) => x && !x.disabled).length;
  return { hooks, mcp: mcpN, trusted: isTrusted(cwd) };
});
ipcMain.handle("safety:status", () => ({ encrypted: canEncrypt(), sandbox: true }));
