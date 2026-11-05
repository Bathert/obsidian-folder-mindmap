'use strict';

const obsidian = require('obsidian');
const fs = require('fs');
const nodePath = require('path');

const { Plugin, ItemView, Modal, Notice, PluginSettingTab, Setting, Menu } = obsidian;

const VIEW_TYPE = 'folder-mindmap-view';
const COL_W = 300;
const ROW_H = 28;
const NODE_H = 22;
const NODE_W = 258;
const PALETTE = ['#58a6ff', '#f78166', '#d2a8ff', '#56d364', '#e3b341', '#ff7b72', '#79c0ff', '#a5d6ff'];

const DEFAULT_SETTINGS = {
  roots: ['E:\\Мой диск'],
  hiddenNames: 'node_modules, .git, __pycache__, .vite, .next, .cache, dist, build, .tmp.drivedownload, .svelte-kit, .turbo, venv, .venv',
  maxChildren: 45,
  maxFiles: 10,
  maxDepth: 14,
  cacheMinutes: 30,
  showFiles: true,
};

const CACHE_VERSION = 2;
const MAX_FILE_LIST = 120;

function fmt(bytes) {
  let v = Number(bytes) || 0;
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const s = v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
  return s.replace('.', ',') + ' ' + units[i];
}

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

function makeNode(name, path, depth) {
  return { name: name, path: path, depth: depth, size: 0, total: 0, files: 0, dirs: 0, kids: [], fileList: [], moreFiles: 0 };
}

function aggregate(node) {
  node.total = node.size;
  node.dirs = 0;
  node.deep = node.depth;
  for (const k of node.kids) {
    aggregate(k);
    node.total += k.total;
    node.dirs += 1 + k.dirs;
    if (k.deep > node.deep) node.deep = k.deep;
  }
  node.kids.sort((a, b) => b.total - a.total);
  return node.total;
}

const SCAN_CONCURRENCY = 8;

async function scanFolder(rootPath, options, hooks) {
  const hidden = new Set((options.hiddenNames || []).map((s) => String(s).toLowerCase()));
  const maxDepth = Math.max(1, Math.min(40, Number(options.maxDepth) || 12));
  const onProgress = hooks && hooks.onProgress;
  const isCancelled = hooks && hooks.isCancelled;
  const started = Date.now();
  const fsp = fs.promises;

  const rootName = nodePath.basename(rootPath) || rootPath;
  const root = makeNode(rootName, rootPath, 0);
  if (!fs.existsSync(rootPath)) throw new Error('папка не найдена');

  const queue = [[rootPath, root]];
  let seen = 0;

  const takeDir = async (dir, node) => {
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      node.error = true;
      return;
    }
    const subdirs = [];
    const files = [];
    for (const entry of entries) {
      const full = nodePath.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let st = null;
        try {
          st = await fsp.stat(full);
        } catch (e) {
          st = null;
        }
        if (st && st.isDirectory()) subdirs.push({ name: entry.name, full: full });
        else if (st && st.isFile()) files.push({ name: entry.name, full: full });
        continue;
      }
      if (entry.isDirectory()) subdirs.push({ name: entry.name, full: full });
      else if (entry.isFile()) files.push({ name: entry.name, full: full });
    }

    for (const d of subdirs) {
      if (hidden.has(d.name.toLowerCase())) continue;
      if (node.depth + 1 > maxDepth) continue;
      const child = makeNode(d.name, d.full, node.depth + 1);
      node.kids.push(child);
      queue.push([d.full, child]);
    }

    const CHUNK = 32;
    for (let i = 0; i < files.length; i += CHUNK) {
      const slice = files.slice(i, i + CHUNK);
      const sizes = await Promise.all(slice.map((f) => fsp.stat(f.full).then((st) => st.size).catch(() => null)));
      for (let j = 0; j < slice.length; j++) {
        if (sizes[j] === null) continue;
        node.size += sizes[j];
        node.files += 1;
        node.fileList.push({ n: slice[j].name, s: sizes[j] });
      }
    }

    if (node.fileList.length > MAX_FILE_LIST) {
      node.fileList.sort((a, b) => b.s - a.s);
      node.moreFiles = node.fileList.length - MAX_FILE_LIST;
      node.fileList.length = MAX_FILE_LIST;
    }

    seen += 1;
    if (seen % 20 === 0 && onProgress) onProgress(seen, node.path);
  };

  const worker = async () => {
    while (queue.length) {
      if (isCancelled && isCancelled()) throw new Error('отменено');
      const item = queue.shift();
      if (!item) return;
      await takeDir(item[0], item[1]);
    }
  };

  await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, () => worker()));

  aggregate(root);
  const totalFiles = countFiles(root);
  const stats = {
    ms: Date.now() - started,
    dirs: root.dirs,
    files: totalFiles,
    size: root.total,
    deep: root.deep,
  };
  if (onProgress) onProgress(seen, rootPath);
  return { root: root, stats: stats };
}

function countFiles(node) {
  let n = node.files;
  for (const k of node.kids) n += countFiles(k);
  return n;
}

function fileNode(parent, file) {
  return {
    name: file.n,
    path: parent.path + '\u0001f' + file.n,
    depth: parent.depth + 1,
    size: file.s,
    total: file.s,
    files: 0,
    dirs: 0,
    kids: [],
    file: true,
  };
}

function moreNode(parent, shown, rest, kind, extra) {
  const count = rest.length + (extra || 0);
  const word = kind === 'files'
    ? plural(count, 'файл', 'файла', 'файлов')
    : plural(count, 'папка', 'папки', 'папок');
  return {
    name: (rest.length ? 'ещё ' : 'скрыто ') + count + ' ' + word,
    path: parent.path + '\u0001' + (kind === 'files' ? 'f' : 'd') + '*',
    depth: parent.depth + 1,
    size: 0,
    total: rest.reduce((a, b) => a + (kind === 'files' ? b.size : b.total), 0),
    files: 0,
    dirs: 0,
    kids: [],
    pseudo: true,
    pseudoFiles: kind === 'files',
  };
}

function visibleChildren(node, st) {
  let kids = node.kids || [];
  if (st.hidden && st.hidden.size) kids = kids.filter((k) => !st.hidden.has(k.name.toLowerCase()));
  const out = [];
  const limit = Math.max(5, st.maxChildren || 45);
  if (kids.length) {
    if (node.showAll || kids.length <= limit) out.push.apply(out, kids);
    else {
      out.push.apply(out, kids.slice(0, limit));
      out.push(moreNode(node, kids.slice(0, limit), kids.slice(limit), 'dirs'));
    }
  }
  if (st.showFiles && node.fileList && node.fileList.length) {
    const files = node.fileList.map((f) => fileNode(node, f));
    const flim = Math.max(3, st.maxFiles || 10);
    if (node.showAllFiles || files.length <= flim) out.push.apply(out, files);
    else {
      out.push.apply(out, files.slice(0, flim));
      out.push(moreNode(node, files.slice(0, flim), files.slice(flim), 'files', node.moreFiles || 0));
    }
  }
  if (!out.length) out.push(emptyNode(node));
  return out;
}
function emptyNode(parent) {
  return {
    name: 'пусто',
    path: parent.path + '\u0001e',
    depth: parent.depth + 1,
    size: 0,
    total: 0,
    files: 0,
    dirs: 0,
    kids: [],
    pseudo: true,
    emptyMark: true,
  };
}

