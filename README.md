# myls-dumper

A Tampermonkey userscript for Brightspace/D2L-based LMS sites (e.g. Waterloo's myLS) that walks a course's Content module tree and bundles every file-backed topic into a single zip, preserving the module folder structure. Intended for personal archival of courses you are enrolled in — e.g. keeping local copies of lecture slides and handouts before course access expires at the end of term.

## Usage

1. Install [Tampermonkey](https://www.tampermonkey.net/) and add `myls-dumper.user.js`.
2. Open a course's Content page (`/d2l/le/content/<orgId>/Home`).
3. Click **Dump Course Content** in the floating panel (bottom-right). A progress bar tracks downloads; **Stop** halts after the in-flight file, **Save Log** exports the run log.
4. When finished, a `myls-dump-<timestamp>.zip` is saved via the browser's normal download flow, followed by the run log as `myls-dumper-log-<timestamp>.txt`.

Also exposed on `window` for console use: `dumpMyLS()`, `stopMyLSDump()`, `saveMyLSDumpLog()`.

## How it works

- The module tree (`#D2L_LE_Content_TreeBrowser`) is rendered fully client-side, so the script walks the DOM recursively and collects `ModuleCO-<id>` keys plus titles.
- Each module's topic list is fetched via `ModuleDetailsPartial?mId=<id>` (same-origin XHR). D2L wraps some responses in a `while(1);` JSON envelope, which is stripped and searched for the HTML payload.
- For each topic, `CheckFileTopicInfo` determines whether it is file-backed; broken and "packageable" (SCORM etc.) topics are skipped. File-backed topics are fetched from `DirectFileTopicDownload`, with the real filename recovered from `Content-Disposition` (`filename*=` preferred over `filename=`). Filenames are reduced to their basename and stripped of characters that are illegal on Windows; if two topics in the same module resolve to the same name, the second gets `-<topicId>` appended and the rename is logged.
- Topics referenced from multiple modules are deduplicated — deepest module wins, so files land in the most specific folder.
- All requests use `credentials: 'same-origin'` — the script rides your existing browser session. Nothing is stored, sent anywhere else, or persisted beyond the generated zip/log.
- A 300 ms pause between modules and between topics keeps load on the LMS modest.

## Compliance

This tool downloads course materials you already have access to. **You are responsible for complying with your institution's acceptable-use policies and the copyright terms of course materials.** Downloaded content is for your own personal use/archival — do not redistribute it. If your institution prohibits automated access, don't use this.

## Known limitations

- Will probably not work for all course content layouts — depends on the standard D2L content tree markup.
- Modules with a "Load More" pager may yield incomplete topic lists (a warning is logged per module and a count is printed in the summary).
- Non-file topics (links, quizzes, discussions, SCORM packages) are skipped by design.
- No retry on transient fetch failures. A module that fails to list or a topic that fails to download is logged and skipped, and the run continues; re-run the dump if the summary shows failures.
- When `Content-Disposition` is missing, the topic title is used as the filename, so the extension may be absent.
- The whole zip is assembled in memory before download, so very large courses (hundreds of MB of video) may exhaust the tab's memory.
