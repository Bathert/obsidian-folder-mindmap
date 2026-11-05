// Node-проверка чистой логики плагина без Obsidian: скан, агрегация, раскладка.
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

class FakePlugin { }
class FakeItemView { constructor(leaf) { this.leaf = leaf; this.contentEl = null; } }
class FakeModal { constructor(app) { this.app = app; } }
class FakeNotice { constructor(msg) { this.msg = msg; } }
class FakeSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; } }
class FakeSetting { constructor() {} setName() { return this; } setDesc() { return this; } addTextArea() { return this; } addSlider() { return this; } addButton() { return this; } }

const fake = {
  Plugin: FakePlugin,
  ItemView: FakeItemView,
  Modal: FakeModal,
  Notice: FakeNotice,
  PluginSettingTab: FakeSettingTab,
  Setting: FakeSetting,
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'obsidian') return fake;
  return origLoad.call(this, request, parent, isMain);
};

const pluginPath = path.resolve(process.cwd(), process.argv[2] || 'main.js');
const mod = require(pluginPath);
const lib = mod.__lib;
if (!lib) throw new Error('нет __lib');

// --- тестовое дерево
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-'));
const w = (p, n) => fs.writeFileSync(path.join(tmp, p), Buffer.alloc(n, 1));
fs.mkdirSync(path.join(tmp, 'A', 'A1'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'node_modules', 'pkg'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'empty'), { recursive: true });
w('root.txt', 1000);
w(path.join('A', 'a.bin'), 2000);
w(path.join('A', 'A1', 'deep.bin'), 500);
w(path.join('node_modules', 'pkg', 'index.js'), 4096);

(async () => {
  const res = await lib.scanFolder(tmp, { hiddenNames: ['node_modules'], maxDepth: 10 });
  const root = res.root;
  const byName = {};
  for (const k of root.kids) byName[k.name] = k;

  const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok  ', msg); };

  assert(root.total === 3500, 'сумма размеров без скрытых = 3500 (' + root.total + ')');
  assert(root.files === 1, 'файлов в корне = 1');
  assert(byName.A && byName.A.total === 2500, 'A = 2500');
  assert(byName.A.dirs === 1, 'в A один подкаталог');
  assert(!byName.node_modules, 'node_modules скрыт');
  assert(byName.empty && byName.empty.kids.length === 0, 'пустая папка на месте');
  assert(res.stats.dirs === 3, 'каталогов (без скрытых) = 3 (' + res.stats.dirs + ')');
  assert(res.stats.files === 3, 'файлов всего без скрытых = 3 (' + res.stats.files + ')');
  assert(lib.fmt(1536) === '1,50 КБ', 'fmt(1536) = ' + lib.fmt(1536));

  // обрезка имени файла сохраняет расширение
  const long = 'asdasd-qwerty-very-long-file-name-for-test.txt';
  const cut = lib.clipFile(long, 20);
  assert(cut.length <= 20 && cut.endsWith('.txt') && cut.indexOf('…') > 0, 'длинное имя обрезано с .txt: ' + cut);
  assert(lib.clipFile('short.md', 20) === 'short.md', 'короткое имя не меняется');
  assert(lib.clipFile('noext-long-long-long-name', 12).indexOf('…') > 0, 'имя без расширения тоже обрезается');

  // раскладка: свёрнутый корень — одна строка
  let lay = lib.computeLayout(root, { expanded: new Set([root.path]), hidden: new Set(), maxChildren: 45 });
  assert(lay.nodes.length === 3, 'свёрнутый корень + 2 ребёнка = 3 узла (' + lay.nodes.length + ')');
  assert(lay.height === 2 * 28, 'высота = 2 строки');

  // раскрытый A
  lay = lib.computeLayout(root, { expanded: new Set([root.path, byName.A.path]), hidden: new Set(), maxChildren: 45 });
  assert(lay.nodes.length === 4, 'после раскрытия A — 4 узла (' + lay.nodes.length + ')');
  assert(lay.nodes.every((n) => typeof n._x === 'number' && typeof n._y === 'number'), 'координаты заданы');

  // лимит детей и псевдоузел
  const many = { name: 'm', path: '/m', depth: 0, size: 0, total: 10, files: 0, dirs: 0, kids: [] };
  for (let i = 0; i < 10; i++) many.kids.push({ name: 'k' + i, path: '/m/k' + i, depth: 1, size: 0, total: 10 - i, files: 0, dirs: 0, kids: [] });
  const vis = lib.visibleChildren(many, { hidden: new Set(), maxChildren: 5 });
  assert(vis.length === 6 && vis[5].pseudo && vis[5].name === 'ещё 5 папок', 'лимит детей (5) даёт псевдоузел «ещё 5»');

  // файлы
  assert(root.fileList.length === 1 && root.fileList[0].n === 'root.txt', 'в корне собран файл root.txt');
  const withFiles = lib.visibleChildren(root, { hidden: new Set(), maxChildren: 45, showFiles: true, maxFiles: 30 });
  const fileRows = withFiles.filter((n) => n.file);
  assert(fileRows.length === 1 && fileRows[0].total === 1000, 'файл попадает в карту с размером');
  assert(typeof fileRows[0].path === 'string' && fileRows[0].path.indexOf('\u0001') > 0, 'у файла отдельный путь-маркер');
  const noFiles = lib.visibleChildren(root, { hidden: new Set(), maxChildren: 45, showFiles: false, maxFiles: 30 });
  assert(noFiles.filter((n) => n.file).length === 0, 'без файлов остаются только папки');

  // пустая папка при раскрытии даёт пометку «пусто»
  const empties = lib.visibleChildren(byName.empty, { hidden: new Set(), maxChildren: 45, showFiles: true, maxFiles: 30 });
  assert(empties.length === 1 && empties[0].emptyMark && empties[0].name === 'пусто', 'пустая папка раскрывается с пометкой «пусто»');

  // папка только с файлами (без подпапок) тоже раскрывается
  const onlyFiles = { name: 'of', path: '/of', depth: 1, size: 5, total: 5, files: 2, dirs: 0, kids: [], fileList: [{ n: 'a.txt', s: 2 }, { n: 'b.txt', s: 3 }], moreFiles: 0 };
  const ofVis = lib.visibleChildren(onlyFiles, { hidden: new Set(), maxChildren: 45, showFiles: true, maxFiles: 30 });
  assert(ofVis.length === 2 && ofVis.every((n) => n.file), 'папка только с файлами показывает файлы');

  // кэш-сериализация не должна падать на _p
  lay = lib.computeLayout(root, { expanded: new Set([root.path, byName.A.path]), hidden: new Set(), maxChildren: 45 });
  const json = JSON.stringify(root, (k, v) => (k.charAt(0) === '_' ? undefined : v));
  assert(json.length > 50 && json.indexOf('"_p"') < 0, 'сериализация без служебных ссылок');

  // индекс: повторный проход по неизменённой папке берёт записи из индекса
  assert(res.index && res.index.dirs && Object.keys(res.index.dirs).length >= 3, 'индекс содержит записи каталогов');
  const second = await lib.scanFolder(tmp, { hiddenNames: ['node_modules'], maxDepth: 10, index: res.index });
  assert(second.stats.dirs === res.stats.dirs && second.root.total === res.root.total, 'размеры из индекса совпадают');
  assert(second.stats.refreshed === 0 && second.stats.reused >= second.stats.dirs, 'повторный проход не перечитывает файлы (' + second.stats.reused + ' переиспользовано, ' + second.stats.refreshed + ' перечитано)');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(process.exitCode ? 'ЕСТЬ ОШИБКИ' : 'все проверки прошли');
})();