function computeLayout(root, st) {
  const nodes = [];
  let cursor = 0;
  const walk = (node, depth, parent) => {
    node._x = 16 + depth * COL_W;
    node._p = parent;
    const kids = st.expanded.has(node.path) ? visibleChildren(node, st) : [];
    if (!kids.length) {
      node._y = cursor * ROW_H;
      cursor += 1;
    } else {
      const start = cursor;
      for (const k of kids) walk(k, depth + 1, node);
      node._y = Math.round(((start + cursor - 1) / 2) * ROW_H);
    }
    nodes.push(node);
  };
  walk(root, 0, null);
  return { nodes: nodes, height: Math.max(cursor, 1) * ROW_H };
}

function branchColor(root, node) {
  let cur = node;
  while (cur && cur._p && cur._p !== root) cur = cur._p;
  const i = root.kids.indexOf(cur);
  return PALETTE[(i < 0 ? 0 : i) % PALETTE.length];
}

function clip(text, max) {
  const s = String(text);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/* обрезает имя файла так, чтобы расширение осталось видимым */
function clipFile(name, max) {
  const s = String(name);
  if (s.length <= max) return s;
  const dot = s.lastIndexOf('.');
  const ext = dot > 0 && s.length - dot <= 12 ? s.slice(dot) : '';
  const base = ext ? s.slice(0, s.length - ext.length) : s;
  const keep = Math.max(5, max - ext.length - 1);
  return base.slice(0, keep) + '…' + ext;
}

function normalizePath(raw) {
  let value = String(raw == null ? '' : raw).trim().replace(/^"|"$/g, '');
  if (!value) return '';
  try {
    return fs.realpathSync(value);
  } catch (e) {
    try {
      return nodePath.resolve(value);
    } catch (e2) {
      return value;
    }
  }
}

function cssEscape(value) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(String(value));
  return String(value).replace(/["\\]/g, '\\$&');
}

function normPath(p) {
  return String(p || '').replace(/\//g, nodePath.sep).replace(/[\\/]+$/, '').toLowerCase();
}

function freeName(dir, name, isFile) {
  const ext = isFile ? nodePath.extname(name) : '';
  const base = ext ? name.slice(0, name.length - ext.length) : name;
  for (let i = 2; i <= 999; i++) {
    const candidate = base + ' (' + i + ')' + ext;
    if (!fs.existsSync(nodePath.join(dir, candidate))) return candidate;
  }
  return null;
}

function hashPath(p) {
  let h = 5381;
  for (let i = 0; i < p.length; i++) h = ((h << 5) + h + p.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/* ------------------------------------------------------------------ modal */

class PathModal extends Modal {
  constructor(app, plugin, onSubmit) {
    super(app);
    this.plugin = plugin;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    this.titleEl.setText('Карта папки');
    this.contentEl.createEl('p', {
      cls: 'fm-hint',
      text: 'Полный путь к папке на диске. Читается только структура и размеры, файлы не изменяются.',
    });
    this.inputEl = this.contentEl.createEl('input', {
      type: 'text',
      cls: 'fm-input',
      attr: { placeholder: 'E:\\Мой диск', spellcheck: 'false' },
    });
    this.inputEl.value = this.plugin.settings.roots[0] || '';

    if (this.plugin.settings.roots.length) {
      const list = this.contentEl.createDiv({ cls: 'fm-saved' });
      for (const root of this.plugin.settings.roots) {
        const b = list.createEl('button', { cls: 'fm-saved-item', text: root });
        b.addEventListener('click', () => {
          this.inputEl.value = root;
          this.submit();
        });
      }
    }

    const row = this.contentEl.createDiv({ cls: 'fm-modal-row' });
    const ok = row.createEl('button', { cls: 'mod-cta', text: 'Открыть карту' });
    ok.addEventListener('click', () => this.submit());
    const cancel = row.createEl('button', { text: 'Отмена' });
    cancel.addEventListener('click', () => this.close());

    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.submit();
      }
    });
    window.setTimeout(() => this.inputEl.focus(), 0);
  }

  submit() {
    const value = this.inputEl.value.trim().replace(/^"|"$/g, '');
    if (!value) return;
    if (!fs.existsSync(value)) {
      new Notice('Папка не найдена: ' + value);
      return;
    }
    this.close();
    this.onSubmit(value);
  }

  onClose() {
    this.contentEl.empty();
  }
}


/* ------------------------------------------------------- rename / move */

class RenameModal extends Modal {
  constructor(app, title, value, onSubmit) {
    super(app);
    this.heading = title;
    this.value = value;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    this.titleEl.setText(this.heading);
    this.inputEl = this.contentEl.createEl('input', { type: 'text', cls: 'fm-input' });
    this.inputEl.value = this.value;
    this.inputEl.spellcheck = false;
    this.contentEl.createEl('p', {
      cls: 'fm-hint',
      text: 'Только имя, без путей. Расширение можно изменить.',
    });
    const row = this.contentEl.createDiv({ cls: 'fm-modal-row' });
    const ok = row.createEl('button', { cls: 'mod-cta', text: 'Сохранить' });
    ok.addEventListener('click', () => this.submit());
    const cancel = row.createEl('button', { text: 'Отмена' });
    cancel.addEventListener('click', () => this.close());
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.submit();
      }
    });
    window.setTimeout(() => {
      this.inputEl.focus();
      const dot = this.inputEl.value.lastIndexOf('.');
      this.inputEl.setSelectionRange(0, dot > 0 ? dot : this.inputEl.value.length);
    }, 0);
  }

  submit() {
    const value = this.inputEl.value.trim();
    if (!value) {
      new Notice('Имя не может быть пустым');
      return;
    }
    if (/[\\/:*?"<>|]/.test(value)) {
      new Notice('В имени недопустимы \\ / : * ? " < > |');
      return;
    }
    this.close();
    this.onSubmit(value);
  }

  onClose() {
    this.contentEl.empty();
  }
}

