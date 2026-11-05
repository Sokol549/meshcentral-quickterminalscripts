# Changelog

All notable changes to the **QuickTerminalScripts** plugin will be documented in this file.

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
