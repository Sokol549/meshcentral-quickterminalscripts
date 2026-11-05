/**
 * QuickTerminalScripts Plugin for MeshCentral
 * Client-Side Controller & Terminal Injector
 */

(function () {
    'use strict';

    if (window._quickTerminalScriptsLoaded) return;
    window._quickTerminalScriptsLoaded = true;

    var QTS = {
        scripts: [],
        selectedScript: null,
        dropdownOpen: false,
        filteredScripts: [],
        highlightedIndex: -1,
        currentNodeId: null,
        currentOS: 'all',
        editingScriptId: null,
        modalSearchQuery: '',

        // -------------------------------------------------------------
        // Initialization
        // -------------------------------------------------------------
        init: function () {
            this.ensureStylesLoaded();
            this.loadScripts();
            this.setupHooks();
            this.mountToolbar();

            // Setup global click listener to close dropdown on outside clicks
            document.addEventListener('click', function (e) {
                var container = document.getElementById('qts-toolbar-container');
                if (container && !container.contains(e.target)) {
                    QTS.closeDropdown();
                }
            });

            // Re-check periodically and on DOM changes to ensure toolbar is mounted
            setInterval(function () {
                QTS.checkAndMount();
            }, 1000);

            // Periodic background sync with server to pick up scripts added by other admins
            setInterval(function () {
                QTS.loadScripts();
            }, 10000);
        },

        ensureStylesLoaded: function () {
            if (!document.getElementById('qts-styles')) {
                var link = document.createElement('link');
                link.id = 'qts-styles';
                link.rel = 'stylesheet';
                link.type = 'text/css';
                link.href = '/plugin/quickterminalscripts/terminalscripts.css';
                document.head.appendChild(link);
            }
        },

        // -------------------------------------------------------------
        // Permissions & User Status
        // -------------------------------------------------------------
        isUserAdmin: function () {
            try {
                var u = (typeof window.userinfo !== 'undefined' && window.userinfo) 
                    || (typeof userinfo !== 'undefined' && userinfo)
                    || (typeof window.user !== 'undefined' && window.user)
                    || (typeof user !== 'undefined' && user)
                    || (typeof window.currentUser !== 'undefined' && window.currentUser)
                    || (typeof currentUser !== 'undefined' && currentUser);
                if (u) {
                    var sa = u.siteadmin;
                    if (sa === 0xFFFFFFFF || sa === 4294967295 || sa === -1) return true;
                    if (typeof sa === 'number' && sa !== 0) return true;
                    if (sa === true || sa === 1) return true;
                }
            } catch (e) {}
            return false;
        },

        updateAdminVisibility: function () {
            var isAdmin = this.isUserAdmin();
            var settingsBtn = document.getElementById('qts-btn-settings');
            if (settingsBtn) {
                settingsBtn.style.display = isAdmin ? 'inline-flex' : 'none';
            }
            var dropdownAdminFooter = document.getElementById('qts-dropdown-admin-footer');
            if (dropdownAdminFooter) {
                dropdownAdminFooter.style.display = isAdmin ? 'block' : 'none';
            }
        },

        // -------------------------------------------------------------
        // OS Detection
        // -------------------------------------------------------------
        detectCurrentOS: function () {
            var node = (typeof window.currentNode !== 'undefined' && window.currentNode) 
                ? window.currentNode 
                : (typeof window.getCurrentNode === 'function' ? window.getCurrentNode() : null);

            if (!node) return 'all';

            // 1. MeshCentral built-in helper functions
            try {
                if (typeof window.isWindowsNode === 'function' && window.isWindowsNode(node)) return 'windows';
                if (typeof window.isMacNode === 'function' && window.isMacNode(node)) return 'macos';
            } catch (e) {}

            // 2. Node OS description & os field
            var os = (node.os || '').toLowerCase();
            if (os.indexOf('win') !== -1) return 'windows';
            if (os.indexOf('linux') !== -1) return 'linux';
            if (os.indexOf('darwin') !== -1 || os.indexOf('mac') !== -1) return 'macos';

            var osdesc = (node.osdesc || '').toLowerCase();
            if (osdesc.indexOf('win') !== -1) return 'windows';
            if (osdesc.indexOf('linux') !== -1 || osdesc.indexOf('ubuntu') !== -1 || 
                osdesc.indexOf('debian') !== -1 || osdesc.indexOf('centos') !== -1 || 
                osdesc.indexOf('red hat') !== -1 || osdesc.indexOf('alpine') !== -1) return 'linux';
            if (osdesc.indexOf('mac') !== -1 || osdesc.indexOf('darwin') !== -1 || osdesc.indexOf('osx') !== -1) return 'macos';

            // 3. MeshCentral Agent ID mapping
            if (node.agent && typeof node.agent.id === 'number') {
                var aid = node.agent.id;
                if ([1, 2, 3, 4, 10, 11, 21, 22, 34, 42, 43].indexOf(aid) !== -1) return 'windows';
                if ([16, 29, 30].indexOf(aid) !== -1) return 'macos';
                if ([5, 6, 7, 8, 9, 12, 13, 14, 15, 17, 18, 19, 20, 23, 24, 25, 26, 27, 28].indexOf(aid) !== -1) return 'linux';
            }

            return 'all';
        },

        // -------------------------------------------------------------
        // Data Loading & Synchronization
        // -------------------------------------------------------------
        loadScripts: function () {
            var self = this;

            // 1. Instant cache restoration from localStorage for immediate UI availability
            if (self.scripts.length === 0) {
                try {
                    var cached = localStorage.getItem('qts_scripts_cache');
                    if (cached) {
                        var parsed = JSON.parse(cached);
                        if (Array.isArray(parsed) && parsed.length > 0) {
                            self.setScripts(parsed, true);
                        }
                    }
                } catch (e) {}
            }

            // 2. Query via WebSocket from server
            function sendWsGet() {
                if (window.meshserver && typeof window.meshserver.send === 'function') {
                    try {
                        window.meshserver.send({
                            action: 'plugin',
                            plugin: 'quickterminalscripts',
                            pluginaction: 'getScripts'
                        });
                        return true;
                    } catch (e) {}
                }
                return false;
            }

            var ms = window.meshserver;
            var isWsReady = ms && (
                (ms.socket && ms.socket.readyState === 1) ||
                (ms.ws && ms.ws.readyState === 1) ||
                (ms.connectstate === 1) ||
                (typeof window.userinfo !== 'undefined' && window.userinfo !== null)
            );

            if (isWsReady && sendWsGet()) {
                // Sent successfully
            } else {
                var retryCount = 0;
                var pollTimer = setInterval(function () {
                    retryCount++;
                    var ms2 = window.meshserver;
                    var readyNow = ms2 && (
                        (ms2.socket && ms2.socket.readyState === 1) ||
                        (ms2.ws && ms2.ws.readyState === 1) ||
                        (ms2.connectstate === 1) ||
                        (typeof window.userinfo !== 'undefined' && window.userinfo !== null)
                    );
                    if (readyNow && sendWsGet()) {
                        clearInterval(pollTimer);
                    } else if (retryCount > 40) {
                        clearInterval(pollTimer);
                    }
                }, 250);
            }

            // 3. Redundant HTTP REST fallback with cache busting
            fetch('/plugin/quickterminalscripts/api/scripts?_=' + Date.now(), { 
                cache: 'no-store',
                credentials: 'same-origin' 
            })
                .then(function (res) {
                    if (res.ok) return res.json();
                })
                .then(function (data) {
                    if (Array.isArray(data)) {
                        self.setScripts(data);
                    }
                })
                .catch(function () {});
        },

        setScripts: function (newScripts, fromCache) {
            if (!Array.isArray(newScripts)) return;
            this.scripts = newScripts;
            if (!fromCache) {
                try {
                    localStorage.setItem('qts_scripts_cache', JSON.stringify(newScripts));
                } catch (e) {}
            }
            this.updateFilteredScripts();
            this.renderDropdown();
            if (this.modalOpen) {
                this.renderScriptListView();
            }
            // If currently selected script was modified or deleted, update selection
            if (this.selectedScript) {
                var found = null;
                for (var i = 0; i < this.scripts.length; i++) {
                    if (this.scripts[i].id === this.selectedScript.id) {
                        found = this.scripts[i];
                        break;
                    }
                }
                this.selectScript(found);
            }
        },

        saveSingleScript: function (scriptItem, callback) {
            var self = this;
            var sentWs = false;
            if (window.meshserver && typeof window.meshserver.send === 'function') {
                try {
                    self._pendingSaveCallback = callback;
                    window.meshserver.send({
                        action: 'plugin',
                        plugin: 'quickterminalscripts',
                        pluginaction: 'saveScript',
                        script: scriptItem
                    });
                    sentWs = true;
                } catch (e) {}
            }

            if (!sentWs) {
                var updated = self.scripts.slice();
                var found = false;
                for (var i = 0; i < updated.length; i++) {
                    if (updated[i].id === scriptItem.id) { updated[i] = scriptItem; found = true; break; }
                }
                if (!found) updated.push(scriptItem);
                self.saveScriptsToServer(updated, callback);
            }
        },

        deleteSingleScript: function (scriptId, callback) {
            var self = this;
            var sentWs = false;
            if (window.meshserver && typeof window.meshserver.send === 'function') {
                try {
                    self._pendingSaveCallback = callback;
                    window.meshserver.send({
                        action: 'plugin',
                        plugin: 'quickterminalscripts',
                        pluginaction: 'deleteScript',
                        id: scriptId
                    });
                    sentWs = true;
                } catch (e) {}
            }

            if (!sentWs) {
                var filtered = self.scripts.filter(function (s) { return s.id !== scriptId; });
                self.saveScriptsToServer(filtered, callback);
            }
        },

        saveScriptsToServer: function (scriptsToSave, callback) {
            var self = this;
            self.setScripts(scriptsToSave); // Instant local update

            var sentWs = false;
            if (window.meshserver && typeof window.meshserver.send === 'function') {
                try {
                    self._pendingSaveCallback = callback;
                    window.meshserver.send({
                        action: 'plugin',
                        plugin: 'quickterminalscripts',
                        pluginaction: 'saveScripts',
                        scripts: scriptsToSave
                    });
                    sentWs = true;
                } catch (e) {}
            }

            // HTTP POST fallback
            fetch('/plugin/quickterminalscripts/api/scripts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify(scriptsToSave)
            })
            .then(function (res) {
                if (res.ok) return res.json();
            })
            .then(function (result) {
                if (self._pendingSaveCallback) {
                    var cb = self._pendingSaveCallback;
                    delete self._pendingSaveCallback;
                    cb(null, result);
                }
            })
            .catch(function (err) {
                if (!sentWs && typeof callback === 'function') {
                    callback(err);
                }
            });
        },

        // -------------------------------------------------------------
        // MeshCentral Lifecycle Hooks
        // -------------------------------------------------------------
        setupHooks: function () {
            var self = this;

            // Hook into MeshCentral pluginHandler if present
            if (window.pluginHandler) {
                var existingOnDeviceRefreshEnd = window.pluginHandler.onDeviceRefreshEnd;
                window.pluginHandler.onDeviceRefreshEnd = function () {
                    if (typeof existingOnDeviceRefreshEnd === 'function') {
                        try { existingOnDeviceRefreshEnd.apply(this, arguments); } catch (e) {}
                    }
                    self.onDeviceChanged();
                };
            }

            // Listen to tab selection buttons
            var terminalTabBtn = document.getElementById('MainDevTerminal');
            if (terminalTabBtn) {
                terminalTabBtn.addEventListener('click', function () {
                    setTimeout(function () { self.checkAndMount(); }, 100);
                });
            }
        },

        onDeviceChanged: function () {
            this.currentOS = this.detectCurrentOS();
            this.updateFilteredScripts();
            this.renderDropdown();
            this.checkAndMount();
            this.loadScripts();
        },

        checkAndMount: function () {
            var p12 = document.getElementById('p12');
            var isTerminalVisible = p12 && (p12.style.display !== 'none');
            if (isTerminalVisible) {
                this.mountToolbar();
            }
            this.updateAdminVisibility();
        },

        // -------------------------------------------------------------
        // UI Mounting
        // -------------------------------------------------------------
        mountToolbar: function () {
            if (document.getElementById('qts-toolbar-container')) {
                this.updateAdminVisibility();
                return;
            }

            // Target mount points in order of preference
            var target = document.getElementById('terminalCustomUiButtons');
            if (!target) {
                var connectSpan = document.getElementById('connectbutton2span');
                if (connectSpan && connectSpan.parentNode) {
                    target = connectSpan.parentNode;
                }
            }
            if (!target) {
                target = document.getElementById('p12');
            }
            if (!target) return;

            var container = document.createElement('div');
            container.id = 'qts-toolbar-container';
            container.className = 'qts-container';

            container.innerHTML = [
                '<div class="qts-combobox" id="qts-combobox">',
                '  <div class="qts-input-wrap">',
                '    <span class="qts-icon-search">⚡</span>',
                '    <input type="text" id="qts-search-input" class="qts-input" placeholder="Быстрые скрипты..." autocomplete="off" />',
                '    <button type="button" id="qts-btn-clear" class="qts-btn-clear" title="Очистить выбор">&times;</button>',
                '    <button type="button" id="qts-btn-toggle" class="qts-btn-toggle" title="Показать список">&#9662;</button>',
                '  </div>',
                '  <ul id="qts-dropdown-list" class="qts-dropdown-list" style="display:none;"></ul>',
                '</div>',
                '<button type="button" id="qts-btn-action" class="qts-btn qts-btn-action" disabled title="Выберите команду для запуска">Вставить</button>',
                '<button type="button" id="qts-btn-settings" class="qts-btn qts-btn-settings" style="display:none;" title="Управление скриптами (Администратор)">⚙️</button>'
            ].join('');

            // Prepend or append depending on container type
            if (target.id === 'terminalCustomUiButtons') {
                target.appendChild(container);
            } else if (target.id === 'connectbutton2span' || (target.firstChild && target.firstChild.id === 'connectbutton2span')) {
                target.insertBefore(container, target.firstChild);
            } else {
                target.appendChild(container);
            }

            this.bindToolbarEvents();
            this.currentOS = this.detectCurrentOS();
            this.updateFilteredScripts();
            this.renderDropdown();
            this.updateAdminVisibility();
        },

        // -------------------------------------------------------------
        // Toolbar Event Handlers
        // -------------------------------------------------------------
        bindToolbarEvents: function () {
            var self = this;
            var input = document.getElementById('qts-search-input');
            var clearBtn = document.getElementById('qts-btn-clear');
            var toggleBtn = document.getElementById('qts-btn-toggle');
            var actionBtn = document.getElementById('qts-btn-action');
            var settingsBtn = document.getElementById('qts-btn-settings');

            if (input) {
                input.addEventListener('focus', function () {
                    self.openDropdown();
                });

                input.addEventListener('input', function () {
                    var val = input.value;
                    if (clearBtn) clearBtn.style.display = val ? 'block' : 'none';
                    self.updateFilteredScripts(val);
                    self.openDropdown();
                });

                input.addEventListener('keydown', function (e) {
                    self.handleInputKeydown(e);
                });
            }

            if (clearBtn) {
                clearBtn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    self.selectScript(null);
                    if (input) {
                        input.value = '';
                        input.focus();
                    }
                    clearBtn.style.display = 'none';
                    self.updateFilteredScripts('');
                    self.openDropdown();
                });
            }

            if (toggleBtn) {
                toggleBtn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    if (self.dropdownOpen) {
                        self.closeDropdown();
                    } else {
                        self.openDropdown();
                        if (input) input.focus();
                    }
                });
            }

            if (actionBtn) {
                actionBtn.addEventListener('click', function () {
                    if (self.selectedScript) {
                        self.executeScript(self.selectedScript);
                    }
                });
            }

            if (settingsBtn) {
                settingsBtn.addEventListener('click', function () {
                    self.openAdminModal();
                });
            }
        },

        // -------------------------------------------------------------
        // Dropdown Filtering & Keyboard Navigation
        // -------------------------------------------------------------
        updateFilteredScripts: function (query) {
            query = (query || '').toLowerCase().trim();
            var targetOS = this.currentOS;
            var showAll = this._showAllOSOverride;

            this.filteredScripts = this.scripts.filter(function (s) {
                // OS Filter
                var matchesOS = false;
                if (showAll || !s.targetOS || s.targetOS === 'all' || targetOS === 'all') {
                    matchesOS = true;
                } else if (targetOS === 'windows' && s.targetOS === 'windows') {
                    matchesOS = true;
                } else if (targetOS === 'linux' && s.targetOS === 'linux') {
                    matchesOS = true;
                } else if (targetOS === 'macos' && s.targetOS === 'macos') {
                    matchesOS = true;
                }

                if (!matchesOS) return false;

                // Title & Content Search Filter
                if (!query) return true;
                var inTitle = (s.title || '').toLowerCase().indexOf(query) !== -1;
                var inContent = (s.content || '').toLowerCase().indexOf(query) !== -1;
                return inTitle || inContent;
            });

            this.highlightedIndex = -1;
            this.renderDropdown();
        },

        renderDropdown: function () {
            var list = document.getElementById('qts-dropdown-list');
            if (!list) return;

            var self = this;
            var html = [];

            if (this.filteredScripts.length === 0) {
                if (this.scripts.length === 0) {
                    html.push('<li class="qts-dropdown-empty">Загрузка скриптов...</li>');
                } else {
                    html.push(
                        '<li class="qts-dropdown-empty">',
                        '  <div style="font-weight:600;margin-bottom:4px;color:#1e293b;">Нет команд для ОС «' + (this.currentOS || 'все') + '»</div>',
                        '  <div style="font-size:11px;color:#64748b;margin-bottom:6px;">Всего скриптов в базе: ' + this.scripts.length + '</div>',
                        '  <button type="button" id="qts-btn-show-all-os" style="background:#2563eb;color:#ffffff;border:none;border-radius:4px;padding:3px 8px;font-size:11px;cursor:pointer;">Показать все скрипты</button>',
                        '</li>'
                    );
                }
            } else {
                for (var i = 0; i < this.filteredScripts.length; i++) {
                    var s = this.filteredScripts[i];
                    var isActive = (i === this.highlightedIndex);
                    var isSelected = (self.selectedScript && self.selectedScript.id === s.id);

                    var badgeClass = 'qts-badge-all';
                    var badgeLabel = 'Все';
                    if (s.targetOS === 'windows') { badgeClass = 'qts-badge-win'; badgeLabel = 'Win'; }
                    else if (s.targetOS === 'linux') { badgeClass = 'qts-badge-linux'; badgeLabel = 'Linux'; }
                    else if (s.targetOS === 'macos') { badgeClass = 'qts-badge-macos'; badgeLabel = 'macOS'; }

                    var enterFlag = s.autoExecute ? '<span class="qts-badge qts-badge-flag" title="Авто-Enter (выполнение)">↵ Enter</span>' : '';
                    var b64Flag = s.useBase64 ? '<span class="qts-badge qts-badge-flag" title="Base64 безопасная обертка">B64</span>' : '';

                    html.push(
                        '<li class="qts-dropdown-item' + (isActive ? ' qts-item-active' : '') + (isSelected ? ' qts-item-selected' : '') + '" data-index="' + i + '">',
                        '  <div class="qts-item-left">',
                        '    <span class="qts-badge ' + badgeClass + '">' + badgeLabel + '</span>',
                        '    <span class="qts-item-title" title="' + self.escapeHtml(s.title) + '">' + self.escapeHtml(s.title) + '</span>',
                        '  </div>',
                        '  <div class="qts-item-right">',
                        '    ' + enterFlag,
                        '    ' + b64Flag,
                        '  </div>',
                        '</li>'
                    );
                }
            }

            if (this.isUserAdmin()) {
                html.push(
                    '<li class="qts-dropdown-footer">',
                    '  <button type="button" class="qts-btn-dropdown-admin" id="qts-dropdown-manage-btn">⚙️ Управление скриптами (Администратор)</button>',
                    '</li>'
                );
            }

            list.innerHTML = html.join('');

            var showAllBtn = document.getElementById('qts-btn-show-all-os');
            if (showAllBtn) {
                showAllBtn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    self._showAllOSOverride = true;
                    self.updateFilteredScripts();
                    self.renderDropdown();
                });
            }

            var manageBtn = document.getElementById('qts-dropdown-manage-btn');
            if (manageBtn) {
                manageBtn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    self.closeDropdown();
                    self.openAdminModal();
                });
            }

            // Click bindings
            var items = list.querySelectorAll('.qts-dropdown-item');
            for (var j = 0; j < items.length; j++) {
                (function (idx) {
                    items[idx].addEventListener('click', function (e) {
                        e.stopPropagation();
                        self.selectScript(self.filteredScripts[idx]);
                        self.closeDropdown();
                    });
                })(j);
            }
        },

        handleInputKeydown: function (e) {
            if (!this.dropdownOpen) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    this.openDropdown();
                    e.preventDefault();
                    return;
                }
                if (e.key === 'Enter' && this.selectedScript) {
                    this.executeScript(this.selectedScript);
                    e.preventDefault();
                    return;
                }
                return;
            }

            var count = this.filteredScripts.length;
            if (count === 0) return;

            if (e.key === 'ArrowDown') {
                this.highlightedIndex = (this.highlightedIndex + 1) % count;
                this.renderDropdown();
                this.scrollHighlightedIntoView();
                e.preventDefault();
            } else if (e.key === 'ArrowUp') {
                this.highlightedIndex = (this.highlightedIndex - 1 + count) % count;
                this.renderDropdown();
                this.scrollHighlightedIntoView();
                e.preventDefault();
            } else if (e.key === 'Enter') {
                if (this.highlightedIndex >= 0 && this.highlightedIndex < count) {
                    this.selectScript(this.filteredScripts[this.highlightedIndex]);
                    this.closeDropdown();
                } else if (this.selectedScript) {
                    this.executeScript(this.selectedScript);
                    this.closeDropdown();
                }
                e.preventDefault();
            } else if (e.key === 'Escape') {
                this.closeDropdown();
                e.preventDefault();
            }
        },

        scrollHighlightedIntoView: function () {
            var list = document.getElementById('qts-dropdown-list');
            if (!list) return;
            var active = list.querySelector('.qts-item-active');
            if (active) {
                active.scrollIntoView({ block: 'nearest' });
            }
        },

        openDropdown: function () {
            this.loadScripts();
            var list = document.getElementById('qts-dropdown-list');
            if (list) {
                list.style.display = 'block';
                this.dropdownOpen = true;
            }
        },

        closeDropdown: function () {
            var list = document.getElementById('qts-dropdown-list');
            if (list) {
                list.style.display = 'none';
                this.dropdownOpen = false;
            }
        },

        selectScript: function (script) {
            this.selectedScript = script;
            var input = document.getElementById('qts-search-input');
            var actionBtn = document.getElementById('qts-btn-action');
            var clearBtn = document.getElementById('qts-btn-clear');

            if (script) {
                if (input) input.value = script.title;
                if (clearBtn) clearBtn.style.display = 'block';
                if (actionBtn) {
                    actionBtn.disabled = false;
                    if (script.autoExecute) {
                        actionBtn.innerText = 'Выполнить';
                        actionBtn.className = 'qts-btn qts-btn-action qts-btn-run';
                        actionBtn.title = 'Вставить команду и нажать Enter';
                    } else {
                        actionBtn.innerText = 'Вставить';
                        actionBtn.className = 'qts-btn qts-btn-action qts-btn-paste';
                        actionBtn.title = 'Вставить текст команды без отправки Enter';
                    }
                }
            } else {
                if (input) input.value = '';
                if (clearBtn) clearBtn.style.display = 'none';
                if (actionBtn) {
                    actionBtn.disabled = true;
                    actionBtn.innerText = 'Вставить';
                    actionBtn.className = 'qts-btn qts-btn-action';
                    actionBtn.title = 'Выберите команду для запуска';
                }
            }
        },

        // -------------------------------------------------------------
        // Core Engine: Base64 Encoding & Payload Builder
        // -------------------------------------------------------------
        encodePowerShellCommand: function (commandText, script) {
            // Strict UTF-16LE conversion for PowerShell
            var byteArray = new Uint8Array(commandText.length * 2);
            for (var i = 0; i < commandText.length; i++) {
                var code = commandText.charCodeAt(i);
                byteArray[i * 2] = code & 0xff;          // Low byte
                byteArray[i * 2 + 1] = (code >> 8) & 0xff; // High byte
            }
            var binaryString = '';
            var chunkSize = 8192;
            for (var j = 0; j < byteArray.byteLength; j += chunkSize) {
                var chunk = byteArray.subarray(j, j + chunkSize);
                binaryString += String.fromCharCode.apply(null, chunk);
            }
            var base64 = btoa(binaryString);

            // If base64 fits within the cmd.exe line buffer (<= 4000 chars), use self-contained -EncodedCommand
            if (base64.length <= 4000) {
                return 'powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ' + base64;
            }

            // For large scripts (> 4000 chars Base64), stream securely via server raw endpoint
            var scriptId = (script && script.id) ? script.id : '';
            var origin = window.location.origin || (window.location.protocol + '//' + window.location.host);
            var rawUrl = origin + '/plugin/quickterminalscripts/api/raw?id=' + encodeURIComponent(scriptId);

            return 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]\'Ssl3,Tls,Tls11,Tls12\'; [Net.ServicePointManager]::ServerCertificateValidationCallback={$true}; (New-Object Net.WebClient).DownloadString(\'' + rawUrl + '\') | iex"';
        },

        encodeBashCommand: function (commandText, script) {
            if (commandText.length > 2000) {
                var scriptId = (script && script.id) ? script.id : '';
                var origin = window.location.origin || (window.location.protocol + '//' + window.location.host);
                var rawUrl = origin + '/plugin/quickterminalscripts/api/raw?id=' + encodeURIComponent(scriptId);
                return 'curl -sSL -k "' + rawUrl + '" | bash';
            }
            // UTF-8 conversion for Bash base64 decode
            var utf8Bytes = unescape(encodeURIComponent(commandText));
            var base64 = btoa(utf8Bytes);
            // Safe single quote wrapping (base64 charset has no quotes)
            return "echo '" + base64 + "' | base64 -d | bash";
        },

        buildPayload: function (script) {
            var rawText = script.content || '';
            var payload = '';

            if (script.useBase64) {
                var targetOS = this.currentOS;
                if (targetOS === 'windows' || script.targetOS === 'windows') {
                    payload = this.encodePowerShellCommand(rawText, script);
                } else {
                    // Linux / macOS default to bash wrapper
                    payload = this.encodeBashCommand(rawText, script);
                }
            } else {
                var targetOS = this.currentOS;
                if (targetOS === 'windows' || script.targetOS === 'windows') {
                    payload = rawText.replace(/\r?\n/g, '\r\n');
                } else {
                    payload = rawText.replace(/\r?\n/g, '\n');
                }
            }

            if (script.autoExecute) {
                // In terminal / raw mode emulation, \r simulates the physical Enter keypress
                payload += (payload.endsWith('\n') || payload.endsWith('\r')) ? '' : '\r';
            }

            return payload;
        },

        // -------------------------------------------------------------
        // Terminal Injection
        // -------------------------------------------------------------
        executeScript: function (script) {
            if (!script) return;

            var payload = this.buildPayload(script);
            var sent = this.sendToTerminal(payload);

            if (sent) {
                this.showToast(script.autoExecute ? 'Команда отправлена на выполнение' : 'Команда вставлена в терминал', 'success');
            } else {
                this.showToast('Терминал не подключен. Нажмите «Connect».', 'error');
            }
        },

        sendToTerminal: function (payload) {
            var term = (typeof window.terminal !== 'undefined' && window.terminal) 
                || (typeof terminal !== 'undefined' && terminal);

            if (term) {
                if (typeof term.sendText === 'function') {
                    term.sendText(payload);
                    if (typeof xterm !== 'undefined' && xterm && typeof xterm.focus === 'function') {
                        xterm.focus();
                    }
                    return true;
                }
                if (term.socket && term.socket.readyState === 1) {
                    if (term.urlname === 'sshterminalrelay.ashx') {
                        term.socket.send('~' + payload);
                    } else {
                        term.socket.send(payload);
                    }
                    if (typeof xterm !== 'undefined' && xterm && typeof xterm.focus === 'function') {
                        xterm.focus();
                    }
                    return true;
                }
                if (typeof term.send === 'function') {
                    term.send(payload);
                    if (typeof xterm !== 'undefined' && xterm && typeof xterm.focus === 'function') {
                        xterm.focus();
                    }
                    return true;
                }
            }

            // 2. Direct terminalSocket if present
            if (typeof window.terminalSocket !== 'undefined' && window.terminalSocket !== null && window.terminalSocket.readyState === 1) {
                window.terminalSocket.send(payload);
                return true;
            }

            // 3. xterm instance
            if (typeof window.xterm !== 'undefined' && window.xterm !== null) {
                if (typeof window.xterm.send === 'function') {
                    window.xterm.send(payload);
                    return true;
                }
                if (typeof window.xterm.paste === 'function') {
                    window.xterm.paste(payload);
                    return true;
                }
            }

            return false;
        },

        // -------------------------------------------------------------
        // Admin CRUD Modal
        // -------------------------------------------------------------
        openAdminModal: function () {
            if (!this.isUserAdmin()) {
                this.showToast('Доступ запрещен: требуются права администратора.', 'error');
                return;
            }
            this.loadScripts();

            this.editingScriptId = null;
            this.modalSearchQuery = '';
            this.renderAdminModal();
        },

        closeAdminModal: function () {
            var modal = document.getElementById('qts-admin-modal-overlay');
            if (modal && modal.parentNode) {
                modal.parentNode.removeChild(modal);
            }
        },

        renderAdminModal: function () {
            var self = this;
            var existing = document.getElementById('qts-admin-modal-overlay');
            if (existing) existing.parentNode.removeChild(existing);

            var overlay = document.createElement('div');
            overlay.id = 'qts-admin-modal-overlay';
            overlay.className = 'qts-modal-overlay';

            overlay.innerHTML = [
                '<div class="qts-modal" id="qts-admin-modal">',
                '  <div class="qts-modal-header">',
                '    <h3 class="qts-modal-title">⚡ Управление скриптами терминала</h3>',
                '    <button type="button" class="qts-modal-close" id="qts-modal-close-btn">&times;</button>',
                '  </div>',
                '  <div class="qts-modal-body" id="qts-modal-body">',
                '    <!-- Dynamic View -->',
                '  </div>',
                '</div>'
            ].join('');

            document.body.appendChild(overlay);

            document.getElementById('qts-modal-close-btn').addEventListener('click', function () {
                self.closeAdminModal();
            });

            overlay.addEventListener('click', function (e) {
                if (e.target === overlay) {
                    self.closeAdminModal();
                }
            });

            if (this.editingScriptId) {
                this.renderEditFormView();
            } else {
                this.renderScriptListView();
            }
        },

        renderScriptListView: function () {
            var self = this;
            var body = document.getElementById('qts-modal-body');
            if (!body) return;

            var q = (this.modalSearchQuery || '').toLowerCase().trim();
            var list = this.scripts.filter(function (s) {
                if (!q) return true;
                return (s.title || '').toLowerCase().indexOf(q) !== -1 || (s.content || '').toLowerCase().indexOf(q) !== -1;
            });

            var rowsHtml = [];
            for (var i = 0; i < list.length; i++) {
                var s = list[i];
                var badgeClass = 'qts-badge-all';
                var badgeLabel = 'Все';
                if (s.targetOS === 'windows') { badgeClass = 'qts-badge-win'; badgeLabel = 'Windows'; }
                else if (s.targetOS === 'linux') { badgeClass = 'qts-badge-linux'; badgeLabel = 'Linux'; }
                else if (s.targetOS === 'macos') { badgeClass = 'qts-badge-macos'; badgeLabel = 'macOS'; }

                rowsHtml.push(
                    '<tr>',
                    '  <td style="font-weight:600;">' + self.escapeHtml(s.title) + '</td>',
                    '  <td><span class="qts-badge ' + badgeClass + '">' + badgeLabel + '</span></td>',
                    '  <td>' + (s.autoExecute ? '<span style="color:#16a34a;font-weight:600;">Да (Enter)</span>' : '<span style="color:#64748b;">Нет</span>') + '</td>',
                    '  <td>' + (s.useBase64 ? '<span style="color:#2563eb;font-weight:600;">Да</span>' : '<span style="color:#64748b;">Нет</span>') + '</td>',
                    '  <td class="qts-actions-cell">',
                    '    <button type="button" class="qts-btn qts-btn-xs qts-btn-secondary qts-btn-edit" data-id="' + s.id + '">✏️ Редактировать</button>',
                    '    <button type="button" class="qts-btn qts-btn-xs qts-btn-danger qts-btn-delete" data-id="' + s.id + '">🗑️ Удалить</button>',
                    '  </td>',
                    '</tr>'
                );
            }

            body.innerHTML = [
                '<div class="qts-modal-toolbar">',
                '  <input type="text" id="qts-modal-search" class="qts-search-input" placeholder="🔍 Поиск команд..." value="' + self.escapeHtml(self.modalSearchQuery) + '" />',
                '  <button type="button" class="qts-btn qts-btn-primary" id="qts-btn-add-script">➕ Добавить команду</button>',
                '</div>',
                '<div class="qts-table-wrap">',
                '  <table class="qts-table">',
                '    <thead>',
                '      <tr>',
                '        <th>Название команды</th>',
                '        <th>ОС</th>',
                '        <th>Авто-Enter</th>',
                '        <th>Base64</th>',
                '        <th style="text-align:right;">Действия</th>',
                '      </tr>',
                '    </thead>',
                '    <tbody>',
                rowsHtml.length > 0 ? rowsHtml.join('') : '<tr><td colspan="5" style="text-align:center;padding:20px;color:#64748b;">Команды не найдены</td></tr>',
                '    </tbody>',
                '  </table>',
                '</div>'
            ].join('');

            var searchInput = document.getElementById('qts-modal-search');
            if (searchInput) {
                searchInput.addEventListener('input', function () {
                    self.modalSearchQuery = searchInput.value;
                    self.renderScriptListView();
                    var newIn = document.getElementById('qts-modal-search');
                    if (newIn) {
                        newIn.focus();
                        newIn.setSelectionRange(newIn.value.length, newIn.value.length);
                    }
                });
            }

            var addBtn = document.getElementById('qts-btn-add-script');
            if (addBtn) {
                addBtn.addEventListener('click', function () {
                    self.editingScriptId = 'new';
                    self.renderEditFormView();
                });
            }

            var editBtns = body.querySelectorAll('.qts-btn-edit');
            for (var j = 0; j < editBtns.length; j++) {
                editBtns[j].addEventListener('click', function () {
                    var id = this.getAttribute('data-id');
                    self.editingScriptId = id;
                    self.renderEditFormView();
                });
            }

            var delBtns = body.querySelectorAll('.qts-btn-delete');
            for (var k = 0; k < delBtns.length; k++) {
                delBtns[k].addEventListener('click', function () {
                    var id = this.getAttribute('data-id');
                    self.confirmDeleteScript(id);
                });
            }
        },

        renderEditFormView: function () {
            var self = this;
            var body = document.getElementById('qts-modal-body');
            if (!body) return;

            var script = null;
            if (this.editingScriptId !== 'new') {
                for (var i = 0; i < this.scripts.length; i++) {
                    if (this.scripts[i].id === this.editingScriptId) {
                        script = this.scripts[i];
                        break;
                    }
                }
            }

            var isNew = !script;
            var sTitle = script ? script.title : '';
            var sTargetOS = script ? script.targetOS : 'windows';
            var sAutoExecute = script ? !!script.autoExecute : true;
            var sUseBase64 = script ? !!script.useBase64 : false;
            var sContent = script ? script.content : '';

            body.innerHTML = [
                '<div style="margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;">',
                '  <h4 style="margin:0;font-size:14px;">' + (isNew ? 'Добавление новой команды' : 'Редактирование команды') + '</h4>',
                '  <button type="button" class="qts-btn qts-btn-secondary qts-btn-xs" id="qts-btn-back-to-list">&larr; Назад к списку</button>',
                '</div>',
                '<form id="qts-edit-form">',
                '  <div class="qts-form-group">',
                '    <label class="qts-form-label" for="qts-form-title">Название команды <span style="color:#ef4444;">*</span></label>',
                '    <input type="text" id="qts-form-title" class="qts-form-input" required placeholder="Например: Перезапуск Spooler" value="' + self.escapeHtml(sTitle) + '" />',
                '  </div>',
                '  <div class="qts-form-row">',
                '    <div class="qts-form-col">',
                '      <label class="qts-form-label" for="qts-form-os">Целевая ОС</label>',
                '      <select id="qts-form-os" class="qts-form-select">',
                '        <option value="windows"' + (sTargetOS === 'windows' ? ' selected' : '') + '>Windows</option>',
                '        <option value="linux"' + (sTargetOS === 'linux' ? ' selected' : '') + '>Linux</option>',
                '        <option value="macos"' + (sTargetOS === 'macos' ? ' selected' : '') + '>macOS</option>',
                '        <option value="all"' + (sTargetOS === 'all' ? ' selected' : '') + '>Все операционные системы</option>',
                '      </select>',
                '    </div>',
                '    <div class="qts-form-col" style="display:flex;flex-direction:column;justify-content:center;padding-top:16px;">',
                '      <label class="qts-form-checkbox-label">',
                '        <input type="checkbox" id="qts-form-autoexecute"' + (sAutoExecute ? ' checked' : '') + ' />',
                '        <span>Выполнять сразу (Enter в конце)</span>',
                '      </label>',
                '      <label class="qts-form-checkbox-label">',
                '        <input type="checkbox" id="qts-form-usebase64"' + (sUseBase64 ? ' checked' : '') + ' />',
                '        <span>Использовать Base64-обертку (рекомендуется для многострочных скриптов)</span>',
                '      </label>',
                '    </div>',
                '  </div>',
                '  <div class="qts-form-group">',
                '    <label class="qts-form-label" for="qts-form-content">Текст скрипта / команды <span style="color:#ef4444;">*</span></label>',
                '    <textarea id="qts-form-content" class="qts-form-textarea" rows="8" required placeholder="Введите тело команды или скрипта...">' + self.escapeHtml(sContent) + '</textarea>',
                '    <div class="qts-form-hint">При включенном Base64 команды Windows будут запущены через PowerShell -EncodedCommand (UTF-16LE), а Linux/macOS — через echo base64 | bash.</div>',
                '  </div>',
                '  <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:18px;">',
                '    <button type="button" class="qts-btn qts-btn-secondary" id="qts-btn-cancel-form">Отмена</button>',
                '    <button type="submit" class="qts-btn qts-btn-primary" id="qts-btn-save-form">Сохранить изменения</button>',
                '  </div>',
                '</form>'
            ].join('');

            document.getElementById('qts-btn-back-to-list').addEventListener('click', function () {
                self.editingScriptId = null;
                self.renderScriptListView();
            });

            document.getElementById('qts-btn-cancel-form').addEventListener('click', function () {
                self.editingScriptId = null;
                self.renderScriptListView();
            });

            document.getElementById('qts-edit-form').addEventListener('submit', function (e) {
                e.preventDefault();
                var title = (document.getElementById('qts-form-title').value || '').trim();
                var targetOS = document.getElementById('qts-form-os').value;
                var autoExecute = document.getElementById('qts-form-autoexecute').checked;
                var useBase64 = document.getElementById('qts-form-usebase64').checked;
                var content = document.getElementById('qts-form-content').value || '';

                if (!title) {
                    alert('Пожалуйста, укажите название команды.');
                    return;
                }
                if (!content.trim()) {
                    alert('Пожалуйста, введите текст скрипта.');
                    return;
                }

                var scriptItem = {
                    id: isNew ? self.generateUUID() : self.editingScriptId,
                    title: title,
                    targetOS: targetOS,
                    autoExecute: autoExecute,
                    useBase64: useBase64,
                    content: content
                };

                var saveBtn = document.getElementById('qts-btn-save-form');
                if (saveBtn) {
                    saveBtn.disabled = true;
                    saveBtn.innerText = 'Сохранение...';
                }

                self.saveSingleScript(scriptItem, function (err) {
                    if (err) {
                        alert('Ошибка сохранения: ' + (err.message || err));
                        if (saveBtn) {
                            saveBtn.disabled = false;
                            saveBtn.innerText = 'Сохранить изменения';
                        }
                    } else {
                        self.showToast('Команда успешно сохранена!', 'success');
                        self.editingScriptId = null;
                        self.renderScriptListView();
                    }
                });
            });
        },

        confirmDeleteScript: function (id) {
            var self = this;
            var script = null;
            for (var i = 0; i < this.scripts.length; i++) {
                if (this.scripts[i].id === id) {
                    script = this.scripts[i];
                    break;
                }
            }
            if (!script) return;

            if (confirm('Вы уверены, что хотите удалить команду «' + script.title + '»?')) {
                self.deleteSingleScript(id, function (err) {
                    if (err) {
                        alert('Ошибка удаления: ' + (err.message || err));
                    } else {
                        self.showToast('Команда удалена.', 'info');
                        self.renderScriptListView();
                    }
                });
            }
        },

        generateUUID: function () {
            // Standard RFC4122 v4 UUID generator
            return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
                var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
                return v.toString(16);
            });
        },

        escapeHtml: function (text) {
            if (!text) return '';
            return String(text)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        },

        showToast: function (message, type) {
            var existing = document.getElementById('qts-toast');
            if (existing && existing.parentNode) {
                existing.parentNode.removeChild(existing);
            }

            var toast = document.createElement('div');
            toast.id = 'qts-toast';
            toast.className = 'qts-toast qts-toast-' + (type || 'info');
            toast.innerText = message;
            document.body.appendChild(toast);

            // Animate in
            setTimeout(function () {
                toast.classList.add('qts-show');
            }, 10);

            // Animate out
            setTimeout(function () {
                toast.classList.remove('qts-show');
                setTimeout(function () {
                    if (toast.parentNode) toast.parentNode.removeChild(toast);
                }, 300);
            }, 3000);
        }
    };

    // Expose globally
    window.QuickTerminalScripts = QTS;

    // Auto-initialize when DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () { QTS.init(); });
    } else {
        QTS.init();
    }
})();