class MoveModal extends Modal {
  constructor(app, plugin, sourcePath, onSubmit) {
    super(app);
    this.plugin = plugin;
    this.sourcePath = sourcePath;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    this.titleEl.setText('Переместить');
    this.contentEl.createEl('p', { cls: 'fm-hint', text: 'Имя: ' + nodePath.basename(this.sourcePath) });
    this.contentEl.createEl('p', { cls: 'fm-hint', text: 'Полный путь папки-назначения:' });
    this.inputEl = this.contentEl.createEl('input', { type: 'text', cls: 'fm-input' });
    this.inputEl.value = nodePath.dirname(this.sourcePath);
    this.inputEl.spellcheck = false;

    const saved = (this.plugin.settings.roots || []).filter((r) => fs.existsSync(r));
    if (saved.length) {
      const list = this.contentEl.createDiv({ cls: 'fm-saved' });
      for (const root of saved) {
        const b = list.createEl('button', { cls: 'fm-saved-item', text: root });
        b.addEventListener('click', () => {
          this.inputEl.value = root;
        });
      }
    }

    const row = this.contentEl.createDiv({ cls: 'fm-modal-row' });
    const ok = row.createEl('button', { cls: 'mod-cta', text: 'Переместить' });
    ok.addEventListener('click', () => this.submit());
    const cancel = row.createEl('button', { text: 'Отмена' });
    cancel.addEventListener('click', () => this.close());
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.submit();
      }
    });
    window.setTimeout(() => this.inputEl.focus(), 0);
  }

  submit() {
    const value = this.inputEl.value.trim().replace(/^"|"$/g, '');
    if (!value) return;
    let stat = null;
    try {
      stat = fs.statSync(value);
    } catch (e) {
      new Notice('Папка не найдена: ' + value);
      return;
    }
    if (!stat.isDirectory()) {
      new Notice('Это не папка: ' + value);
      return;
    }
    this.close();
    this.onSubmit(value);
  }

  onClose() {
    this.contentEl.empty();
  }
}

/* ------------------------------------------------------------------- view */

