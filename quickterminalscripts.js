/**
 * QuickTerminalScripts Plugin for MeshCentral
 * Server-Side Module (Node.js backend)
 * 
 * Manages plugin lifecycle, static assets, HTTP REST API,
 * WebSocket messages, and atomic persistence of scripts.
 */

var path = require('path');
var fs = require('fs');

var quickterminalscriptsPlugin = function (parent) {
    var obj = {};
    obj.parent = parent;
    obj.meshServer = (parent && parent.parent) || parent.meshServer || parent;

    // Resolve data storage paths
    var dataPath = (obj.meshServer && obj.meshServer.datapath) 
        || (obj.parent && obj.parent.datapath) 
        || path.join(__dirname, '../../meshcentral-data');

    var dataFilePath = path.join(dataPath, 'quickterminalscripts.json');
    var backupFilePath = path.join(dataPath, 'quickterminalscripts.json.bak');
    var defaultFilePath = path.join(__dirname, 'scripts.default.json');
    var publicDir = path.join(__dirname, 'public');

    // Ensure data storage file exists
    function initializeStorage() {
        try {
            if (!fs.existsSync(dataPath)) {
                fs.mkdirSync(dataPath, { recursive: true });
            }
            if (!fs.existsSync(dataFilePath)) {
                if (fs.existsSync(defaultFilePath)) {
                    fs.copyFileSync(defaultFilePath, dataFilePath);
                    console.log('[QuickTerminalScripts] Initialized data file with defaults.');
                } else {
                    fs.writeFileSync(dataFilePath, '[]', 'utf8');
                    console.log('[QuickTerminalScripts] Created empty data file.');
                }
            }
        } catch (e) {
            console.error('[QuickTerminalScripts] Storage initialization error:', e.message);
        }
    }

    initializeStorage();

    // -----------------------------------------------------------------
    // Data Access Helpers
    // -----------------------------------------------------------------
    function readScripts() {
        try {
            if (!fs.existsSync(dataFilePath)) {
                initializeStorage();
            }
            var raw = fs.readFileSync(dataFilePath, 'utf8');
            var parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) return parsed;
            return [];
        } catch (e) {
            console.error('[QuickTerminalScripts] Error reading scripts:', e.message);
            try {
                if (fs.existsSync(backupFilePath)) {
                    var bakRaw = fs.readFileSync(backupFilePath, 'utf8');
                    var bakParsed = JSON.parse(bakRaw);
                    if (Array.isArray(bakParsed)) {
                        console.log('[QuickTerminalScripts] Recovered scripts from backup file.');
                        return bakParsed;
                    }
                }
            } catch (bakErr) {}
            return [];
        }
    }

    function saveScripts(scriptsArray) {
        if (!Array.isArray(scriptsArray)) {
            throw new Error('Invalid input: scripts must be an array');
        }

        // Validate each script object
        for (var i = 0; i < scriptsArray.length; i++) {
            var item = scriptsArray[i];
            if (!item || typeof item !== 'object') {
                throw new Error('Invalid script format at index ' + i);
            }
            if (typeof item.title !== 'string' || !item.title.trim()) {
                throw new Error('Script title is required at index ' + i);
            }
            if (typeof item.content !== 'string') {
                throw new Error('Script content must be a string at index ' + i);
            }
            // Normalize fields
            item.id = String(item.id || ('qts-' + Date.now() + '-' + Math.random().toString(36).substring(2, 9)));
            item.title = item.title.trim();
            item.targetOS = (['windows', 'linux', 'macos', 'all'].indexOf(item.targetOS) !== -1) ? item.targetOS : 'all';
            item.autoExecute = !!item.autoExecute;
            item.useBase64 = !!item.useBase64;
        }

        var jsonString = JSON.stringify(scriptsArray, null, 2);

        // Test validity with JSON.parse before writing
        JSON.parse(jsonString);

        // 1. Create backup if current file exists
        try {
            if (fs.existsSync(dataFilePath)) {
                fs.copyFileSync(dataFilePath, backupFilePath);
            }
        } catch (bakEx) {
            console.warn('[QuickTerminalScripts] Warning: Could not create backup before save:', bakEx.message);
        }

        // 2. Write atomically using a temporary file
        var tempFilePath = dataFilePath + '.tmp';
        fs.writeFileSync(tempFilePath, jsonString, 'utf8');
        fs.renameSync(tempFilePath, dataFilePath);

        return scriptsArray;
    }

    // -----------------------------------------------------------------
    // Authentication & Authorization Helpers
    // -----------------------------------------------------------------
    function isUserAdmin(user) {
        if (!user) return false;
        if (user.siteadmin === 0xFFFFFFFF || user.siteadmin === -1) return true;
        if (typeof user.siteadmin === 'number' && (user.siteadmin & 1) !== 0) return true;
        if (user.siteadmin === true || user.siteadmin === 1) return true;
        return false;
    }

    function getUserFromReq(req) {
        var server = obj.meshServer || (obj.parent && obj.parent.parent) || obj.parent;
        if (!server) return null;

        if (req.session && req.session.userid) {
            if (server.users && server.users[req.session.userid]) {
                return server.users[req.session.userid];
            }
            if (server.webserver && server.webserver.users && server.webserver.users[req.session.userid]) {
                return server.webserver.users[req.session.userid];
            }
        }

        try {
            var cookieHeader = req.headers.cookie;
            if (cookieHeader) {
                var cookies = {};
                var pairs = cookieHeader.split(';');
                for (var i = 0; i < pairs.length; i++) {
                    var parts = pairs[i].split('=');
                    if (parts.length >= 2) {
                        cookies[parts[0].trim()] = decodeURIComponent(parts[1].trim());
                    }
                }

                if (cookies.xid && typeof server.decodeCookie === 'function') {
                    var decoded = server.decodeCookie(cookies.xid, server.loginCookieEncryptionKey);
                    if (decoded && decoded.userid) {
                        if (server.users && server.users[decoded.userid]) return server.users[decoded.userid];
                        if (server.webserver && server.webserver.users && server.webserver.users[decoded.userid]) {
                            return server.webserver.users[decoded.userid];
                        }
                    }
                }
            }
        } catch (e) {}

        return null;
    }

    // -----------------------------------------------------------------
    // HTTP Routes & Static Assets
    // -----------------------------------------------------------------
    function registerRoutes(app) {
        if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') return false;
        if (app._quickterminalscripts_registered) return true;
        app._quickterminalscripts_registered = true;

        console.log('[QuickTerminalScripts] Registering HTTP routes and assets...');

        var jsFilePath = path.join(publicDir, 'terminalscripts.js');
        var cssFilePath = path.join(publicDir, 'terminalscripts.css');

        var serveJS = function (req, res) {
            res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache');
            if (fs.existsSync(jsFilePath)) {
                fs.createReadStream(jsFilePath).pipe(res);
            } else {
                res.status(404).send('// QuickTerminalScripts: JS file not found');
            }
        };

        var serveCSS = function (req, res) {
            res.setHeader('Content-Type', 'text/css; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache');
            if (fs.existsSync(cssFilePath)) {
                fs.createReadStream(cssFilePath).pipe(res);
            } else {
                res.status(404).send('/* QuickTerminalScripts: CSS file not found */');
            }
        };

        app.get('/plugin/quickterminalscripts/terminalscripts.js', serveJS);
        app.get('/plugin/quickterminalscripts/public/terminalscripts.js', serveJS);
        app.get('/plugin/quickterminalscripts/terminalscripts.css', serveCSS);
        app.get('/plugin/quickterminalscripts/public/terminalscripts.css', serveCSS);

        // API: Get Scripts
        app.get('/plugin/quickterminalscripts/api/scripts', function (req, res) {
            var user = getUserFromReq(req);
            if (!user && (!req.session || !req.session.userid)) {
                return res.status(401).json({ error: 'Unauthorized' });
            }

            try {
                var scripts = readScripts();
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                res.setHeader('Pragma', 'no-cache');
                res.setHeader('Expires', '0');
                res.status(200).json(scripts);
            } catch (e) {
                res.status(500).json({ error: 'Failed to read scripts: ' + e.message });
            }
        });

        // API: Save Scripts (Admin only)
        app.post('/plugin/quickterminalscripts/api/scripts', function (req, res) {
            var user = getUserFromReq(req);
            if (!user || !isUserAdmin(user)) {
                return res.status(403).json({ error: 'Access denied: Administrator permissions required' });
            }

            var body = req.body;
            if (typeof body === 'string') {
                try { body = JSON.parse(body); } catch (e) {
                    return res.status(400).json({ error: 'Invalid JSON body' });
                }
            }

            if (!Array.isArray(body)) {
                if (body && Array.isArray(body.scripts)) {
                    body = body.scripts;
                } else {
                    return res.status(400).json({ error: 'Request body must be an array of scripts' });
                }
            }

            try {
                var saved = saveScripts(body);
                // Broadcast updated scripts to all active user sessions
                broadcastToAllUsers({
                    action: 'plugin',
                    plugin: 'quickterminalscripts',
                    method: 'onScriptsLoaded',
                    scripts: saved
                });
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.status(200).json({ success: true, count: saved.length });
            } catch (e) {
                res.status(500).json({ error: 'Save failed: ' + e.message });
            }
        });

        return true;
    }

    function getExpressApp() {
        var server = obj.meshServer || (obj.parent && obj.parent.parent) || (obj.parent && obj.parent.meshServer) || obj.parent;
        if (!server) return null;
        return server.app || (server.webserver && server.webserver.app) || null;
    }

    function tryRegisterRoutes(retriesLeft) {
        try {
            if (registerRoutes(getExpressApp())) return;
        } catch (e) {}

        if (retriesLeft > 0) {
            setTimeout(function () { tryRegisterRoutes(retriesLeft - 1); }, 1000);
        }
    }

    // -----------------------------------------------------------------
    // MeshCentral Server Lifecycle Hooks
    // -----------------------------------------------------------------
    obj.server_startup = function () {
        console.log('[QuickTerminalScripts] Plugin loaded.');
        tryRegisterRoutes(30);
    };

    obj.hook_setupHttpHandlers = function (webserver) {
        registerRoutes(webserver && (webserver.app || webserver));
    };

    // Pre-template HTML injection hook
    obj.hook_processTemplateHttpPre = function (template, req) {
        try {
            if (typeof template === 'string') {
                var scriptTags = [
                    '<link rel="stylesheet" type="text/css" href="/plugin/quickterminalscripts/terminalscripts.css">',
                    '<script type="text/javascript" src="/plugin/quickterminalscripts/terminalscripts.js"></script>'
                ].join('\n');

                if (template.indexOf('</head>') !== -1) {
                    return template.replace('</head>', scriptTags + '\n</head>');
                } else if (template.indexOf('</body>') !== -1) {
                    return template.replace('</body>', scriptTags + '\n</body>');
                }
            }
        } catch (e) {}
        return template;
    };

    function sendToUser(myUser, dataObj) {
        if (!myUser) return;
        try {
            if (typeof myUser.send === 'function') {
                myUser.send(dataObj);
            } else if (myUser.ws && typeof myUser.ws.send === 'function') {
                myUser.ws.send(JSON.stringify(dataObj));
            }
        } catch (e) {
            console.error('[QuickTerminalScripts] sendToUser error:', e.message);
        }
    }

    function broadcastToAllUsers(dataObj) {
        try {
            var serverCore = obj.meshServer || (obj.parent && obj.parent.parent) || obj.parent;
            if (!serverCore) return;

            var payload = (typeof dataObj === 'string') ? dataObj : JSON.stringify(dataObj);

            // 1. Broadcast to wssessions2 (standard MeshCentral session mapping)
            var wss2 = (serverCore.webserver && serverCore.webserver.wssessions2) || null;
            if (wss2) {
                for (var sid in wss2) {
                    try {
                        var s = wss2[sid];
                        if (!s) continue;
                        if (typeof s.send === 'function') {
                            s.send(payload);
                        } else if (s.ws && typeof s.ws.send === 'function') {
                            s.ws.send(payload);
                        }
                    } catch (e) {}
                }
            }

            // 2. Broadcast to wssessions (array or map in some MeshCentral versions)
            var wss = (serverCore.webserver && serverCore.webserver.wssessions) || null;
            if (wss) {
                if (Array.isArray(wss)) {
                    for (var i = 0; i < wss.length; i++) {
                        try {
                            if (wss[i] && typeof wss[i].send === 'function') {
                                wss[i].send(payload);
                            }
                        } catch (e) {}
                    }
                } else if (typeof wss === 'object') {
                    for (var k in wss) {
                        try {
                            if (wss[k] && typeof wss[k].send === 'function') {
                                wss[k].send(payload);
                            }
                        } catch (e) {}
                    }
                }
            }
        } catch (ex) {
            console.warn('[QuickTerminalScripts] Broadcast error:', ex.message);
        }
    }

    // -----------------------------------------------------------------
    // WebSocket Plugin Message Handler
    // -----------------------------------------------------------------
    obj.serveraction = function (command, myUser, parent) {
        if (!command || !myUser) return;

        var action = command.pluginaction || command.method || command.action;
        var user = myUser.user;

        switch (action) {
            case 'getDiagnosticInfo': {
                try {
                    var files = [];
                    try { files = fs.readdirSync(dataPath); } catch (e) {}
                    var bakContent = null;
                    try {
                        if (fs.existsSync(backupFilePath)) {
                            bakContent = JSON.parse(fs.readFileSync(backupFilePath, 'utf8'));
                        }
                    } catch (e) { bakContent = 'error: ' + e.message; }
                    sendToUser(myUser, {
                        action: 'plugin',
                        plugin: 'quickterminalscripts',
                        method: 'onDiagnosticInfo',
                        dataPath: dataPath,
                        files: files,
                        backupContent: bakContent
                    });
                } catch (e) {
                    sendToUser(myUser, { action: 'plugin', plugin: 'quickterminalscripts', method: 'onDiagnosticInfo', error: e.message });
                }
                break;
            }

            case 'getScripts': {
                try {
                    var scripts = readScripts();
                    sendToUser(myUser, {
                        action: 'plugin',
                        plugin: 'quickterminalscripts',
                        method: 'onScriptsLoaded',
                        scripts: scripts
                    });
                } catch (e) {
                    sendToUser(myUser, {
                        action: 'plugin',
                        plugin: 'quickterminalscripts',
                        method: 'onSaveError',
                        error: 'Failed to read scripts: ' + e.message
                    });
                }
                break;
            }

            case 'saveScripts': {
                if (!isUserAdmin(user)) {
                    sendToUser(myUser, {
                        action: 'plugin',
                        plugin: 'quickterminalscripts',
                        method: 'onSaveError',
                        error: 'Access denied: Administrator permissions required',
                        status: 403
                    });
                    return;
                }

                try {
                    var toSave = command.scripts;
                    var result = saveScripts(toSave);
                    // Broadcast fresh scripts to all connected users
                    broadcastToAllUsers({
                        action: 'plugin',
                        plugin: 'quickterminalscripts',
                        method: 'onScriptsLoaded',
                        scripts: result
                    });
                    sendToUser(myUser, {
                        action: 'plugin',
                        plugin: 'quickterminalscripts',
                        method: 'onScriptsSaved',
                        scripts: result,
                        success: true
                    });
                } catch (e) {
                    sendToUser(myUser, {
                        action: 'plugin',
                        plugin: 'quickterminalscripts',
                        method: 'onSaveError',
                        error: 'Failed to save scripts: ' + e.message
                    });
                }
                break;
            }

            default:
                break;
        }
    };

    obj.handleServerMessage = obj.serveraction;

    // -----------------------------------------------------------------
    // Exported Web UI Hooks (MeshCentral front-end bundle)
    // -----------------------------------------------------------------
    obj.exports = [
        'onWebUIStartupEnd',
        'onDeviceRefreshEnd',
        'onScriptsLoaded',
        'onScriptsSaved',
        'onSaveError'
    ];

    // Client-side WebUI startup hook: serialised directly by MeshCentral into page
    obj.onWebUIStartupEnd = function () {
        if (window._quickTerminalScriptsLoaded) return;
        window._quickTerminalScriptsLoaded = true;

        // 1. Inject Stylesheet
        if (!document.getElementById('qts-styles')) {
            var css = document.createElement('style');
            css.id = 'qts-styles';
            css.innerHTML = `
                .qts-container { display: inline-flex; align-items: center; gap: 6px; margin: 0 6px; vertical-align: middle; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; font-size: 13px; position: relative; z-index: 100; }
                .qts-combobox { position: relative; display: inline-block; width: 280px; }
                .qts-input-wrap { position: relative; display: flex; align-items: center; background: #ffffff; border: 1px solid #94a3b8; border-radius: 4px; padding: 0 6px; transition: all 0.15s ease-in-out; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05); }
                .qts-input-wrap:focus-within { border-color: #2563eb; box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.2); }
                .qts-icon-search { color: #64748b; font-size: 13px; margin-right: 5px; user-select: none; }
                .qts-input { border: none; outline: none; width: 100%; height: 26px; font-size: 12px; color: #1e293b; background: transparent; padding: 0; }
                .qts-input::placeholder { color: #94a3b8; }
                .qts-btn-clear { background: none; border: none; color: #94a3b8; cursor: pointer; font-size: 14px; padding: 0 2px; line-height: 1; display: none; }
                .qts-btn-clear:hover { color: #ef4444; }
                .qts-btn-toggle { background: none; border: none; color: #64748b; cursor: pointer; font-size: 10px; padding: 0 2px; line-height: 1; }
                .qts-dropdown-list { position: absolute; top: calc(100% + 4px); left: 0; width: 360px; max-height: 320px; overflow-y: auto; background: #ffffff; border: 1px solid #cbd5e1; border-radius: 6px; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.2), 0 8px 10px -6px rgba(0, 0, 0, 0.1); list-style: none; margin: 0; padding: 4px 0; z-index: 10000; }
                .qts-dropdown-empty { padding: 12px; text-align: center; color: #64748b; font-size: 12px; }
                .qts-dropdown-item { display: flex; align-items: center; justify-content: space-between; padding: 7px 10px; cursor: pointer; transition: background-color 0.1s ease; border-bottom: 1px solid #f1f5f9; }
                .qts-dropdown-item:last-child { border-bottom: none; }
                .qts-dropdown-item:hover, .qts-dropdown-item.qts-item-active { background-color: #eff6ff; }
                .qts-item-left { display: flex; align-items: center; gap: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
                .qts-item-title { font-size: 12px; font-weight: 500; color: #1e293b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .qts-item-right { display: flex; align-items: center; gap: 4px; margin-left: 8px; flex-shrink: 0; }
                .qts-badge { display: inline-block; padding: 2px 6px; font-size: 10px; font-weight: 600; text-transform: uppercase; border-radius: 3px; line-height: 1.2; }
                .qts-badge-win { background: #e0f2fe; color: #0369a1; border: 1px solid #bae6fd; }
                .qts-badge-linux { background: #fef3c7; color: #b45309; border: 1px solid #fde68a; }
                .qts-badge-macos { background: #f3e8ff; color: #7e22ce; border: 1px solid #e9d5ff; }
                .qts-badge-all { background: #dcfce7; color: #15803d; border: 1px solid #bbf7d0; }
                .qts-badge-flag { background: #f1f5f9; color: #475569; border: 1px solid #e2e8f0; font-size: 9px; }
                .qts-btn { display: inline-flex; align-items: center; justify-content: center; height: 28px; padding: 0 12px; font-size: 12px; font-weight: 600; border-radius: 4px; border: 1px solid transparent; cursor: pointer; user-select: none; transition: all 0.15s ease-in-out; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08); }
                .qts-btn:disabled { opacity: 0.5; cursor: not-allowed; box-shadow: none; }
                .qts-btn-run { background-color: #16a34a; border-color: #15803d; color: #ffffff; }
                .qts-btn-run:hover:not(:disabled) { background-color: #15803d; }
                .qts-btn-paste { background-color: #2563eb; border-color: #1d4ed8; color: #ffffff; }
                .qts-btn-paste:hover:not(:disabled) { background-color: #1d4ed8; }
                .qts-btn-settings { background-color: #f8fafc; border: 1px solid #cbd5e1; color: #475569; padding: 0 8px; font-size: 14px; }
                .qts-btn-settings:hover { background-color: #e2e8f0; color: #0f172a; }
                .qts-toast { position: fixed; bottom: 24px; right: 24px; padding: 10px 16px; border-radius: 6px; font-size: 13px; font-weight: 500; color: #ffffff; box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.2); z-index: 999999; transition: all 0.25s ease-in-out; opacity: 0; transform: translateY(10px); }
                .qts-toast.qts-show { opacity: 1; transform: translateY(0); }
                .qts-toast-success { background-color: #16a34a; }
                .qts-toast-error { background-color: #dc2626; }
                .qts-toast-info { background-color: #0284c7; }
                .qts-dropdown-footer { border-top: 1px solid #e2e8f0; padding: 6px 10px; background-color: #f8fafc; text-align: right; list-style: none; }
                .qts-btn-dropdown-admin { background: transparent; border: none; color: #2563eb; font-size: 11px; font-weight: 600; cursor: pointer; padding: 2px 4px; line-height: 1.4; }
                .qts-btn-dropdown-admin:hover { text-decoration: underline; color: #1d4ed8; }
                .qts-modal-overlay { position: fixed; top: 0; left: 0; right: 0; bottom: 0; background-color: rgba(15, 23, 42, 0.65); backdrop-filter: blur(2px); display: flex; align-items: center; justify-content: center; z-index: 100000; padding: 16px; }
                .qts-modal { background: #ffffff; border-radius: 8px; width: 100%; max-width: 780px; max-height: 90vh; display: flex; flex-direction: column; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.25), 0 10px 10px -5px rgba(0, 0, 0, 0.1); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1e293b; overflow: hidden; }
                .qts-modal-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 20px; background-color: #0f172a; color: #f8fafc; border-bottom: 1px solid #334155; }
                .qts-modal-title { font-size: 16px; font-weight: 600; display: flex; align-items: center; gap: 8px; margin: 0; }
                .qts-modal-close { background: transparent; border: none; color: #94a3b8; font-size: 20px; cursor: pointer; line-height: 1; padding: 0 4px; }
                .qts-modal-close:hover { color: #ffffff; }
                .qts-modal-body { padding: 18px 20px; overflow-y: auto; flex: 1; }
                .qts-modal-toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; gap: 12px; }
                .qts-search-input { flex: 1; max-width: 320px; padding: 6px 10px; font-size: 12px; border: 1px solid #cbd5e1; border-radius: 4px; outline: none; }
                .qts-table-wrap { border: 1px solid #e2e8f0; border-radius: 6px; overflow: hidden; max-height: 420px; overflow-y: auto; }
                .qts-table { width: 100%; border-collapse: collapse; font-size: 12px; text-align: left; }
                .qts-table th { background-color: #f1f5f9; color: #475569; font-weight: 600; padding: 10px 12px; border-bottom: 1px solid #e2e8f0; position: sticky; top: 0; z-index: 1; }
                .qts-table td { padding: 10px 12px; border-bottom: 1px solid #f1f5f9; vertical-align: middle; }
                .qts-table tr:hover td { background-color: #f8fafc; }
                .qts-actions-cell { white-space: nowrap; text-align: right; display: flex; justify-content: flex-end; gap: 6px; }
                .qts-btn-xs { height: 24px; padding: 0 8px; font-size: 11px; }
                .qts-btn-primary { background-color: #2563eb; color: #ffffff; border-color: #1d4ed8; }
                .qts-btn-primary:hover { background-color: #1d4ed8; }
                .qts-btn-secondary { background-color: #ffffff; color: #334155; border: 1px solid #cbd5e1; }
                .qts-btn-secondary:hover { background-color: #f1f5f9; }
                .qts-btn-danger { background-color: #ef4444; color: #ffffff; border-color: #dc2626; }
                .qts-btn-danger:hover { background-color: #dc2626; }
                .qts-form-group { margin-bottom: 14px; }
                .qts-form-label { display: block; font-size: 12px; font-weight: 600; color: #334155; margin-bottom: 5px; }
                .qts-form-input, .qts-form-select { width: 100%; box-sizing: border-box; padding: 7px 10px; font-size: 13px; border: 1px solid #cbd5e1; border-radius: 4px; outline: none; background: #ffffff; color: #1e293b; }
                .qts-form-row { display: flex; gap: 16px; margin-bottom: 14px; }
                .qts-form-col { flex: 1; }
                .qts-form-checkbox-label { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #334155; cursor: pointer; user-select: none; padding: 4px 0; }
                .qts-form-checkbox-label input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; accent-color: #2563eb; }
                .qts-form-textarea { width: 100%; box-sizing: border-box; min-height: 180px; font-family: "Cascadia Code", "Fira Code", Consolas, Menlo, Monaco, monospace; font-size: 12px; line-height: 1.5; padding: 10px; border: 1px solid #cbd5e1; border-radius: 4px; outline: none; background-color: #f8fafc; color: #0f172a; resize: vertical; white-space: pre; }
                .qts-form-hint { font-size: 11px; color: #64748b; margin-top: 4px; }
            `;
            document.head.appendChild(css);
        }

        // 2. Initialize QuickTerminalScripts Client Controller
        var QTS = {
            scripts: [],
            selectedScript: null,
            dropdownOpen: false,
            filteredScripts: [],
            highlightedIndex: -1,
            currentOS: 'all',
            editingScriptId: null,
            modalSearchQuery: '',

            init: function () {
                this.loadScripts();
                this.setupHooks();
                this.mountToolbar();

                var self = this;
                document.addEventListener('click', function (e) {
                    var container = document.getElementById('qts-toolbar-container');
                    if (container && !container.contains(e.target)) {
                        self.closeDropdown();
                    }
                });

                setInterval(function () {
                    self.checkAndMount();
                }, 1000);

                // Periodic background sync with server to pick up scripts added by other admins
                setInterval(function () {
                    self.loadScripts();
                }, 10000);
            },

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

            detectCurrentOS: function () {
                var node = (typeof window.currentNode !== 'undefined' && window.currentNode) 
                    ? window.currentNode 
                    : (typeof window.getCurrentNode === 'function' ? window.getCurrentNode() : null);

                if (!node) return 'all';

                try {
                    if (typeof window.isWindowsNode === 'function' && window.isWindowsNode(node)) return 'windows';
                    if (typeof window.isMacNode === 'function' && window.isMacNode(node)) return 'macos';
                } catch (e) {}

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

                if (node.agent && typeof node.agent.id === 'number') {
                    var aid = node.agent.id;
                    if ([1, 2, 3, 4, 10, 11, 21, 22, 34, 42, 43].indexOf(aid) !== -1) return 'windows';
                    if ([16, 29, 30].indexOf(aid) !== -1) return 'macos';
                    if ([5, 6, 7, 8, 9, 12, 13, 14, 15, 17, 18, 19, 20, 23, 24, 25, 26, 27, 28].indexOf(aid) !== -1) return 'linux';
                }

                return 'all';
            },

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
                    .then(function (res) { if (res.ok) return res.json(); })
                    .then(function (data) { if (Array.isArray(data)) self.setScripts(data); })
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
                var adminModal = document.getElementById('qts-admin-modal-overlay');
                if (adminModal && !this.editingScriptId) {
                    this.renderScriptListView();
                }
                if (this.selectedScript) {
                    var found = null;
                    for (var i = 0; i < this.scripts.length; i++) {
                        if (this.scripts[i].id === this.selectedScript.id) { found = this.scripts[i]; break; }
                    }
                    this.selectScript(found);
                }
            },

            saveScriptsToServer: function (scriptsToSave, callback) {
                var self = this;
                self.setScripts(scriptsToSave); // Instant update in memory and localStorage

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

                fetch('/plugin/quickterminalscripts/api/scripts', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'same-origin',
                    body: JSON.stringify(scriptsToSave)
                })
                .then(function (res) { if (res.ok) return res.json(); })
                .then(function (result) {
                    if (self._pendingSaveCallback) {
                        var cb = self._pendingSaveCallback;
                        delete self._pendingSaveCallback;
                        cb(null, result);
                    }
                })
                .catch(function (err) {
                    if (!sentWs && typeof callback === 'function') callback(err);
                });
            },

            setupHooks: function () {
                var self = this;
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

            mountToolbar: function () {
                if (document.getElementById('qts-toolbar-container')) {
                    this.updateAdminVisibility();
                    return;
                }

                var target = document.getElementById('terminalCustomUiButtons');
                if (!target) {
                    var connectSpan = document.getElementById('connectbutton2span');
                    if (connectSpan && connectSpan.parentNode) target = connectSpan.parentNode;
                }
                if (!target) target = document.getElementById('p12');
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

            bindToolbarEvents: function () {
                var self = this;
                var input = document.getElementById('qts-search-input');
                var clearBtn = document.getElementById('qts-btn-clear');
                var toggleBtn = document.getElementById('qts-btn-toggle');
                var actionBtn = document.getElementById('qts-btn-action');
                var settingsBtn = document.getElementById('qts-btn-settings');

                if (input) {
                    input.addEventListener('focus', function () { self.openDropdown(); });
                    input.addEventListener('input', function () {
                        var val = input.value;
                        if (clearBtn) clearBtn.style.display = val ? 'block' : 'none';
                        self.updateFilteredScripts(val);
                        self.openDropdown();
                    });
                    input.addEventListener('keydown', function (e) { self.handleInputKeydown(e); });
                }

                if (clearBtn) {
                    clearBtn.addEventListener('click', function (e) {
                        e.stopPropagation();
                        self.selectScript(null);
                        if (input) { input.value = ''; input.focus(); }
                        clearBtn.style.display = 'none';
                        self.updateFilteredScripts('');
                        self.openDropdown();
                    });
                }

                if (toggleBtn) {
                    toggleBtn.addEventListener('click', function (e) {
                        e.stopPropagation();
                        if (self.dropdownOpen) self.closeDropdown();
                        else { self.openDropdown(); if (input) input.focus(); }
                    });
                }

                if (actionBtn) {
                    actionBtn.addEventListener('click', function () {
                        if (self.selectedScript) self.executeScript(self.selectedScript);
                    });
                }

                if (settingsBtn) {
                    settingsBtn.addEventListener('click', function () { self.openAdminModal(); });
                }
            },

            updateFilteredScripts: function (query) {
                query = (query || '').toLowerCase().trim();
                var targetOS = this.currentOS;
                var showAll = this._showAllOSOverride;

                this.filteredScripts = this.scripts.filter(function (s) {
                    var matchesOS = false;
                    if (showAll || !s.targetOS || s.targetOS === 'all' || targetOS === 'all') matchesOS = true;
                    else if (targetOS === 'windows' && s.targetOS === 'windows') matchesOS = true;
                    else if (targetOS === 'linux' && s.targetOS === 'linux') matchesOS = true;
                    else if (targetOS === 'macos' && s.targetOS === 'macos') matchesOS = true;

                    if (!matchesOS) return false;
                    if (!query) return true;
                    return (s.title || '').toLowerCase().indexOf(query) !== -1 || (s.content || '').toLowerCase().indexOf(query) !== -1;
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
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { this.openDropdown(); e.preventDefault(); return; }
                    if (e.key === 'Enter' && this.selectedScript) { this.executeScript(this.selectedScript); e.preventDefault(); return; }
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
                if (active) active.scrollIntoView({ block: 'nearest' });
            },

            openDropdown: function () {
                this.loadScripts();
                var list = document.getElementById('qts-dropdown-list');
                if (list) { list.style.display = 'block'; this.dropdownOpen = true; }
            },

            closeDropdown: function () {
                var list = document.getElementById('qts-dropdown-list');
                if (list) { list.style.display = 'none'; this.dropdownOpen = false; }
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

            encodePowerShellCommand: function (commandText) {
                var byteArray = new Uint8Array(commandText.length * 2);
                for (var i = 0; i < commandText.length; i++) {
                    var code = commandText.charCodeAt(i);
                    byteArray[i * 2] = code & 0xff;
                    byteArray[i * 2 + 1] = (code >> 8) & 0xff;
                }
                var binaryString = '';
                var chunkSize = 8192;
                for (var j = 0; j < byteArray.byteLength; j += chunkSize) {
                    var chunk = byteArray.subarray(j, j + chunkSize);
                    binaryString += String.fromCharCode.apply(null, chunk);
                }
                var base64 = btoa(binaryString);

                if (base64.length > 6000) {
                    return "& ([ScriptBlock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('" + base64 + "'))))";
                }

                return 'powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ' + base64;
            },

            encodeBashCommand: function (commandText) {
                var utf8Bytes = unescape(encodeURIComponent(commandText));
                var base64 = btoa(utf8Bytes);
                return "echo '" + base64 + "' | base64 -d | bash";
            },

            buildPayload: function (script) {
                var rawText = script.content || '';
                var payload = '';

                if (script.useBase64) {
                    var targetOS = this.currentOS;
                    if (targetOS === 'windows' || script.targetOS === 'windows') {
                        payload = this.encodePowerShellCommand(rawText);
                    } else {
                        payload = this.encodeBashCommand(rawText);
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
                    payload += (payload.endsWith('\n') || payload.endsWith('\r')) ? '' : '\r';
                }

                return payload;
            },

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
                if (typeof window.terminal !== 'undefined' && window.terminal !== null) {
                    if (typeof window.terminal.sendText === 'function') {
                        window.terminal.sendText(payload);
                        return true;
                    }
                    if (window.terminal.socket && window.terminal.socket.readyState === 1) {
                        if (window.terminal.urlname === 'sshterminalrelay.ashx') {
                            window.terminal.socket.send('~' + payload);
                        } else {
                            window.terminal.socket.send(payload);
                        }
                        return true;
                    }
                    if (typeof window.terminal.send === 'function') {
                        window.terminal.send(payload);
                        return true;
                    }
                }

                if (typeof window.terminalSocket !== 'undefined' && window.terminalSocket !== null && window.terminalSocket.readyState === 1) {
                    window.terminalSocket.send(payload);
                    return true;
                }

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
                if (modal && modal.parentNode) modal.parentNode.removeChild(modal);
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
                    '  <div class="qts-modal-body" id="qts-modal-body"></div>',
                    '</div>'
                ].join('');

                document.body.appendChild(overlay);

                document.getElementById('qts-modal-close-btn').addEventListener('click', function () {
                    self.closeAdminModal();
                });

                overlay.addEventListener('click', function (e) {
                    if (e.target === overlay) self.closeAdminModal();
                });

                if (this.editingScriptId) this.renderEditFormView();
                else this.renderScriptListView();
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
                    '      <tr><th>Название</th><th>ОС</th><th>Авто-Enter</th><th>Base64</th><th style="text-align:right;">Действия</th></tr>',
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
                        if (newIn) { newIn.focus(); newIn.setSelectionRange(newIn.value.length, newIn.value.length); }
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
                        self.editingScriptId = this.getAttribute('data-id');
                        self.renderEditFormView();
                    });
                }

                var delBtns = body.querySelectorAll('.qts-btn-delete');
                for (var k = 0; k < delBtns.length; k++) {
                    delBtns[k].addEventListener('click', function () {
                        self.confirmDeleteScript(this.getAttribute('data-id'));
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
                        if (this.scripts[i].id === this.editingScriptId) { script = this.scripts[i]; break; }
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
                    '        <span>Использовать Base64-обертку (рекомендуется для PowerShell/Bash)</span>',
                    '      </label>',
                    '    </div>',
                    '  </div>',
                    '  <div class="qts-form-group">',
                    '    <label class="qts-form-label" for="qts-form-content">Текст скрипта / команды <span style="color:#ef4444;">*</span></label>',
                    '    <textarea id="qts-form-content" class="qts-form-textarea" rows="8" required placeholder="Введите тело команды...">' + self.escapeHtml(sContent) + '</textarea>',
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

                    if (!title) { alert('Пожалуйста, укажите название команды.'); return; }
                    if (!content.trim()) { alert('Пожалуйста, введите текст скрипта.'); return; }

                    var updatedScripts = self.scripts.slice();
                    if (isNew) {
                        updatedScripts.push({
                            id: self.generateUUID(),
                            title: title,
                            targetOS: targetOS,
                            autoExecute: autoExecute,
                            useBase64: useBase64,
                            content: content
                        });
                    } else {
                        for (var k = 0; k < updatedScripts.length; k++) {
                            if (updatedScripts[k].id === self.editingScriptId) {
                                updatedScripts[k] = {
                                    id: self.editingScriptId,
                                    title: title,
                                    targetOS: targetOS,
                                    autoExecute: autoExecute,
                                    useBase64: useBase64,
                                    content: content
                                };
                                break;
                            }
                        }
                    }

                    var saveBtn = document.getElementById('qts-btn-save-form');
                    if (saveBtn) { saveBtn.disabled = true; saveBtn.innerText = 'Сохранение...'; }

                    self.saveScriptsToServer(updatedScripts, function (err) {
                        if (err) {
                            alert('Ошибка сохранения: ' + (err.message || err));
                            if (saveBtn) { saveBtn.disabled = false; saveBtn.innerText = 'Сохранить изменения'; }
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
                    if (this.scripts[i].id === id) { script = this.scripts[i]; break; }
                }
                if (!script) return;

                if (confirm('Вы уверены, что хотите удалить команду «' + script.title + '»?')) {
                    var updated = this.scripts.filter(function (s) { return s.id !== id; });
                    this.saveScriptsToServer(updated, function (err) {
                        if (err) alert('Ошибка удаления: ' + (err.message || err));
                        else {
                            self.showToast('Команда удалена.', 'info');
                            self.renderScriptListView();
                        }
                    });
                }
            },

            generateUUID: function () {
                return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
                    var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
                    return v.toString(16);
                });
            },

            escapeHtml: function (text) {
                if (!text) return '';
                return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
            },

            showToast: function (message, type) {
                var existing = document.getElementById('qts-toast');
                if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

                var toast = document.createElement('div');
                toast.id = 'qts-toast';
                toast.className = 'qts-toast qts-toast-' + (type || 'info');
                toast.innerText = message;
                document.body.appendChild(toast);

                setTimeout(function () { toast.classList.add('qts-show'); }, 10);
                setTimeout(function () {
                    toast.classList.remove('qts-show');
                    setTimeout(function () { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 300);
                }, 3000);
            }
        };

        window.QuickTerminalScripts = QTS;
        QTS.init();
    };

    obj.onDeviceRefreshEnd = function () {
        if (window.QuickTerminalScripts && typeof window.QuickTerminalScripts.onDeviceChanged === 'function') {
            window.QuickTerminalScripts.onDeviceChanged();
        }
    };

    obj.onScriptsLoaded = function (server, message) {
        var data = (message && message.scripts) ? message : ((server && server.scripts) ? server : (message || server));
        if (data && data.scripts && window.QuickTerminalScripts) {
            window.QuickTerminalScripts.setScripts(data.scripts);
        }
    };

    obj.onScriptsSaved = function (server, message) {
        var data = (message && message.scripts) ? message : ((server && server.scripts) ? server : (message || server));
        if (data && window.QuickTerminalScripts) {
            if (data.scripts) {
                window.QuickTerminalScripts.setScripts(data.scripts);
            }
            if (typeof window.QuickTerminalScripts._pendingSaveCallback === 'function') {
                var cb = window.QuickTerminalScripts._pendingSaveCallback;
                delete window.QuickTerminalScripts._pendingSaveCallback;
                cb(null, data);
            }
        }
    };

    obj.onSaveError = function (server, message) {
        var msg = message || server;
        var errText = (msg && msg.error) ? msg.error : 'Unknown plugin error';
        if (window.QuickTerminalScripts) {
            if (typeof window.QuickTerminalScripts._pendingSaveCallback === 'function') {
                window.QuickTerminalScripts._pendingSaveCallback(new Error(errText));
                window.QuickTerminalScripts._pendingSaveCallback = null;
            }
            window.QuickTerminalScripts.showToast(errText, 'error');
        }
    };

    // Kick off route registration check
    setTimeout(function () { tryRegisterRoutes(30); }, 500);

    return obj;
};

module.exports = quickterminalscriptsPlugin;
module.exports.quickterminalscripts = quickterminalscriptsPlugin;
