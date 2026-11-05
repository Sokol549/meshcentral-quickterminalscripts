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
    obj.meshServer = parent.meshServer || parent.parent || parent;

    // Resolve data storage paths
    var dataPath = (obj.parent && obj.parent.datapath) 
        || (obj.meshServer && obj.meshServer.datapath) 
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
            // If main file is corrupted, try recovering from backup
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
        var server = obj.meshServer || obj.parent.meshServer || obj.parent;
        if (!server) return null;

        // 1. Session userid check
        if (req.session && req.session.userid) {
            if (server.users && server.users[req.session.userid]) {
                return server.users[req.session.userid];
            }
            if (server.webserver && server.webserver.users && server.webserver.users[req.session.userid]) {
                return server.webserver.users[req.session.userid];
            }
        }

        // 2. Cookie decode check
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

        // Static script endpoints
        var serveJS = function (req, res) {
            res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache');
            if (fs.existsSync(jsFilePath)) {
                fs.createReadStream(jsFilePath).pipe(res);
            } else {
                res.status(404).send('// QuickTerminalScripts: JS file not found');
            }
        };

        // Static CSS endpoints
        var serveCSS = function (req, res) {
            res.setHeader('Content-Type', 'text/css; charset=utf-8');
            res.setHeader('Cache-Control', 'no-cache');
            if (fs.existsSync(cssFilePath)) {
                fs.createReadStream(cssFilePath).pipe(res);
            } else {
                res.status(404).send('/* QuickTerminalScripts: CSS file not found */');
            }
        };

        // Static file routes
        app.get('/plugin/quickterminalscripts/terminalscripts.js', serveJS);
        app.get('/plugin/quickterminalscripts/public/terminalscripts.js', serveJS);
        app.get('/plugin/quickterminalscripts/terminalscripts.css', serveCSS);
        app.get('/plugin/quickterminalscripts/public/terminalscripts.css', serveCSS);

        // API: Get Scripts
        app.get('/plugin/quickterminalscripts/api/scripts', function (req, res) {
            var user = getUserFromReq(req);
            if (!user) {
                // Also allow if user is authenticated in session
                if (!req.session || !req.session.userid) {
                    return res.status(401).json({ error: 'Unauthorized' });
                }
            }

            try {
                var scripts = readScripts();
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
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

            // Parse body if not parsed already by bodyParser
            var body = req.body;
            if (typeof body === 'string') {
                try { body = JSON.parse(body); } catch (e) {
                    return res.status(400).json({ error: 'Invalid JSON body' });
                }
            }

            if (!Array.isArray(body)) {
                // If wrapped in { scripts: [...] }
                if (body && Array.isArray(body.scripts)) {
                    body = body.scripts;
                } else {
                    return res.status(400).json({ error: 'Request body must be an array of scripts' });
                }
            }

            try {
                var saved = saveScripts(body);
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.status(200).json({ success: true, count: saved.length });
            } catch (e) {
                res.status(500).json({ error: 'Save failed: ' + e.message });
            }
        });

        return true;
    }

    function getExpressApp() {
        if (!obj.meshServer) return null;
        return obj.meshServer.app || (obj.meshServer.webserver && obj.meshServer.webserver.app) || null;
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

    // -----------------------------------------------------------------
    // WebSocket Plugin Message Handler
    // -----------------------------------------------------------------
    obj.serveraction = function (command, myUser, parent) {
        if (!command || !myUser) return;

        var action = command.pluginaction || command.method || command.action;
        var user = myUser.user;

        switch (action) {
            case 'getScripts': {
                try {
                    var scripts = readScripts();
                    myUser.send(JSON.stringify({
                        action: 'plugin',
                        plugin: 'quickterminalscripts',
                        method: 'onScriptsLoaded',
                        scripts: scripts
                    }));
                } catch (e) {
                    myUser.send(JSON.stringify({
                        action: 'plugin',
                        plugin: 'quickterminalscripts',
                        method: 'onSaveError',
                        error: 'Failed to read scripts: ' + e.message
                    }));
                }
                break;
            }

            case 'saveScripts': {
                if (!isUserAdmin(user)) {
                    myUser.send(JSON.stringify({
                        action: 'plugin',
                        plugin: 'quickterminalscripts',
                        method: 'onSaveError',
                        error: 'Access denied: Administrator permissions required',
                        status: 403
                    }));
                    return;
                }

                try {
                    var toSave = command.scripts;
                    var result = saveScripts(toSave);
                    myUser.send(JSON.stringify({
                        action: 'plugin',
                        plugin: 'quickterminalscripts',
                        method: 'onScriptsSaved',
                        scripts: result,
                        success: true
                    }));
                } catch (e) {
                    myUser.send(JSON.stringify({
                        action: 'plugin',
                        plugin: 'quickterminalscripts',
                        method: 'onSaveError',
                        error: 'Failed to save scripts: ' + e.message
                    }));
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

    obj.onWebUIStartupEnd = function () {
        // Ensure stylesheet is loaded
        if (!document.getElementById('qts-styles')) {
            var link = document.createElement('link');
            link.id = 'qts-styles';
            link.rel = 'stylesheet';
            link.type = 'text/css';
            link.href = '/plugin/quickterminalscripts/terminalscripts.css';
            document.head.appendChild(link);
        }

        // Dynamically load standalone client script if not already present
        if (!window._quickTerminalScriptsLoaded) {
            var script = document.createElement('script');
            script.type = 'text/javascript';
            script.src = '/plugin/quickterminalscripts/terminalscripts.js';
            document.head.appendChild(script);
        }
    };

    obj.onDeviceRefreshEnd = function () {
        if (window.QuickTerminalScripts && typeof window.QuickTerminalScripts.onDeviceChanged === 'function') {
            window.QuickTerminalScripts.onDeviceChanged();
        }
    };

    obj.onScriptsLoaded = function (server, message) {
        var msg = message || server;
        if (msg && msg.scripts && window.QuickTerminalScripts) {
            window.QuickTerminalScripts.setScripts(msg.scripts);
        }
    };

    obj.onScriptsSaved = function (server, message) {
        var msg = message || server;
        if (msg && msg.scripts && window.QuickTerminalScripts) {
            window.QuickTerminalScripts.setScripts(msg.scripts);
            if (typeof window.QuickTerminalScripts._pendingSaveCallback === 'function') {
                window.QuickTerminalScripts._pendingSaveCallback(null, msg);
                window.QuickTerminalScripts._pendingSaveCallback = null;
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