class FolderMindmapView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.rootPath = '';
    this.tree = null;
    this.stats = null;
    this.flat = [];
    this.expanded = new Set();
    this.hideService = true;
    this.k = 1;
    this.tx = 20;
    this.ty = 20;
    this.loadToken = 0;
    this.drag = null;
    this.bounds = { w: 400, h: 300 };
    this.settingsSnapshot = { maxChildren: 45, maxFiles: 10 };
    this.hiddenSet = new Set();
    this.showFiles = true;
    this.lastLayout = [];
    this.pendingDrag = null;
    this.dragging = false;
    this.dragSource = null;
    this.dropEl = null;
    this.ghostEl = null;
    this.suppressClick = false;
    this.undoStack = [];
    this.clickTimer = null;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return this.rootPath ? 'Карта: ' + nodePath.basename(this.rootPath) : 'Карта папки';
  }

  getIcon() {
    return 'git-fork';
  }

  getState() {
    return { path: this.rootPath };
  }

  async setState(state) {
    if (state && state.path) await this.setPath(state.path);
  }

  async onOpen() {
    this.buildShell();
    if (this.rootPath) await this.load(false);
  }

  async onClose() {
    this.loadToken += 1;
  }

  /* ------------------------------------------------------------- shell */

  buildShell() {
    const root = this.contentEl;
    root.empty();
    root.addClass('fm-root');

    const bar = root.createDiv({ cls: 'fm-bar' });
    this.pathBtn = bar.createEl('button', { cls: 'fm-path', text: 'выбрать папку…' });
    this.pathBtn.addEventListener('click', () => {
      new PathModal(this.app, this.plugin, (p) => this.setPath(p)).open();
    });

    this.searchEl = bar.createEl('input', {
      type: 'search',
      cls: 'fm-search',
      attr: { placeholder: 'поиск папки' },
    });
    this.resultsEl = bar.createDiv({ cls: 'fm-results' });
    this.searchEl.addEventListener('input', () => this.renderSearch());
    this.searchEl.addEventListener('blur', () => window.setTimeout(() => this.resultsEl.empty(), 200));

    const mk = (label, title, fn, cls) => {
      const b = bar.createEl('button', { cls: 'fm-btn' + (cls ? ' ' + cls : ''), text: label });
      b.setAttribute('title', title);
      b.addEventListener('click', fn);
      return b;
    };
    mk('2 ур.', 'Развернуть на два уровня', () => this.expandLevels(2));
    mk('3 ур.', 'Развернуть на три уровня', () => this.expandLevels(3));
    mk('все', 'Раскрыть все уровни (с ограничением по числу узлов)', () => this.expandLevels(Infinity));
    mk('свернуть', 'Свернуть всё', () => this.collapseAll());
    this.svcBtn = mk('служебные', 'Показывать node_modules, .git и подобные', () => this.toggleService(), 'fm-toggle on');
    this.filesBtn = mk('файлы', 'Показывать файлы, а не только папки', () => this.toggleFiles(), 'fm-toggle on');
    mk('обновить', 'Перечитать папку', () => this.load(true));
    this.undoBtn = mk('отменить', 'Отменить последнее перемещение или переименование', () => this.undoLast(), 'fm-disabled');
    mk('+', 'Приблизить', () => this.zoom(1.2));
    mk('−', 'Отдалить', () => this.zoom(1 / 1.2));
    mk('⛶', 'Вписать в окно', () => this.fit());

    const canvas = root.createDiv({ cls: 'fm-canvas' });
    const NS = 'http://www.w3.org/2000/svg';
    this.svg = document.createElementNS(NS, 'svg');
    this.svg.setAttribute('class', 'fm-svg');
    this.scene = document.createElementNS(NS, 'g');
    this.svg.appendChild(this.scene);
    canvas.appendChild(this.svg);

    this.statusEl = root.createDiv({ cls: 'fm-status', text: 'папка не выбрана' });

    this.registerDomEvent(this.svg, 'wheel', (e) => this.onWheel(e), { passive: false });
    this.registerDomEvent(this.svg, 'pointerdown', (e) => this.onDown(e));
    this.registerDomEvent(this.svg, 'pointermove', (e) => this.onMove(e));
    this.registerDomEvent(this.svg, 'pointerup', (e) => this.onUp(e));
    this.registerDomEvent(this.svg, 'pointercancel', (e) => this.onUp(e));
  }

  /* -------------------------------------------------------------- data */

  async setPath(path) {
    this.rootPath = normalizePath(path);
    this.pathBtn.setText(this.rootPath);
    this.pathBtn.setAttribute('title', this.rootPath);
    await this.load(false);
  }

  hiddenNames() {
    return new Set(
      String(this.plugin.settings.hiddenNames || '')
        .split(/[,\n;]/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    );
  }

  async load(force) {
    if (!this.rootPath) return;
    const token = ++this.loadToken;
    this.settingsSnapshot = {
      maxChildren: this.plugin.settings.maxChildren,
      maxFiles: this.plugin.settings.maxFiles,
    };
    this.hiddenSet = this.hiddenNames();
    this.showFiles = this.plugin.settings.showFiles !== false;
    if (this.filesBtn) this.filesBtn.toggleClass('on', this.showFiles);

    if (!force) {
      const cached = await this.plugin.readCache(this.rootPath);
      if (cached) {
        this.applyTree(cached.root, cached.stats);
        this.setStatus('из кэша · ' + this.describe());
        return;
      }
    }

    this.setStatus('сканирую ' + this.rootPath + '…');
    this.svg.addClass('fm-busy');
    try {
      const result = await this.plugin.scan(
        this.rootPath,
        (seen, current) => {
          if (token === this.loadToken) this.setStatus('сканирую… ' + seen + ' ' + plural(seen, 'каталог', 'каталога', 'каталогов'));
        },
        () => token !== this.loadToken
      );
      if (token !== this.loadToken) return;
      this.applyTree(result.root, result.stats);
      this.setStatus(this.describe() + ' · ' + (Math.round(result.stats.ms / 100) / 10).toFixed(1).replace('.', ',') + ' с');
      void this.plugin.writeCache(this.rootPath, result);
    } catch (e) {
      if (token !== this.loadToken) return;
      this.setStatus('ошибка: ' + e.message);
      new Notice('Карта папки: ' + e.message);
    } finally {
      if (token === this.loadToken) this.svg.removeClass('fm-busy');
    }
  }

  applyTree(root, stats) {
    this.tree = root;
    this.stats = stats;
    this.rebuildFlat();
    this.expanded = new Set([root.path]);
    for (const k of root.kids) {
      if (k.kids.length && k.kids.length <= 12) this.expanded.add(k.path);
    }
    this.render();
    this.fit();
    window.requestAnimationFrame(() => {
      if (this.tree) this.fit();
    });
  }


  st() {
    return {
      expanded: this.expanded,
      hidden: this.hideService ? this.hiddenSet : new Set(),
      maxChildren: this.settingsSnapshot.maxChildren,
      maxFiles: this.settingsSnapshot.maxFiles,
      showFiles: this.showFiles,
    };
  }

  rebuildFlat() {
    this.flat = [];
    const collect = (n) => {
      this.flat.push(n);
      for (const k of n.kids) collect(k);
      for (const f of n.fileList || []) this.flat.push(fileNode(n, f));
    };
    if (this.tree) collect(this.tree);
  }

  findFolder(path) {
    return this.flat.find((n) => !n.file && n.path === path) || null;
  }

  rewritePaths(node, oldPath, newPath) {
    node.path = newPath + node.path.slice(oldPath.length);
    for (const k of node.kids) this.rewritePaths(k, oldPath, newPath);
  }

  recountStats() {
    const walk = (n) => {
      let count = n.files;
      for (const k of n.kids) count += walk(k);
      return count;
    };
    if (!this.tree) return;
    this.stats = {
      ms: this.stats ? this.stats.ms : 0,
      dirs: this.tree.dirs,
      files: walk(this.tree),
      size: this.tree.total,
      deep: this.tree.deep,
    };
  }

  invalidateCache() {
    this.plugin.dropCache(this.rootPath);
  }

  renameNode(node) {
    const isFile = !!node.file;
    const full = isFile ? this.humanPath(node.path) : node.path;
    const name = nodePath.basename(full);
    new RenameModal(this.app, isFile ? 'Переименовать файл' : 'Переименовать папку', name, (value) => {
      this.applyRename(full, isFile, value);
    }).open();
  }

  applyRename(fullPath, isFile, newName, record) {
    const name = nodePath.basename(fullPath);
    const dir = nodePath.dirname(fullPath);
    if (newName === name) return;
    const target = nodePath.join(dir, newName);
    if (fs.existsSync(target)) {
      new Notice('Уже существует: ' + target);
      return;
    }
    try {
      fs.renameSync(fullPath, target);
    } catch (e) {
      new Notice('Не удалось переименовать: ' + e.message);
      return;
    }

    if (isFile) {
      const parent = this.findFolder(dir);
      if (parent) {
        const entry = (parent.fileList || []).find((f) => f.n === name);
        if (entry) entry.n = newName;
      }
    } else if (this.tree && fullPath === this.tree.path) {
      this.rewritePaths(this.tree, fullPath, target);
      this.tree.name = newName;
      this.rootPath = target;
      if (this.pathBtn) this.pathBtn.setText(target);
      this.plugin.settings.roots = [target].concat((this.plugin.settings.roots || []).filter((r) => r !== fullPath));
      void this.plugin.saveSettings();
      const remap = new Set();
      for (const p of this.expanded) {
        if (p === fullPath || p.indexOf(fullPath + nodePath.sep) === 0) remap.add(target + p.slice(fullPath.length));
        else remap.add(p);
      }
      this.expanded = remap;
    } else {
      const parent = this.findFolder(dir);
      const node = parent && parent.kids.find((k) => k.name === name);
      if (node) {
        node.name = newName;
        this.rewritePaths(node, fullPath, target);
      }
      const next = new Set();
      for (const p of this.expanded) {
        if (p === fullPath || p.indexOf(fullPath + nodePath.sep) === 0) next.add(target + p.slice(fullPath.length));
        else next.add(p);
      }
      this.expanded = next;
    }

    this.rebuildFlat();
    this.invalidateCache();
    this.render();
    this.setStatus('переименовано: ' + target);
    if (record !== false) {
      this.undoStack.push({ kind: 'rename', path: target, isFile: isFile, oldName: name });
      this.updateUndoBtn();
    }
  }

  moveNode(node) {
    const full = node.file ? this.humanPath(node.path) : node.path;
    new MoveModal(this.app, this.plugin, full, (dest) => this.applyMove(full, !!node.file, dest)).open();
  }

  resolveConflict(dest, name, isFile, alt) {
    const what = isFile ? 'Файл' : 'Папка';
    const detail =
      what + ' с таким именем уже лежит в этой папке. «Заменить» — старое удалится безвозвратно' +
      (alt ? ', «Переименовать» — новый станет «' + alt + '».' : '.');
    try {
      const electron = require('electron');
      const dialog = (electron && electron.remote && electron.remote.dialog) || (electron && electron.dialog);
      if (dialog && typeof dialog.showMessageBoxSync === 'function') {
        const idx = dialog.showMessageBoxSync({
          type: 'warning',
          buttons: ['Заменить', 'Переименовать', 'Отмена'],
          defaultId: 1,
          cancelId: 2,
          noLink: true,
          title: 'Файл уже существует',
          message: 'В папке «' + dest + '» уже есть «' + name + '»',
          detail: detail,
        });
        return idx === 0 ? 'replace' : idx === 1 ? 'rename' : 'cancel';
      }
    } catch (e) {
      /* electron недоступен — ниже простое окно */
    }
    const ok = window.confirm('В папке «' + dest + '» уже есть «' + name + '».\n\nЗаменить существующий объект? «Отмена» — перенос не выполняется.');
    return ok ? 'replace' : 'cancel';
  }

  applyMove(fullPath, isFile, rawDest, record) {
    const dest = String(rawDest).replace(/[\\/]+$/, '').replace(/\//g, nodePath.sep);
    const name = nodePath.basename(fullPath);
    let target = nodePath.join(dest, name);
    if (normPath(target) === normPath(fullPath)) return;
    if (!isFile && normPath(dest).indexOf(normPath(fullPath) + nodePath.sep) === 0) {
      new Notice('Нельзя переместить папку внутрь себя');
      return;
    }
    let finalName = name;
    if (fs.existsSync(target)) {
      const alt = freeName(dest, name, isFile);
      const choice = this.resolveConflict(dest, name, isFile, alt);
      if (choice === 'cancel') {
        this.setStatus('перенос отменён: «' + name + '» уже есть в папке');
        return;
      }
      if (choice === 'replace') {
        try {
          fs.rmSync(target, { recursive: true, force: true });
        } catch (e) {
          new Notice('Не удалось заменить: ' + e.message);
          return;
        }
      } else {
        if (!alt) {
          new Notice('Не удалось подобрать свободное имя');
          return;
        }
        finalName = alt;
        target = nodePath.join(dest, alt);
      }
    }
    let size = 0;
    try {
      if (isFile) size = fs.statSync(fullPath).size;
      fs.renameSync(fullPath, target);
    } catch (e) {
      if (e.code === 'EXDEV') {
        try {
          fs.cpSync(fullPath, target, { recursive: true });
          fs.rmSync(fullPath, { recursive: true, force: true });
        } catch (e2) {
          new Notice('Не удалось переместить: ' + e2.message);
          return;
        }
      } else {
        new Notice('Не удалось переместить: ' + e.message);
        return;
      }
    }

    const rootN = normPath(this.rootPath);
    const inside = !!this.rootPath && (normPath(dest) === rootN || normPath(dest).indexOf(rootN + nodePath.sep) === 0);
    const detached = this.detachFromTree(fullPath, isFile, name);
    if (inside && detached) this.attachToTree(detached, fullPath, target, dest);
    else if (inside && isFile) {
      const destNode = this.findFolder(dest);
      if (destNode) {
        destNode.fileList.push({ n: finalName, s: size });
        destNode.fileList.sort((a, b) => b.s - a.s);
        destNode.size += size;
        destNode.files += 1;
        aggregate(this.tree);
        this.recountStats();
      }
    }

    this.rebuildFlat();
    this.invalidateCache();
    this.render();
    this.setStatus('перемещено: ' + target);
    new Notice('Перемещено: ' + target);
    if (record !== false) {
      this.undoStack.push({ kind: 'move', path: target, isFile: isFile, backTo: nodePath.dirname(fullPath) });
      this.updateUndoBtn();
    }
  }

  detachFromTree(fullPath, isFile, name) {
    const parent = this.findFolder(nodePath.dirname(fullPath));
    if (!parent) return null;
    let removed = null;
    if (isFile) {
      const i = (parent.fileList || []).findIndex((f) => f.n === name);
      if (i >= 0) {
        const f = parent.fileList.splice(i, 1)[0];
        parent.size -= f.s;
        parent.files -= 1;
      }
    } else {
      const i = parent.kids.findIndex((k) => k.name === name);
      if (i >= 0) removed = parent.kids.splice(i, 1)[0];
    }
    aggregate(this.tree);
    this.recountStats();
    return removed;
  }

  attachToTree(node, oldPath, target, destDir) {
    const dest = this.findFolder(destDir);
    if (!dest) return;
    this.rewritePaths(node, oldPath, target);
    dest.kids.push(node);
    aggregate(this.tree);
    this.recountStats();
  }

  undoLast() {
    const op = this.undoStack.pop();
    this.updateUndoBtn();
    if (!op) {
      new Notice('Нечего отменять');
      return;
    }
    if (op.kind === 'move') this.applyMove(op.path, op.isFile, op.backTo, false);
    else this.applyRename(op.path, op.isFile, op.oldName, false);
  }

  updateUndoBtn() {
    if (this.undoBtn) this.undoBtn.toggleClass('fm-disabled', this.undoStack.length === 0);
  }

  openMenu(node, evt) {
    const full = node.file ? this.humanPath(node.path) : node.path;
    const menu = new Menu();
    menu.addItem((i) => i.setTitle('Переименовать').setIcon('pencil').onClick(() => this.renameNode(node)));
    menu.addItem((i) => i.setTitle('Переместить').setIcon('folder-input').onClick(() => this.moveNode(node)));
    menu.addSeparator();
    menu.addItem((i) => i.setTitle('Копировать путь').setIcon('clipboard').onClick(() => {
      navigator.clipboard.writeText(full).then(
        () => this.setStatus('путь скопирован: ' + full),
        () => this.setStatus(full)
      );
    }));
    menu.showAtMouseEvent(evt);
  }

  expandLevels(maxLevel) {
    if (!this.tree) return;
    const cap = 2500;
    this.expanded = new Set([this.tree.path]);
    let level = 1;
    while (level <= maxLevel) {
      const atLevel = this.flat.filter((n) => !n.file && n.depth === level - 1 && n.kids.length);
      if (!atLevel.length) break;
      const added = [];
      for (const n of atLevel) {
        if (!this.expanded.has(n.path)) {
          this.expanded.add(n.path);
          added.push(n.path);
        }
      }
      if (added.length) {
        const layout = computeLayout(this.tree, this.st());
        if (layout.nodes.length > cap) {
          for (const p of added) this.expanded.delete(p);
          new Notice('Узлов слишком много — раскрыто до уровня ' + (level - 1));
          break;
        }
      }
      level += 1;
    }
    this.render();
    this.fit();
    this.setStatus(this.describe());
  }

  describe() {
    if (!this.stats) return '';
    return (
      fmt(this.stats.size) +
      ' · ' + this.stats.dirs + ' ' + plural(this.stats.dirs, 'папка', 'папки', 'папок') +
      ' · ' + this.stats.files + ' ' + plural(this.stats.files, 'файл', 'файла', 'файлов')
    );
  }

  setStatus(text) {
    if (this.statusEl) this.statusEl.setText(text);
  }

  /* ------------------------------------------------------------ render */

  render() {
    if (!this.tree) return;
    const layout = computeLayout(this.tree, this.st());
    const NS = 'http://www.w3.org/2000/svg';
    while (this.scene.firstChild) this.scene.removeChild(this.scene.firstChild);
    const links = document.createDocumentFragment();
    const boxes = document.createDocumentFragment();
    let maxX = 0;
    let maxY = 0;

    for (const n of layout.nodes) {
      if (n._p) {
        const px = n._p._x + NODE_W;
        const py = n._p._y + NODE_H / 2;
        const cx = n._x;
        const cy = n._y + NODE_H / 2;
        const mx = (px + cx) / 2;
        const p = document.createElementNS(NS, 'path');
        p.setAttribute('d', 'M' + px + ',' + py + ' C' + mx + ',' + py + ' ' + mx + ',' + cy + ' ' + cx + ',' + cy);
        p.setAttribute('class', 'fm-link' + (n.pseudo ? ' fm-link-pseudo' : ''));
        links.appendChild(p);
      }
    }

    this.lastLayout = layout.nodes;
    for (const n of layout.nodes) {
      const color = n.file ? '#6e7681' : n._p ? branchColor(this.tree, n) : '#7d8590';
      const hasKids = n.kids && n.kids.length;
      const open = this.expanded.has(n.path);
      const grp = document.createElementNS(NS, 'g');
      grp.setAttribute('class', 'fm-node' + (hasKids ? '' : ' fm-leaf') + (open && hasKids ? ' fm-open' : '') + (n.file ? ' fm-file' : '') + (n.pseudo ? ' fm-pseudo' : '') + (!n.file && !hasKids && !n.files ? ' fm-empty' : ''));
      grp.setAttribute('transform', 'translate(' + n._x + ',' + n._y + ')');
      grp.setAttribute('data-path', n.path);

      const rect = document.createElementNS(NS, 'rect');
      rect.setAttribute('class', 'fm-box');
      rect.setAttribute('width', String(NODE_W));
      rect.setAttribute('height', String(NODE_H));
      rect.setAttribute('rx', '6');
      rect.setAttribute('stroke', color);
      grp.appendChild(rect);

      const stripe = document.createElementNS(NS, 'rect');
      stripe.setAttribute('width', '3');
      stripe.setAttribute('height', String(NODE_H));
      stripe.setAttribute('rx', '1.5');
      stripe.setAttribute('fill', color);
      grp.appendChild(stripe);

      const label = document.createElementNS(NS, 'text');
      label.setAttribute('class', 'fm-name');
      label.setAttribute('x', '10');
      label.setAttribute('y', String(NODE_H / 2 + 0.5));
      label.textContent = n.file ? clipFile(n.name, 27) : clip(n.name, 27);
      grp.appendChild(label);

      const size = document.createElementNS(NS, 'text');
      size.setAttribute('class', 'fm-size');
      size.setAttribute('x', String(NODE_W - 8));
      size.setAttribute('y', String(NODE_H / 2 + 0.5));
      size.setAttribute('text-anchor', 'end');
      size.textContent = !n.file && !hasKids
        ? n.files + ' ' + plural(n.files, 'файл', 'файла', 'файлов') + ' · ' + fmt(n.total)
        : fmt(n.total);
      grp.appendChild(size);

      if (hasKids && !open) {
        const badge = document.createElementNS(NS, 'text');
        badge.setAttribute('class', 'fm-badge');
        badge.setAttribute('x', String(NODE_W - 8));
        badge.setAttribute('y', String(NODE_H - 6));
        badge.setAttribute('text-anchor', 'end');
        badge.textContent = n.kids.length + ' пап.';
        grp.appendChild(badge);
      }

      grp.addEventListener('click', () => this.onNodeClick(n));
      grp.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        this.openMenu(n, e);
      });
      grp.addEventListener('pointerdown', (e) => this.onNodeDown(n, e));
      grp.addEventListener('dblclick', (e) => this.onNodeDblClick(n, e));
      boxes.appendChild(grp);

      maxX = Math.max(maxX, n._x + NODE_W);
      maxY = Math.max(maxY, n._y + NODE_H);
    }

    this.scene.appendChild(links);
    this.scene.appendChild(boxes);
    this.bounds = { w: maxX + 40, h: maxY + 40 };
    this.apply();
  }

  apply() {
    this.scene.setAttribute('transform', 'translate(' + this.tx + ',' + this.ty + ') scale(' + this.k + ')');
  }

  fit() {
    const canvas = this.svg.parentElement;
    if (!canvas) return;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h || w < 80 || h < 80) return;
    const k = Math.min(1.05, (w - 32) / this.bounds.w, (h - 24) / this.bounds.h);
    this.k = Math.max(0.45, k);
    this.tx = 16;
    this.ty = Math.max(12, Math.round((h - this.bounds.h * this.k) / 2));
    this.apply();
  }

  zoom(factor) {
    this.k = Math.min(3, Math.max(0.2, this.k * factor));
    this.apply();
  }

  onWheel(e) {
    e.preventDefault();
    const rect = this.svg.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const nk = Math.min(3, Math.max(0.2, this.k * factor));
    this.tx = mx - (mx - this.tx) * (nk / this.k);
    this.ty = my - (my - this.ty) * (nk / this.k);
    this.k = nk;
    this.apply();
  }

  onDown(e) {
    if (e.target.closest && e.target.closest('.fm-node')) return;
    this.drag = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty };
    this.svg.addClass('fm-drag');
  }

  onMove(e) {
    if (this.drag) {
      this.tx = this.drag.tx + (e.clientX - this.drag.x);
      this.ty = this.drag.ty + (e.clientY - this.drag.y);
      this.apply();
      return;
    }
    if (!this.pendingDrag) return;
    if (!this.dragging) {
      const dx = Math.abs(e.clientX - this.pendingDrag.x);
      const dy = Math.abs(e.clientY - this.pendingDrag.y);
      if (dx + dy < 8) return;
      this.startDrag(this.pendingDrag, e);
    }
    if (this.dragging) this.updateDrag(e);
  }

  onUp(e) {
    this.drag = null;
    this.svg.removeClass('fm-drag');
    if (this.dragging) {
      this.finishDrag(e);
      return;
    }
    this.pendingDrag = null;
  }

  onNodeDown(node, e) {
    if (e.button !== 0 || node.pseudo) return;
    this.pendingDrag = { node: node, x: e.clientX, y: e.clientY, id: e.pointerId };
  }

  startDrag(pending, e) {
    if (this.clickTimer) {
      clearTimeout(this.clickTimer);
      this.clickTimer = null;
    }
    this.dragging = true;
    this.dragSource = pending.node;
    this.suppressClick = true;
    try {
      this.svg.setPointerCapture(pending.id);
    } catch (err) {
      /* синтетическое событие без активного указателя */
    }
    this.svg.addClass('fm-dragging');
    const full = pending.node.file ? this.humanPath(pending.node.path) : pending.node.path;
    const ghost = document.createElement('div');
    ghost.className = 'fm-ghost';
    ghost.textContent = nodePath.basename(full);
    this.svg.parentElement.appendChild(ghost);
    this.ghostEl = ghost;
    const src = this.svg.querySelector('.fm-node[data-path="' + cssEscape(pending.node.path) + '"]');
    if (src) src.classList.add('fm-source');
    this.updateDrag(e);
  }

  updateDrag(e) {
    const canvas = this.svg.parentElement.getBoundingClientRect();
    if (this.ghostEl) {
      this.ghostEl.style.left = e.clientX - canvas.left + 'px';
      this.ghostEl.style.top = e.clientY - canvas.top + 'px';
    }
    let hit = null;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const grp = el && el.closest ? el.closest('.fm-node') : null;
    if (grp && grp !== this.ghostEl) {
      const path = grp.getAttribute('data-path');
      const candidate = (this.lastLayout || []).find((n) => n.path === path);
      if (candidate && !candidate.pseudo && this.canDropOn(candidate)) hit = grp;
    }
    if (this.dropEl && this.dropEl !== hit) this.dropEl.classList.remove('fm-drop');
    if (hit) hit.classList.add('fm-drop');
    this.dropEl = hit;
  }

  canDropOn(target) {
    if (!this.dragSource || target.file) return false;
    const src = this.dragSource;
    if (target.path === src.path) return false;
    if (!src.file) {
      const srcFull = normPath(src.path);
      if (normPath(target.path).indexOf(srcFull + nodePath.sep) === 0) return false;
    }
    return true;
  }

  finishDrag(e) {
    const target = this.dropEl
      ? (this.lastLayout || []).find((n) => n.path === this.dropEl.getAttribute('data-path'))
      : null;
    const src = this.dragSource;
    if (this.ghostEl) this.ghostEl.remove();
    this.ghostEl = null;
    if (this.dropEl) this.dropEl.classList.remove('fm-drop');
    this.dropEl = null;
    this.svg.removeClass('fm-dragging');
    this.dragging = false;
    this.pendingDrag = null;
    this.dragSource = null;
    try {
      this.svg.releasePointerCapture(e.pointerId);
    } catch (err) {
      /* указатель уже отпущен */
    }
    if (!src) return;
    const full = src.file ? this.humanPath(src.path) : src.path;
    if (!target) {
      this.setStatus('перетаскивание отменено: ' + nodePath.basename(full));
      return;
    }
    const dest = target.file ? nodePath.dirname(this.humanPath(target.path)) : target.path;
    if (normPath(dest) === normPath(nodePath.dirname(full))) {
      this.setStatus('уже в этой папке: ' + nodePath.basename(full));
      return;
    }
    this.applyMove(full, !!src.file, dest);
  }

  onNodeClick(node) {
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    if (this.clickTimer) clearTimeout(this.clickTimer);
    this.clickTimer = setTimeout(() => {
      this.clickTimer = null;
      this.activateNode(node);
    }, 220);
  }

  onNodeDblClick(node) {
    if (this.clickTimer) {
      clearTimeout(this.clickTimer);
      this.clickTimer = null;
    }
    if (node.pseudo || this.dragging) return;
    this.renameNode(node);
  }

  activateNode(node) {
    if (node.pseudo) {
      if (node.emptyMark) return;
      if (node._p) {
        if (node.pseudoFiles) node._p.showAllFiles = true;
        else node._p.showAll = true;
        this.render();
        this.focus(node._p.path);
      }
      return;
    }
    if (node.file) {
      this.setStatus(this.humanPath(node.path) + ' · ' + fmt(node.total));
      return;
    }
    if (this.expanded.has(node.path)) this.expanded.delete(node.path);
    else this.expanded.add(node.path);
    this.render();
    if (this.expanded.size <= 2) this.fit();
    else this.focus(node.path);
    this.setStatus(this.describe());
  }

  focus(path) {
    const n = (this.lastLayout || []).find((x) => x.path === path);
    if (!n) return;
    const canvas = this.svg.parentElement;
    const w = canvas ? canvas.clientWidth : 800;
    this.tx = Math.min(16, 16 - Math.max(0, (n._x || 0) * this.k - (w - NODE_W * this.k - 40)));
    this.ty = Math.min(16, 60 - (n._y || 0) * this.k);
    this.apply();
  }

  collapseAll() {
    this.expanded = new Set([this.tree ? this.tree.path : '']);
    this.render();
    this.fit();
  }

  toggleFiles() {
    this.showFiles = !this.showFiles;
    if (this.filesBtn) this.filesBtn.toggleClass('on', this.showFiles);
    this.render();
    this.fit();
  }

  toggleService() {
    this.hideService = !this.hideService;
    this.svcBtn.toggleClass('on', this.hideService);
    this.render();
    this.fit();
  }

  renderSearch() {
    const q = this.searchEl.value.trim().toLowerCase();
    this.resultsEl.empty();
    if (q.length < 2 || !this.tree) return;
    const hits = this.flat.filter((n) => n.path !== this.tree.path && n.name.toLowerCase().indexOf(q) >= 0).slice(0, 30);
    if (!hits.length) {
      this.resultsEl.createDiv({ cls: 'fm-result fm-empty', text: 'ничего не найдено' });
      return;
    }
    for (const hit of hits) {
      const row = this.resultsEl.createDiv({ cls: 'fm-result' });
      row.createSpan({ cls: 'fm-result-name', text: hit.name });
      row.createSpan({ cls: 'fm-result-path', text: fmt(hit.total) + ' · ' + hit.path });
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.reveal(hit);
      });
    }
  }

  humanDir(path) {
    const i = path.indexOf('\u0001');
    return i < 0 ? path : path.slice(0, i);
  }

  humanPath(path) {
    const i = path.indexOf('\u0001');
    if (i < 0) return path;
    return path.slice(0, i) + nodePath.sep + path.slice(i + 2);
  }

  reveal(node) {
    this.resultsEl.empty();
    this.searchEl.value = '';
    const rootPath = this.rootPath;
    const base = node.file ? this.humanDir(node.path) : node.path;
    let cur = rootPath;
    this.expanded.add(rootPath);
    const rel = base.slice(rootPath.length).split(nodePath.sep).filter(Boolean);
    for (const part of rel) {
      cur = cur + nodePath.sep + part;
      this.expanded.add(cur);
    }
    if (node.file) {
      const dir = this.flat.find((x) => x.path === base);
      if (dir) dir.showAllFiles = true;
    }
    this.render();
    this.focus(node.path);
    this.setStatus(
      this.humanPath(node.path) + ' · ' + fmt(node.total) +
      (node.file ? '' : ' · ' + node.files + ' ' + plural(node.files, 'файл', 'файла', 'файлов'))
    );
  }
}

