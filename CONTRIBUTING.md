# Contributing

Thanks for taking a look at Folder Mindmap.

## Before you start

The plugin is a single-file codebase (`main.js`) with no build step: what is in the repository is exactly what Obsidian loads. There is no bundler, no TypeScript and no third-party runtime dependency — keep it that way unless there is a strong reason.

## Running the checks

```bash
node tests/logic.test.js main.js
```

The checks stub the `obsidian` module and run against a temporary directory, so no vault and no app are needed. Every change to scanning, aggregation, layout or the index should keep these green; new behaviour deserves a new assertion.

## Trying the plugin by hand

1. Copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/folder-mindmap/`.
2. In Obsidian: Settings → Community plugins → Reload plugins.
3. Point the map at a throwaway folder, never at a folder with your only copy of something: rename, move and replace act on real files.

## Pull requests

- Keep changes focused; describe what you changed and how you verified it.
- Do not reformat unrelated lines — the diff should show the change and nothing else.
- UI strings are currently Russian; if you add new ones, keep the same language so the interface stays consistent until i18n lands.
- Anything that touches the file system must stay inside the folder the user opened, plus the plugin's own `cache/` directory.
- No telemetry and no network requests.

## Reporting a bug

Include the folder shape (names are enough, no contents), the Obsidian version, and what you expected versus what happened. If the map drew something odd, a screenshot of the node is worth more than a paragraph.
