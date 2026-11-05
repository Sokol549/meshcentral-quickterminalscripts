# Changelog

All notable changes to the **QuickTerminalScripts** plugin will be documented in this file.

## [1.0.9] - 2026-11-05
### Fixed
- Fixed command-line expansion and UTF-8 encoding in PowerShell launcher:
  - Replaced unencoded `-Command "..."` string with self-contained UTF-16LE Base64 `-EncodedCommand` for the raw script launcher (~900 characters).
  - This eliminates variable expansion issues in PowerShell sessions where `{$true}` was previously stripped to `{True}` causing `True: command not found` and SSL/TLS validation failures.
  - Replaced `(New-Object Net.WebClient).DownloadString` with `[Text.Encoding]::UTF8.GetString((New-Object Net.WebClient).DownloadData(...))` ensuring Russian / Cyrillic script content is parsed with 100% strict UTF-8 decoding without ANSI mojibake.
  - Fully compatible with execution from both `cmd.exe` and `powershell.exe`.

## [1.0.8] - 2026-11-05
### Fixed
- Fixed execution of large scripts in `cmd.exe` terminal:
  - Added HTTP endpoint `/plugin/quickterminalscripts/api/raw?id=<scriptId>` serving raw script text.
  - Automatically promoted plugin routes in Express router stack ahead of MeshCentral's 404 catch-all handler so routes are always matched cleanly.
  - When script content is large (> 4000 characters Base64), the command sent to terminal is compact (~250 characters) and executes in-memory via `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]'Ssl3,Tls,Tls11,Tls12'; [Net.ServicePointManager]::ServerCertificateValidationCallback={$true}; (New-Object Net.WebClient).DownloadString('<rawUrl>') | iex"`.
  - Fully compatible with `cmd.exe` input buffer limit (8,191 bytes) and runs cleanly in both `cmd.exe` and PowerShell across all Windows versions.
  - For small scripts (<= 4000 characters Base64), standard `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand <base64>` is used.
  - Fixed terminal reference resolution (`(window.terminal || terminal)`) and added automatic focus to xterm on command execution.
- Added persistent repository backup file `SCRIPTS_BACKUP.json` tracking all registered scripts to guarantee zero script loss across updates.

## [1.0.7] - 2026-11-05
### Fixed
- Fixed multi-admin script overwriting:
  - Replaced bulk array save with atomic single-script operations (`saveScript` / `deleteScript`).
  - Adding or modifying a script now merges by `id` directly into the current server database on disk, preventing admins from overwriting each other's scripts.
  - Deleting a script targets only the specific script ID.

## [1.0.6] - 2026-11-05
### Fixed
- Fixed multi-admin and multi-device real-time script synchronization:
  - Added server-side WebSocket broadcast (`broadcastToAllUsers`) across all active MeshCentral sessions (`serverCore.webserver.wssessions2` & `wssessions`) whenever scripts are saved via WebSocket or REST API.
  - Removed local cache gating (`this.scripts.length === 0`) in client controller: `loadScripts()` now actively queries the server on device switch, dropdown open, admin modal open, and via 10-second periodic background polling.
  - Added HTTP cache busting query parameter (`?_=${Date.now()}`) and strict server headers (`Cache-Control: no-cache, no-store, must-revalidate`) preventing browser HTTP caching.
  - Synchronized client-side inlined code in `quickterminalscripts.js` with `public/terminalscripts.js`.

## [1.0.5] - 2026-11-05
### Fixed
- Fixed `NativeCommandFailed` / `Имя файла или его расширение имеет слишком большую длину` (Win32 `ERROR_FILENAME_EXCED_RANGE`) on long scripts when using Base64:
  - If Base64 string exceeds 6,000 characters (hitting Windows `CreateProcess` 32,767-character command line limit), the plugin now invokes the code in-memory via `& ([ScriptBlock]::Create(...))` without spawning an external `powershell.exe` process.
  - Chunked Uint8Array to binary string conversion for high-performance encoding of scripts > 100 KB.
  - Normalized CRLF line endings for raw multiline script execution when Base64 wrapper is disabled.

## [1.0.4] - 2026-11-05
### Fixed
- Fixed script synchronization across nodes, new browser tabs, and page reloads by implementing WebSocket polling retry in `loadScripts()`.
- Added instant script restoration and offline caching using `localStorage`.
- Enhanced OS detection with MeshCentral's native `isWindowsNode()` and extended 64-bit/ARM agent ID tables.
- Added empty-state transparency in the dropdown: if commands exist on the server but are filtered out by OS, users can click "Показать все скрипты" to display them anyway.
- Fixed dropdown footer so the administrator management button is always visible even when 0 filtered scripts match.

## [1.0.3] - 2026-11-05
### Fixed
- Fixed admin detection by inspecting `userinfo` and MeshCentral global user objects.
- Added dynamic visibility handling for the settings button (`#qts-btn-settings`) so it appears reliably even if user info loads asynchronously after DOM mounting.
- Added admin management quick link directly inside the dropdown menu footer.

## [1.0.1] - 2026-11-05
### Changed
- Inlined CSS and client logic in onWebUIStartupEnd for instant zero-dependency execution.

## [1.0.0] - 2026-11-05

### Added
- Initial release of QuickTerminalScripts for MeshCentral.
- Interactive toolbar integrated directly into the Terminal tab (`#terminalCustomUiButtons`).
- Live-search Combobox with keyboard navigation (Up, Down, Enter, Escape).
- OS automatic detection and filtering (`windows`, `linux`, `macos`, `all`).
- Safe execution engine with Base64 encoding:
  - PowerShell strict UTF-16LE `-EncodedCommand` wrapper for Windows.
  - Bash UTF-8 `echo ... | base64 -d | bash` wrapper for Linux & macOS.
- Action button dynamically adapting between "Выполнить" (autoExecute) and "Вставить" (paste).
- Admin CRUD modal with search, script creation, editing, and deletion.
- Server-side atomic storage persistence in `meshcentral-data/quickterminalscripts.json`.
- Automatic backup file `.bak` generation and validation.
- Express REST API & WebSocket message handling for scripts CRUD operations.