/* --------------------------------------------------------------- settings */

class FolderMindmapSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Папки по умолчанию')
      .setDesc('По одной на строку. Первая подставляется в диалоге открытия.')
      .addTextArea((t) =>
        t
          .setValue(this.plugin.settings.roots.join('\n'))
          .onChange(async (v) => {
            this.plugin.settings.roots = v.split('\n').map((s) => s.trim()).filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Служебные папки')
      .setDesc('Через запятую: скрываются по кнопке «служебные» — node_modules, .git и т. п.')
      .addTextArea((t) =>
        t
          .setValue(this.plugin.settings.hiddenNames)
          .onChange(async (v) => {
            this.plugin.settings.hiddenNames = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Папок на узел')
      .setDesc('Сколько дочерних папок показывать сразу; остальные — под «ещё N».')
      .addSlider((s) =>
        s
          .setLimits(10, 200, 5)
          .setValue(this.plugin.settings.maxChildren)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.maxChildren = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Показывать файлы')
      .setDesc('Выводить файлы рядом с папками. Кнопка «файлы» в карте переключает это же.')
      .addToggle((t) =>
        t
          .setValue(this.plugin.settings.showFiles !== false)
          .onChange(async (v) => {
            this.plugin.settings.showFiles = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Файлов на узел')
      .setDesc('Сколько файлов показывать в одной папке; остальные — под «ещё N файлов».')
      .addSlider((s) =>
        s
          .setLimits(5, 200, 5)
          .setValue(this.plugin.settings.maxFiles)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.maxFiles = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Глубина чтения')
      .setDesc('Ограничение на вложенность при сканировании.')
      .addSlider((s) =>
        s
          .setLimits(3, 30, 1)
          .setValue(this.plugin.settings.maxDepth)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.maxDepth = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Кэш, минут')
      .setDesc('Сколько держать результат сканирования. 0 — не кэшировать.')
      .addSlider((s) =>
        s
          .setLimits(0, 240, 5)
          .setValue(this.plugin.settings.cacheMinutes)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.cacheMinutes = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Очистить кэш')
      .setDesc('Удалить сохранённые результаты сканирования.')
      .addButton((b) =>
        b.setButtonText('Очистить').onClick(async () => {
          const dir = this.plugin.cacheDir();
          try {
            for (const f of fs.readdirSync(dir)) {
              if (f.endsWith('.json')) fs.unlinkSync(nodePath.join(dir, f));
            }
            new Notice('Кэш очищен');
          } catch (e) {
            new Notice('Кэш уже пуст');
          }
        })
      );
  }
}

/* ----------------------------------------------------------------- plugin */

class FolderMindmapPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE, (leaf) => new FolderMindmapView(leaf, this));

    this.addRibbonIcon('git-fork', 'Карта папки', () => this.promptOpen());
    this.addCommand({
      id: 'open-folder-map',
      name: 'Открыть карту папки…',
      callback: () => this.promptOpen(),
    });
    this.addCommand({
      id: 'open-last-folder-map',
      name: 'Открыть карту последней папки',
      callback: () => this.openMap(this.settings.roots[0]),
    });

    this.addSettingTab(new FolderMindmapSettingTab(this.app, this));
  }

  onunload() {}

  promptOpen() {
    new PathModal(this.app, this, (p) => this.openMap(p)).open();
  }

  async openMap(rawPath) {
    const path = normalizePath(rawPath);
    if (!path) {
      new Notice('Сначала укажите папку');
      return;
    }
    if (!fs.existsSync(path)) {
      new Notice('Папка не найдена: ' + path);
      return;
    }
    if (this.settings.roots.indexOf(path) < 0) {
      this.settings.roots.unshift(path);
      this.settings.roots = this.settings.roots.slice(0, 8);
      await this.saveSettings();
    }
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.setViewState({ type: VIEW_TYPE, active: true, state: { path: path } });
  }

  hiddenSet() {
    return new Set(
      String(this.settings.hiddenNames || '')
        .split(/[,\n;]/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    );
  }

  async scan(path, onProgress, isCancelled) {
    return scanFolder(path, {
      hiddenNames: String(this.settings.hiddenNames || '').split(/[,\n;]/).map((s) => s.trim()).filter(Boolean),
      maxDepth: this.settings.maxDepth,
    }, { onProgress: onProgress, isCancelled: isCancelled });
  }

  dropCache(path) {
    try {
      fs.unlinkSync(nodePath.join(this.cacheDir(), hashPath(path) + '.json'));
    } catch (e) {
      /* файла кэша нет */
    }
  }

  cacheDir() {
    const base = this.manifest.dir || nodePath.join(this.app.vault.adapter.basePath, '.obsidian', 'plugins', 'folder-mindmap');
    return nodePath.join(base, 'cache');
  }

  async readCache(path) {
    if (!this.settings.cacheMinutes) return null;
    const file = nodePath.join(this.cacheDir(), hashPath(path) + '.json');
    try {
      const st = fs.statSync(file);
      if (Date.now() - st.mtimeMs > this.settings.cacheMinutes * 60000) return null;
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!data || data.v !== CACHE_VERSION || data.path !== path || !data.root) return null;
      return { root: data.root, stats: data.stats };
    } catch (e) {
      return null;
    }
  }

  async writeCache(path, result) {
    if (!this.settings.cacheMinutes) return;
    try {
      fs.mkdirSync(this.cacheDir(), { recursive: true });
      const payload = JSON.stringify({
        v: CACHE_VERSION,
        path: path,
        ts: Date.now(),
        root: result.root,
        stats: result.stats,
      }, (k, v) => (k.charAt(0) === '_' ? undefined : v));
      fs.writeFileSync(nodePath.join(this.cacheDir(), hashPath(path) + '.json'), payload, 'utf8');
    } catch (e) {
      console.warn('Folder Mindmap: не удалось сохранить кэш', e);
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!Array.isArray(this.settings.roots)) this.settings.roots = DEFAULT_SETTINGS.roots.slice();
    this.settings.maxChildren = Number(this.settings.maxChildren) || DEFAULT_SETTINGS.maxChildren;
    this.settings.maxFiles = Number(this.settings.maxFiles) || DEFAULT_SETTINGS.maxFiles;
    this.settings.showFiles = this.settings.showFiles !== false;
    this.settings.maxDepth = Number(this.settings.maxDepth) || DEFAULT_SETTINGS.maxDepth;
    this.settings.cacheMinutes = Number(this.settings.cacheMinutes);
    if (!Number.isFinite(this.settings.cacheMinutes)) this.settings.cacheMinutes = DEFAULT_SETTINGS.cacheMinutes;
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

module.exports = FolderMindmapPlugin;
module.exports.__lib = { scanFolder: scanFolder, computeLayout: computeLayout, visibleChildren: visibleChildren, fmt: fmt, aggregate: aggregate, clipFile: clipFile };
