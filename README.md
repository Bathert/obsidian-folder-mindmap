# Folder Mindmap

An Obsidian plugin that turns any folder into an interactive mind map: collapsible nodes, sizes, file counts, search and basic file operations right on the map. It works with folders inside the vault and with any directory on disk (for example `E:\My Drive`).

Русская версия: [README.ru.md](README.ru.md)

## Why this exists

I love Obsidian. So I see no reason why it can't also help me keep the folder structure on my computer in order — not just the notes inside the vault.

## Features

- **Command "Open folder map…"** — dialog with a full path; available from the command palette or the ribbon button.
- **Command "Open last folder map"** — opens the first folder from the settings right away.
- Shows folders and files: files are dashed nodes with their size, the rest collapses into "N more files".
- Reads the structure only: names, sizes, file counts. Nothing is changed without an explicit command.
- Folder index: on the next open only changed directories are re-read, the rest come from the index — opening takes a fraction of a second.
- Search by file names: the search box finds both folders and files across the indexed tree.
- Restores the map view after a restart: expanded nodes, pan and zoom.
- Reads the disk in parallel (8 workers) without blocking the UI: a folder with 5,200 directories and 68,500 files on C: is read in ~1.8 s versus ~26 s with a sequential walk.
- Service folders (`node_modules`, `.git`, `__pycache__` and similar) are hidden with one toggle.
- Rename and move folders and files from the node context menu.

## Installation

### From the community plugins (after review)

Settings → Community plugins → Browse → search for "Folder Mindmap" → Install → Enable.

### Manually

1. Put the plugin folder into `<vault>/.obsidian/plugins/folder-mindmap`:

   ```bash
   git clone https://github.com/Bathert/obsidian-folder-mindmap.git "<vault>/.obsidian/plugins/folder-mindmap"
   ```

2. In Obsidian: **Settings → Community plugins → Reload plugins**, then enable "Folder Mindmap" if it is off.

Alternatively copy `manifest.json`, `main.js` and `styles.css` into a `folder-mindmap` folder inside `.obsidian/plugins`.

Requirements: Obsidian 1.4.0+ on desktop. The plugin does not work on mobile: it reads the file system through Node.js.

## Using the map

| Action | What it does |
|---|---|
| click a folder | expand / collapse the branch; an empty folder expands with a "пусто" (empty) marker |
| "ещё N" | show the remaining folders of a node (when there are more than the limit) |
| mouse wheel | zoom |
| drag the background | pan the map |
| search | finds a folder or file by name, expands the path and highlights the folder |
| "2 ур." / "3 ур." / "все" | expand the map to 2, 3 or all levels (with a guard against too many nodes) |
| right click a node | "Rename", "Move", "Copy path" |
| double click a node | rename the folder or file |
| drag a node | drop a file or folder onto another folder to move it |
| "отменить" | undo the last move or rename |
| "свернуть" | collapse everything down to the root |
| "служебные" | show / hide `node_modules`, `.git`, `__pycache__` and similar |
| "файлы" | show / hide files (on by default) |
| "обновить" | re-read the folder (unchanged directories still come from the index) |
| ⛶ | fit the map to the window |

The interface is currently in Russian; the labels above are the literal button captions.

## Settings

- **Default folders** — one per line; the first one is prefilled in the dialog and opened by the "last folder" command.
- **Service folders** — comma-separated names; they are not shown and do not count towards sizes.
- **Folders per node** — how many child folders to show at once (the rest go under "ещё N"), 45 by default.
- **Show files** — render files next to folders.
- **Files per node** — how many files to show inside one folder, 10 by default.
- **Read depth** — nesting limit while scanning, 14 by default.
- **Index** — stored in the plugin folder and updated by directory modification time; the timer-based cache is no longer used.
- **Clear cache** — delete the index and saved scans.

## Rename and move

Right click any node — folder or file:

- **Rename** — dialog with the current name; the caret is placed before the extension so it is easy to keep or replace. Invalid characters and taken names are rejected.
- **Move** — dialog with the destination path (current folder by default, saved paths below). Cross-drive copies are handled automatically.
- **Copy path** — full path to the clipboard.

After the operation the tree, sizes and index are updated immediately; no manual rescan is needed.

## Drag and drop

Drag any node with the mouse: a label follows the cursor, a valid destination folder gets an accent border, the source node fades. Drop it on a folder and the file or folder moves there; tree and index update at once.

Not allowed: dropping onto a file (folders only), onto the node itself, or into its own subtree — such targets are not highlighted. Releasing over empty space cancels the move.

A folder without subfolders shows its file count next to the size — "0 файлов · 0 Б", "3 файла · 1,2 МБ"; a folder with subfolders shows the number of subfolders: "2 пап. · 14,1 МБ". Everything sits on one line on the right, so the name is clipped to the remaining width. Such a folder without subfolders also expands: inside there are either its files or a "пусто" marker.

If the destination folder already contains an object with the same name, the plugin shows the native system dialog: **Replace** (the old object is deleted permanently), **Rename** (the new one becomes `file (2).txt`) or **Cancel** (nothing is moved).

Mistake? The "отменить" button in the toolbar reverts the last move or rename (history lasts for the session).

## Index and search

The folder index lives in `<plugin>/cache/idx-<hash>.json` and stores, per directory, its mtime, names of subfolders and files with their sizes.

- When the map opens, each directory gets a single `stat`: if the mtime matches the index, the contents come from the index and files are not stat-ed again.
- A directory that changed (something added, removed or renamed inside) is re-read on its own.
- Hidden names and depth are applied while building the tree, so toggling "служебные" does not invalidate the index.
- Search covers the folders on the map and every file in the index: a result shows the name, size and folder; clicking reveals that folder on the map.

## File names

A file is shown with its extension. If the name does not fit the node, only the name is clipped and the extension stays: `verylongname_aaaa….txt`.

## Technical notes

- `isDesktopOnly: true` — the plugin uses Node `fs` and `path` directly.
- Scanning runs in parallel (8 workers, `fs.promises`) and does not block the UI; progress is shown in the status bar.
- Hidden folders and service names never count towards sizes or counters.
- Index and cache live in `<plugin>/cache/` and contain only the tree and sizes, no service references.
- The map is its own `ItemView` (`folder-mindmap-view`), separate from notes.
- No telemetry, no network requests: everything happens locally.

## Project layout

```
main.js          the whole plugin: scanning, aggregation, layout, view, settings
styles.css       map and toolbar styling
manifest.json    Obsidian manifest (id, version, minimum app version)
tests/           Node checks of the logic without launching Obsidian
```

## Development and checks

Unit checks need no Obsidian — the `obsidian` module is stubbed:

```bash
node tests/logic.test.js main.js
```

They cover scanning, size aggregation, counters, the child node limit and layout on a temporary tree.

Live checks (Obsidian 1.15.0): opening a folder, expanding/collapsing nodes, search with jump, toggling service folders, restoring the view after a restart, dragging files and folders (including cancelling a move and refusing to put a folder inside itself), the undo button, the system dialog on name conflicts, expanding empty folders, the index (5,208 directories / 68,525 files: first open 2.4 s, second 0.3 s, a new file is picked up by re-reading a single directory) and file name search from the index.

## Limitations

- Desktop only.
- Very large directories are slow on the very first open (the index is built once); afterwards opening is nearly instant.
- Sizes come from the real files: symbolic links and cloud "placeholders" may be reported inaccurately.
- The plugin works with real files on disk: renames and moves are irreversible and do not use the Obsidian trash.

## License

MIT — see [LICENSE](LICENSE).
