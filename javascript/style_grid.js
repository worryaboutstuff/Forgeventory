/**
 * Forgeventory - Visual grid/gallery style selector for Forge WebUI
 * v2.0 — Full-featured: silent mode, dynamic apply, presets,
 * conflict detection, context menu, inline editor, etc.
 * v2.0.1 — thumb cache (localStorage), popup 253x184, no remove-preview in menu
 */
(function () {
    "use strict";
    if (typeof window !== "undefined") {
        window.__SG_THUMB_VERSION = "2.0.1";
        window.SG = window.SG || {};
    }

    // ════════════════════════════════════════════════════
    // STATE + INIT (per-tab runtime; see STORAGE for persistence)
    // ════════════════════════════════════════════════════
    function createTabState() {
        return {
            selected: new Set(),
            selectedOrder: [],
            applied: new Map(),
            categories: {},
            panel: null,
            selectedSource: "All",
            /** Normalized path (forward slashes) when known — matches V2 `source_file`; same basename can exist in multiple dirs */
            selectedSourceFile: null,
            usage: {},
            presets: {},
            silentMode: false,
            userPromptBase: "",
            userPromptBaseNeg: "",
            hasThumbnail: new Set(),
            sgFrame: null,
            sgFrameWrapper: null,
            sgV2HostInitSent: false,
            temporaryWildcards: {},
            nextTemporaryWildcardId: 1,
        };
    }
    const state = {};
    ["txt2img", "img2img"].forEach(function (tab) {
        state[tab] = createTabState();
    });

    // ════════════════════════════════════════════════════
    // STORAGE (localStorage + server-backed preferences)
    // ════════════════════════════════════════════════════

    var _thumbPopup = null;      // single shared popup element
    var _thumbHoverTimer = null; // pending hover timer
    var _thumbVersions = (function () {
        try { return JSON.parse(localStorage.getItem("sg_thumb_versions") || "{}"); }
        catch (_) { return {}; }
    })();
    function _saveThumbVersions() {
        try { localStorage.setItem("sg_thumb_versions", JSON.stringify(_thumbVersions)); }
        catch (_) { }
    }
    var _thumbProgressTimer = null;

    const SOURCE_STORAGE_KEY = "sg_source";
    function getStoredSource(t) {
        try {
            const d = JSON.parse(localStorage.getItem(SOURCE_STORAGE_KEY) || "{}");
            return d[t] || "All";
        } catch (_) {
            return "All";
        }
    }
    function setStoredSource(t, v) {
        try {
            const d = JSON.parse(localStorage.getItem(SOURCE_STORAGE_KEY) || "{}");
            d[t] = v;
            localStorage.setItem(SOURCE_STORAGE_KEY, JSON.stringify(d));
        } catch (_) { }
    }
    function loadCategoryOrder() {
        try {
            return JSON.parse(localStorage.getItem("sg_cat_order") || "null");
        } catch (_) {
            return null;
        }
    }
    function saveCategoryOrder(order) {
        try {
            localStorage.setItem("sg_cat_order", JSON.stringify(order));
        } catch (_) { }
        // Also persist to server for cross-browser persistence
        apiPost("/style_grid/category_order/save", { order: order }).catch(function () { });
    }
    function getSilentMode(t) {
        try {
            const d = JSON.parse(localStorage.getItem("sg_silent") || "{}");
            return !!d[t];
        } catch (_) {
            return false;
        }
    }
    function setSilentMode(t, v) {
        try {
            const d = JSON.parse(localStorage.getItem("sg_silent") || "{}");
            d[t] = v;
            localStorage.setItem("sg_silent", JSON.stringify(d));
        } catch (_) { }
    }

    // Favorites
    const FAV_CAT = "FAVORITES";
    function getFavorites(t) {
        try {
            const d = JSON.parse(localStorage.getItem("sg_favorites") || "{}");
            return new Set(d[t] || []);
        } catch (_) {
            return new Set();
        }
    }
    function setFavorites(t, s) {
        try {
            const d = JSON.parse(localStorage.getItem("sg_favorites") || "{}");
            d[t] = [...s];
            localStorage.setItem("sg_favorites", JSON.stringify(d));
        } catch (_) { }
    }
    function toggleFavorite(t, n) {
        const f = getFavorites(t);
        if (f.has(n)) f.delete(n);
        else f.add(n);
        setFavorites(t, f);
    }

    // Recent history
    function getRecentHistory(t) {
        try {
            return JSON.parse(localStorage.getItem("sg_recent_" + t) || "[]");
        } catch (_) {
            return [];
        }
    }
    function addToRecentHistory(t, names) {
        let h = getRecentHistory(t);
        names.forEach(function (n) { h = h.filter(function (x) { return x !== n; }); h.unshift(n); });
        if (h.length > 10) h = h.slice(0, 10);
        localStorage.setItem("sg_recent_" + t, JSON.stringify(h));
    }

    // -----------------------------------------------------------------------
    // Utility
    // -----------------------------------------------------------------------
    function hashString(s) {
        if (!s) s = "";
        let h = 0;
        for (let i = 0; i < s.length; i++) {
            h = ((h << 5) - h) + s.charCodeAt(i);
            h = h & h;
        }
        return Math.abs(h);
    }
    function getCategoryColor(c) {
        const h = hashString(c) % 360;
        const s = 55 + (hashString(c + "s") % 25);
        const l = 48 + (hashString(c + "l") % 12);
        return "hsl(" + h + "," + s + "%," + l + "%)";
    }
    function qs(sel, root) {
        if (root) return root.querySelector(sel);
        var ga = (typeof gradioApp === "function") ? gradioApp() : null;
        return (ga || document).querySelector(sel);
    }
    function qsa(sel, root) { return (root || document).querySelectorAll(sel); }
    function el(tag, attrs, children) {
        const e = document.createElement(tag);
        if (attrs) Object.entries(attrs).forEach(function (kv) {
            const k = kv[0], v = kv[1];
            if (k === "className") e.className = v;
            else if (k === "textContent") e.textContent = v;
            else if (k.startsWith("on")) e.addEventListener(k.slice(2).toLowerCase(), v);
            else e.setAttribute(k, v);
        });
        if (children) (Array.isArray(children) ? children : [children]).forEach(function (c) {
            if (typeof c === "string") e.appendChild(document.createTextNode(c));
            else if (c) e.appendChild(c);
        });
        return e;
    }

    function normalizeSearchText(s) { return (s || "").replace(/\s+/g, " ").trim().toLowerCase(); }
    function buildSearchText(style) { return normalizeSearchText([style.name, style.display_name].filter(Boolean).join(" ")); }
    function acMatches(candidate, query) {
        const normalized = normalizeSearchText(candidate);
        const q = normalizeSearchText(query);
        if (!q) return true;
        return q.split(/\s+/).filter(Boolean).every(function (token) {
            return normalized.includes(token);
        });
    }
    function getUniqueSources(t) {
        const cats = state[t].categories || {};
        const s = new Set();
        Object.values(cats).forEach(function (arr) { arr.forEach(function (st) { if (st.source) s.add(st.source); }); });
        return Array.from(s).sort();
    }
    function findStyleByName(t, n) {
        for (const styles of Object.values(state[t].categories)) {
            const f = styles.find(function (s) { return s.name === n; });
            if (f) return f;
        }
        return null;
    }
    function getLoadedStylesWithCategory(tabName) {
        var out = [];
        var cats = state[tabName].categories || {};
        for (var catName in cats) {
            (cats[catName] || []).forEach(function (s) {
                out.push({
                    name: s.name,
                    display_name: s.display_name,
                    category: catName
                });
            });
        }
        return out;
    }

    // ════════════════════════════════════════════════════
    // CONFLICTS / COMBOS (description parsing & chips)
    // ════════════════════════════════════════════════════
    function parseDescription(desc) {
        if (!desc) return { text: "", combos: [], conflicts: [] };

        var result = { text: "", combos: [], conflicts: [] };

        // Extract Combos: section — after "Combos:" until end or first period
        var combosMatch = desc.match(/Combos:\s*([^.]+)/i);
        if (combosMatch) {
            var block = combosMatch[1].trim();
            var rawTokens = block.split(/\s*;\s*|\s+or\s+/i).map(function (s) { return s.trim(); });
            result.combos = rawTokens.map(function (token) {
                token = token.replace(/\.\s*$/, "").trim();
                var parts = token.split(/\s+/);
                var out = [];
                for (var i = 0; i < parts.length; i++) {
                    if (/^[a-z]/.test(parts[i]) || parts[i].toLowerCase() === "for") break;
                    out.push(parts[i]);
                }
                return out.join(" ").trim();
            }).filter(Boolean);
        }

        // Extract Conflicts: section
        var conflictsMatch = desc.match(/Conflicts:\s*([^.]+)/i);
        if (conflictsMatch) {
            result.conflicts = conflictsMatch[1]
                .split(";")
                .map(function (s) { return s.trim(); })
                .filter(Boolean);
        }

        // Plain text = everything before first "Combos:" or "Conflicts:"
        result.text = desc
            .replace(/Combos:[^.]+\.?/i, "")
            .replace(/Conflicts:[^.]+\.?/i, "")
            .replace(/\s+/g, " ")
            .trim();

        return result;
    }
    function findStyleByToken(token, loadedStyles) {
        var list = loadedStyles || [];
        var found = list.find(function (s) { return s.name === token; });
        if (found) return found;

        var parts = token.split("_");
        if (parts.length >= 2) {
            var swapped = [parts[1], parts[0]].concat(parts.slice(2)).join("_");
            found = list.find(function (s) { return s.name === swapped; });
            if (found) return found;
        }

        var lower = token.toLowerCase();
        found = list.find(function (s) { return (s.name || "").toLowerCase() === lower; });
        if (found) return found;

        if (parts.length >= 2) {
            var swappedLower = [parts[1], parts[0]].concat(parts.slice(2)).join("_").toLowerCase();
            found = list.find(function (s) { return (s.name || "").toLowerCase() === swappedLower; });
            if (found) return found;
        }

        return null;
    }
    function resolveComboItem(tabName, comboStr, loadedStyles) {
        var token = (comboStr || "").trim();
        if (!token) return { type: "plain", label: comboStr || "" };

        var list = loadedStyles || [];

        // Type 1: WILDCARD — ends with _*
        if (token.endsWith("_*")) {
            var prefixWithUnderscore = token.slice(0, -2).trim() + "_";
            var chipLabel = prefixWithUnderscore.replace(/_$/, "") || token;
            return {
                type: "wildcard",
                label: chipLabel,
                searchPrefix: prefixWithUnderscore
            };
        }

        // Type 2: EXACT STYLE NAME (with swap fallback for SUBJECT_CATEGORY vs CATEGORY_SUBJECT)
        var styleMatch = findStyleByToken(token, list);
        if (styleMatch) {
            return {
                type: "style",
                label: token,
                styleName: styleMatch.name
            };
        }

        return { type: "plain", label: comboStr };
    }

    // ════════════════════════════════════════════════════
    // PROMPT ENGINE
    // ════════════════════════════════════════════════════
    function removeSubstringFromPrompt(val, sub) {
        if (!sub || !val) return val;
        const idx = val.indexOf(sub);
        if (idx === -1) return val;
        return val.substring(0, idx) + val.substring(idx + sub.length);
    }

    function styleWildcardToken(styleName) {
        return "{sg:" + String(styleName || "").replace(/}/g, "") + "}";
    }

    // Canonical copy in javascript/sg_prompt_utils.js — keep in sync (Forge loads this file only).
    /* eslint-disable no-unused-vars */
    /** Insert a prompt token literally at the selection without adding separators. */
    function insertPromptTokenAtSelection(value, selectionStart, selectionEnd, token) {
        var text = String(value || "");
        var insertText = String(token || "");
        var start = Number.isFinite(selectionStart) ? Math.trunc(selectionStart) : text.length;
        var end = Number.isFinite(selectionEnd) ? Math.trunc(selectionEnd) : start;
        start = Math.max(0, Math.min(text.length, start));
        end = Math.max(start, Math.min(text.length, end));

        var before = text.slice(0, start);
        var after = text.slice(end);
        var caret = before.length + insertText.length;
        return {
            value: before + insertText + after,
            selectionStart: caret,
            selectionEnd: caret,
        };
    }
    function splitTopLevelCommas(s) {
        if (!s || !String(s).trim()) return [];
        var str = String(s);
        var parts = [];
        var depth = 0;
        var cur = "";
        for (var i = 0; i < str.length; i++) {
            var c = str[i];
            if (c === "(") depth++;
            else if (c === ")") depth = Math.max(0, depth - 1);
            if (c === "," && depth === 0) {
                if (cur.trim()) parts.push(cur.trim());
                cur = "";
            } else {
                cur += c;
            }
        }
        if (cur.trim()) parts.push(cur.trim());
        return parts;
    }

    /** Remove outer layers of balanced parentheses, e.g. "((foo))" → "foo". */
    function stripParenLayers(s) {
        var t = String(s || "").trim();
        var changed = true;
        while (changed) {
            changed = false;
            if (t.length < 2 || t.charAt(0) !== "(" || t.charAt(t.length - 1) !== ")") break;
            var depth = 0;
            var wrapsWhole = true;
            for (var i = 0; i < t.length; i++) {
                var c = t.charAt(i);
                if (c === "(") depth++;
                else if (c === ")") {
                    depth--;
                    if (depth === 0 && i !== t.length - 1) {
                        wrapsWhole = false;
                        break;
                    }
                }
            }
            if (wrapsWhole && depth === 0) {
                t = t.slice(1, -1).trim();
                changed = true;
            }
        }
        return t;
    }

    function parseSegmentToTagged(seg) {
        var t = (seg || "").trim();
        if (!t) return null;
        var m = /^\(([\s\S]+?):([\d.]+)\)$/.exec(t);
        if (m) return { tag: m[1].trim(), weight: parseFloat(m[2]) };
        return { tag: t, weight: 1 };
    }

    function parseStylePromptTags(prompt) {
        return splitTopLevelCommas(prompt)
            .map(parseSegmentToTagged)
            .filter(function (x) { return x !== null; });
    }

    function formatScaledWeight(w, scale) {
        var nw = 1 + (w - 1) * scale;
        return String(+nw.toPrecision(10));
    }

    function scalePromptWeights(text, scale) {
        if (scale === 1) return text;
        var parts = splitTopLevelCommas(text);
        var out = [];
        for (var i = 0; i < parts.length; i++) {
            var p = parts[i].trim();
            if (!p) continue;
            if (p === "{prompt}") {
                out.push(p);
                continue;
            }
            var m = /^\(([\s\S]+?):([\d.]+)\)$/.exec(p);
            if (m) {
                if (scale === 0) continue;
                var w = parseFloat(m[2]);
                var nw = formatScaledWeight(w, scale);
                out.push("(" + m[1].trim() + ":" + nw + ")");
                continue;
            }
            if (scale === 0) continue;
            out.push("(" + p + ":" + scale + ")");
        }
        return out.join(", ");
    }
    /* eslint-enable no-unused-vars */

    function setPromptValue(el, value) {
        if (!el) return;
        // Use native setter to bypass framework interception
        var nativeSet = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, "value"
        );
        if (nativeSet && nativeSet.set) {
            nativeSet.set.call(el, value);
        } else {
            el.value = value;
        }
        el.dispatchEvent(new InputEvent("input", {
            bubbles: true,
            inputType: "insertText",
            data: value
        }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    function appendPromptLine(promptEl, text) {
        var current = promptEl.value || "";
        var separator = current && !current.endsWith("\n") ? "\n" : "";
        setPromptValue(promptEl, current + separator + text);
        restorePromptSelection(promptEl, promptEl.value.length, promptEl.value.length);
    }

    // Duplicated in sg_prompt_utils.js so the safety behavior can be tested standalone.
    function escapeRegExpText(value) {
        return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    function loraTokenPattern(loraName, flags) {
        return new RegExp(
            "<lora:\\s*" + escapeRegExpText(loraName) + "\\s*:[^>\\r\\n]*>",
            flags || "i"
        );
    }
    function promptHasLoraToken(text, loraName) {
        if (!text || !loraName) return false;
        return loraTokenPattern(loraName, "i").test(String(text));
    }
    function removeExactPromptBlock(text, block) {
        var value = String(text || "");
        var target = String(block || "");
        if (!value || !target) return { value: value, removed: false };

        var from = value.length;
        while (from >= 0) {
            var index = value.lastIndexOf(target, from);
            if (index === -1) break;
            var end = index + target.length;
            var beforeOk = index === 0 || value.charAt(index - 1) === "\n";
            var afterOk = end === value.length || value.charAt(end) === "\n" ||
                (value.charAt(end) === "\r" && value.charAt(end + 1) === "\n");
            if (beforeOk && afterOk) {
                var removeStart = index;
                var removeEnd = end;
                if (removeEnd < value.length && value.charAt(removeEnd) === "\r") removeEnd++;
                if (removeEnd < value.length && value.charAt(removeEnd) === "\n") {
                    removeEnd++;
                } else if (removeStart > 0 && value.charAt(removeStart - 1) === "\n") {
                    removeStart--;
                    if (removeStart > 0 && value.charAt(removeStart - 1) === "\r") removeStart--;
                }
                return {
                    value: value.slice(0, removeStart) + value.slice(removeEnd),
                    removed: true,
                };
            }
            from = index - 1;
        }
        return { value: value, removed: false };
    }
    function removeLoraPromptText(text, loraName, generatedPrompt) {
        var exact = removeExactPromptBlock(text, generatedPrompt);
        if (exact.removed) {
            return { value: exact.value, removedExact: true };
        }
        if (!loraName) return { value: exact.value, removedExact: false };
        var tokenPattern = loraTokenPattern(loraName, "gi");
        return {
            value: exact.value.replace(new RegExp(tokenPattern.source + "[ \\t]?", "gi"), ""),
            removedExact: false,
        };
    }
    function loraNameFromToken(token) {
        var match = /^<lora:([^:>]+):/i.exec(String(token || ""));
        return match ? match[1] : "";
    }
    function toggleLoraPrompts(tabName, loraName, prompt, negativePrompt, token) {
        var promptEl = qs("#" + tabName + "_prompt textarea");
        var negEl = negativePrompt ? qs("#" + tabName + "_neg_prompt textarea") : null;
        if (!promptEl || !prompt || (negativePrompt && !negEl)) return false;

        var resolvedName = loraName || loraNameFromToken(token);
        var wasApplied = resolvedName && promptHasLoraToken(promptEl.value, resolvedName);
        if (!wasApplied) {
            appendPromptLine(promptEl, prompt);
            if (negativePrompt) appendPromptLine(negEl, negativePrompt);
            return { applied: true, removedExact: false };
        }

        var positiveResult = removeLoraPromptText(promptEl.value, resolvedName, prompt);
        setPromptValue(promptEl, positiveResult.value);
        restorePromptSelection(promptEl, promptEl.value.length, promptEl.value.length);
        if (positiveResult.removedExact && negativePrompt && negEl) {
            var negativeResult = removeExactPromptBlock(negEl.value, negativePrompt);
            if (negativeResult.removed) {
                setPromptValue(negEl, negativeResult.value);
                restorePromptSelection(negEl, negEl.value.length, negEl.value.length);
            }
        }
        return {
            applied: promptHasLoraToken(promptEl.value, resolvedName),
            removedExact: positiveResult.removedExact,
        };
    }
    function postPromptStateToFrame(tabName, frameOverride) {
        var targetFrame = frameOverride || (state[tabName] && state[tabName].sgFrame);
        if (!targetFrame || !targetFrame.contentWindow) return;
        var promptEl = qs("#" + tabName + "_prompt textarea");
        var negEl = qs("#" + tabName + "_neg_prompt textarea");
        targetFrame.contentWindow.postMessage({
            type: "SG_PROMPT_CHANGED",
            prompt: promptEl ? promptEl.value || "" : "",
            neg: negEl ? negEl.value || "" : "",
        }, "*");
    }
    function openForgeLoraMetadataEditor(tabName, loraName) {
        var app = gradioApp();
        var id = tabName + "_lora_edit_user_metadata";
        var editorPage = app.getElementById(id);
        var nameTextarea = app.querySelector("#" + id + "_name textarea");
        var openButton = app.querySelector("#" + id + "_button");
        if (!editorPage || !nameTextarea || !openButton) {
            throw new Error("Forge LoRA metadata editor is unavailable");
        }
        nameTextarea.value = loraName;
        if (typeof window.updateInput !== "function" || typeof window.popup !== "function") {
            throw new Error("Forge metadata controls are unavailable");
        }
        window.updateInput(nameTextarea);
        openButton.click();
        window.popup(editorPage);
    }
    function restorePromptSelection(el, start, end) {
        if (!el || typeof el.setSelectionRange !== "function") return;
        var applySelection = function () {
            try { el.setSelectionRange(start, end); }
            catch (_) { }
        };
        applySelection();
        if (typeof requestAnimationFrame === "function") {
            requestAnimationFrame(applySelection);
        }
    }
    function insertPromptTokenAtCursor(el, token) {
        if (!el || !token) return null;
        var start = typeof el.selectionStart === "number" ? el.selectionStart : el.value.length;
        var end = typeof el.selectionEnd === "number" ? el.selectionEnd : start;
        var insertion = insertPromptTokenAtSelection(el.value, start, end, token);
        setPromptValue(el, insertion.value);
        restorePromptSelection(el, insertion.selectionStart, insertion.selectionEnd);
        return insertion;
    }
    function removePromptSubstring(el, sub) {
        if (!el || !sub || !el.value) return false;
        var oldValue = el.value;
        var index = oldValue.indexOf(sub);
        if (index === -1) return false;
        var start = typeof el.selectionStart === "number" ? el.selectionStart : oldValue.length;
        var end = typeof el.selectionEnd === "number" ? el.selectionEnd : start;
        var newValue = removeSubstringFromPrompt(oldValue, sub);
        var removedLength = oldValue.length - newValue.length;
        var adjust = function (position) {
            if (position <= index) return position;
            if (position < index + sub.length) return index;
            return Math.max(index, position - removedLength);
        };
        setPromptValue(el, newValue);
        restorePromptSelection(el, adjust(start), adjust(end));
        return true;
    }
    function setSilentGradio(tabName) {
        var silentEl = qs("#style_grid_silent_" + tabName + " textarea");
        var names = state[tabName].silentMode ? [...state[tabName].selected] : [];
        if (!silentEl) return;
        setPromptValue(silentEl, JSON.stringify(names));
        syncSourceInput(tabName);
    }
    function syncSourceInput(tab) {
        var src = state[tab].selectedSourceFile || "";
        var elemId = tab === "txt2img" ? "style_grid_source_txt2img" : "style_grid_source_img2img";
        var el = gradioApp().querySelector("#" + elemId + " textarea");
        if (el && el.value !== src) {
            el.value = src;
            el.dispatchEvent(new Event("input", { bubbles: true }));
        }
    }

    // -----------------------------------------------------------------------
    // Load data from Gradio hidden component
    // -----------------------------------------------------------------------
    function loadStyles(tabName) {
        const dataEl = qs("#style_grid_data_" + tabName + " textarea");
        if (!dataEl || !dataEl.value) return {};
        try {
            const data = JSON.parse(dataEl.value);
            state[tabName].usage = data.usage || {};
            state[tabName].presets = data.presets || {};
            return data.categories || {};
        } catch (_) { return {}; }
    }
    function getCategoryOrder(tabName) {
        const el = qs("#style_grid_cat_order_" + tabName + " textarea");
        if (!el || !el.value) return [];
        try { return JSON.parse(el.value); } catch (_) { return []; }
    }

    function getCollapsedCategories() {
        try {
            return JSON.parse(localStorage.getItem("sg_collapsed") || "[]");
        } catch (_) { return []; }
    }
    function saveCollapsedCategories(tabName) {
        var panel = state[tabName].panel;
        if (!panel) return;
        var collapsed = [];
        qsa(".sg-category.sg-collapsed", panel).forEach(function (sec) {
            var cat = sec.getAttribute("data-category");
            if (cat) collapsed.push(cat);
        });
        try { localStorage.setItem("sg_collapsed", JSON.stringify(collapsed)); }
        catch (_) { }
    }

    // ════════════════════════════════════════════════════
    // API CLIENT
    // ════════════════════════════════════════════════════
    // API helpers
    function apiPost(endpoint, data) {
        return fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(data || {}),
        }).then(function (r) {
            return r.text().then(function (text) {
                var body = {};
                if (text) {
                    try {
                        body = JSON.parse(text);
                    } catch (_e) {
                        if (!r.ok) {
                            return Promise.reject(new Error("HTTP " + r.status));
                        }
                        return Promise.reject(new Error("Invalid JSON in response"));
                    }
                }
                if (!r.ok) {
                    var msg = (body && body.error) || (typeof body.detail === "string" ? body.detail : null);
                    if (!msg && body && Array.isArray(body.detail)) {
                        msg = body.detail.map(function (d) { return (d && d.msg) ? d.msg : ""; }).filter(Boolean).join("; ");
                    }
                    return Promise.reject(new Error(msg || ("HTTP " + r.status)));
                }
                return body;
            });
        });
    }

    function assertNoApiError(result) {
        if (result && result.error) {
            return Promise.reject(new Error(result.error));
        }
        return result;
    }
    function apiGet(endpoint) {
        return fetch(endpoint).then(function (r) { return r.json(); });
    }

    // ════════════════════════════════════════════════════
    // THUMBNAILS
    // ════════════════════════════════════════════════════
    function loadThumbnailList(tabName) {
        apiGet("/style_grid/thumbnails/list")
            .then(function (data) {
                state[tabName].hasThumbnail = new Set(data.has_thumbnail || []);
                var panel = state[tabName].panel;
                if (!panel) return;
                qsa(".sg-card", panel).forEach(function (card) {
                    var name = card.getAttribute("data-style-name");
                    card.classList.toggle(
                        "sg-has-thumb",
                        state[tabName].hasThumbnail.has(name)
                    );
                });
            })
            .catch(function () {});
    }

    function showStatusMessage(tabName, text, isError = false) {
        const panel = state[tabName].panel;
        if (!panel) return;
        const existing = qs(".sg-status-msg", panel);
        if (existing) existing.remove();
        const msg = el("div", {
            className: "sg-status-msg" + (isError ? " sg-status-error" : ""),
            textContent: text,
        });
        const footer = qs(".sg-footer", panel);
        if (footer) footer.prepend(msg);
        setTimeout(function () {
            msg.remove();
        }, 3000);
    }

    // ════════════════════════════════════════════════════
    // CONFLICT DETECTION
    // ════════════════════════════════════════════════════
    // Conflict detection (client-side quick check)
    function checkConflictsLocal(tabName) {
        const selected = [...state[tabName].selected];
        if (selected.length < 2) return [];
        const conflicts = [];
        const tokenMap = {};
        selected.forEach(function (name) {
            const s = findStyleByName(tabName, name);
            if (!s) return;
            tokenMap[name] = { pos: new Set(), neg: new Set() };
            (s.prompt || "").split(",").forEach(function (t) {
                t = t.trim().toLowerCase();
                if (t && t !== "{prompt}") tokenMap[name].pos.add(t);
            });
            (s.negative_prompt || "").split(",").forEach(function (t) {
                t = t.trim().toLowerCase();
                if (t && t !== "{prompt}") tokenMap[name].neg.add(t);
            });
        });
        const names = Object.keys(tokenMap);
        for (let i = 0; i < names.length; i++) {
            for (let j = i + 1; j < names.length; j++) {
                const a = names[i];
                const b = names[j];

                // A adds what B negates
                const overlap1 = new Set();
                tokenMap[a].pos.forEach(function (t) {
                    if (tokenMap[b].neg.has(t)) overlap1.add(t);
                });
                if (overlap1.size > 0) {
                    conflicts.push({
                        styleA: a,
                        styleB: b,
                        tokens: [...overlap1].slice(0, 5),
                        suggestion: "drop_b",
                        suggestionText: "Remove \"" + b + "\" (negates tokens from \"" + a + "\")"
                    });
                }

                // B adds what A negates
                const overlap2 = new Set();
                tokenMap[b].pos.forEach(function (t) {
                    if (tokenMap[a].neg.has(t)) overlap2.add(t);
                });
                if (overlap2.size > 0) {
                    conflicts.push({
                        styleA: b,
                        styleB: a,
                        tokens: [...overlap2].slice(0, 5),
                        suggestion: "drop_b",
                        suggestionText: "Remove \"" + a + "\" (negates tokens from \"" + b + "\")"
                    });
                }
            }
        }
        return conflicts;
    }

    // -----------------------------------------------------------------------
    // Dynamic apply / unapply a single style
    // -----------------------------------------------------------------------
    function applyStyleImmediate(tabName, styleName, opts) {
        opts = opts || {};
        var restoreOnly = opts.silent === true;
        if (!restoreOnly && state[tabName].applied.has(styleName)) {
            var currentPromptEl = qs("#" + tabName + "_prompt textarea");
            var currentToken = styleWildcardToken(styleName);
            if (currentPromptEl && currentPromptEl.value.toLowerCase().indexOf(currentToken.toLowerCase()) !== -1) {
                return;
            }
            state[tabName].applied.delete(styleName);
        }
        const style = findStyleByName(tabName, styleName);
        if (!style) return;

        if (state[tabName].silentMode) {
            // Silent: just track, don't touch prompt fields
            state[tabName].applied.set(styleName, { prompt: style.prompt || null, negative: style.negative_prompt || null, silent: true });
            setSilentGradio(tabName);
            return;
        }

        const promptEl = qs("#" + tabName + "_prompt textarea");
        const negEl = qs("#" + tabName + "_neg_prompt textarea");
        if (!promptEl || !negEl) return;

        if (!restoreOnly) {
            if (state[tabName].applied.size === 0) {
                state[tabName].userPromptBase = promptEl.value;
                state[tabName].userPromptBaseNeg = negEl.value;
            }
        }

        var snapshotPrompt;
        var snapshotNeg;
        var prompt;
        var neg;
        if (restoreOnly) {
            prompt = state[tabName]._restoreSimP;
            neg = state[tabName]._restoreSimN;
            snapshotPrompt = prompt;
            snapshotNeg = neg;
        } else {
            snapshotPrompt = promptEl.value;
            snapshotNeg = negEl.value;
            prompt = promptEl.value;
            neg = negEl.value;
        }
        const addedPrompt = styleWildcardToken(styleName);
        var insertion = null;
        if (prompt.toLowerCase().indexOf(addedPrompt.toLowerCase()) === -1) {
            var selectionStart = restoreOnly
                ? prompt.length
                : (typeof promptEl.selectionStart === "number" ? promptEl.selectionStart : prompt.length);
            var selectionEnd = restoreOnly
                ? selectionStart
                : (typeof promptEl.selectionEnd === "number" ? promptEl.selectionEnd : selectionStart);
            insertion = insertPromptTokenAtSelection(prompt, selectionStart, selectionEnd, addedPrompt);
            prompt = insertion.value;
        }

        state[tabName].applied.set(styleName, {
            prompt: addedPrompt,
            negative: null,
            wrapTemplate: null,
            negWrapTemplate: null,
            originalPrompt: snapshotPrompt,
            originalNeg: snapshotNeg
        });
        if (restoreOnly) {
            state[tabName]._restoreSimP = prompt;
            state[tabName]._restoreSimN = neg;
        } else if (insertion) {
            setPromptValue(promptEl, prompt);
            restorePromptSelection(promptEl, insertion.selectionStart, insertion.selectionEnd);
        }

        // Mark cards
        qsa('.sg-card[data-style-name="' + CSS.escape(styleName) + '"]', state[tabName].panel).forEach(function (c) {
            c.classList.add("sg-applied");
        });
    }

    window._sgApplyStyle = applyStyleImmediate;
    window._sgUnapplyStyle = unapplyStyle;

    function unapplyStyle(tabName, styleName) {
        const record = state[tabName].applied.get(styleName);
        if (!record) {
            if (state[tabName].selected && state[tabName].selected.has(styleName)) {
                state[tabName].selected.delete(styleName);
                state[tabName].selectedOrder = (state[tabName].selectedOrder || []).filter(function (n) { return n !== styleName; });
                setSilentGradio(tabName);
            }
            return;
        }

        if (record.silent || state[tabName].silentMode) {
            state[tabName].applied.delete(styleName);
            if (state[tabName].selected) state[tabName].selected.delete(styleName);
            state[tabName].selectedOrder = (state[tabName].selectedOrder || []).filter(function (n) { return n !== styleName; });
            setSilentGradio(tabName);
            qsa('.sg-card[data-style-name="' + CSS.escape(styleName) + '"]', state[tabName].panel).forEach(function (c) { c.classList.remove("sg-applied"); });
            return;
        }

        const promptEl = qs("#" + tabName + "_prompt textarea");
        const negEl = qs("#" + tabName + "_neg_prompt textarea");
        if (!promptEl || !negEl) return;

        if (record.wrapTemplate && record.originalPrompt !== null && record.originalPrompt !== undefined) {
            const parts = record.wrapTemplate.split("{prompt}");
            const prefix = (parts[0] || "").replace(/,\s*$/, "").trim();
            const suffix = (parts[1] || "").replace(/^,\s*/, "").trim();
            let current = promptEl.value.trim();
            if (prefix && current.indexOf(prefix) === 0) {
                current = current.slice(prefix.length).replace(/^,\s*/, "").trim();
            }
            if (suffix && current.lastIndexOf(suffix) === current.length - suffix.length) {
                current = current.slice(0, current.length - suffix.length).replace(/,\s*$/, "").trim();
            }
            setPromptValue(promptEl, current);
        } else if (record.prompt) {
            removePromptSubstring(promptEl, record.prompt);
        }

        if (record.negWrapTemplate && record.originalNeg !== null && record.originalNeg !== undefined) {
            const partsNeg = record.negWrapTemplate.split("{prompt}");
            const prefixNeg = (partsNeg[0] || "").replace(/,\s*$/, "").trim();
            const suffixNeg = (partsNeg[1] || "").replace(/^,\s*/, "").trim();
            let currentNeg = negEl.value.trim();
            if (prefixNeg && currentNeg.indexOf(prefixNeg) === 0) {
                currentNeg = currentNeg.slice(prefixNeg.length).replace(/^,\s*/, "").trim();
            }
            if (suffixNeg && currentNeg.lastIndexOf(suffixNeg) === currentNeg.length - suffixNeg.length) {
                currentNeg = currentNeg.slice(0, currentNeg.length - suffixNeg.length).replace(/,\s*$/, "").trim();
            }
            setPromptValue(negEl, currentNeg);
        } else if (record.negative) {
            removePromptSubstring(negEl, record.negative);
        }

        state[tabName].applied.delete(styleName);
        qsa('.sg-card[data-style-name="' + CSS.escape(styleName) + '"]', state[tabName].panel).forEach(function (c) { c.classList.remove("sg-applied"); });
    }

    function clearHostSilentSelection(tabName) {
        state[tabName].selected = new Set();
        state[tabName].selectedOrder = [];
        var toClear = [];
        state[tabName].applied.forEach(function (rec, name) {
            if (rec.silent) toClear.push(name);
        });
        for (var i = 0; i < toClear.length; i++) {
            unapplyStyle(tabName, toClear[i]);
        }
    }

    function postClearSelectionToIframes() {
        ["sg-frame-txt2img", "sg-frame-img2img"].forEach(function (id) {
            var fr = document.getElementById(id);
            if (fr && fr.contentWindow) {
                fr.contentWindow.postMessage({ type: "SG_CLEAR_SELECTION" }, "*");
            }
        });
    }

   // THUMBNAILS (batch / generate / upload — context menu entry points below)
   var _batchState = { running: false, cancelled: false, skipped: false };

   function startBatchThumbnails(tabName, catName, styles) {
       if (_batchState.running) {
           showStatusMessage(tabName, "Batch generation already running", true);
           return;
       }

       var queue = styles.filter(function (s) {
           return !state[tabName].hasThumbnail.has(s.name);
       });
       if (queue.length === 0) {
           showStatusMessage(tabName, "All styles already have previews");
           return;
       }

       _batchState = { running: true, cancelled: false, skipped: false };
       var total = queue.length;
       var done = 0;
       var failed = 0;
       var skipped = 0;

       // Build modal
       var overlay = el("div", { className: "sg-editor-overlay sg-batch-overlay" });
       var modal = el("div", { className: "sg-editor-modal" });
       var titleEl = el("h3", {
           className: "sg-editor-title",
           textContent: "🎨 Generating previews — " + catName
       });
       var progressText = el("div", {
           className: "sg-batch-progress-text",
           textContent: "Starting..."
       });
       var progressBar = el("div", { className: "sg-batch-bar-wrap" });
       var progressFill = el("div", { className: "sg-batch-bar-fill" });
       progressBar.appendChild(progressFill);

       var btnRow = el("div", { className: "sg-editor-btns" });
       var skipBtn = el("button", {
           className: "sg-btn sg-btn-secondary",
           textContent: "⏭ Skip",
           onClick: function () { _batchState.skipped = true; }
       });
       var cancelBtn = el("button", {
           className: "sg-btn",
           style: "background:#dc2626; border-color:#dc2626; color:#fff;",
           textContent: "✕ Cancel",
           onClick: function () {
               _batchState.cancelled = true;
               cancelBtn.textContent = "Cancelling...";
               cancelBtn.disabled = true;
           }
       });
       btnRow.appendChild(skipBtn);
       btnRow.appendChild(cancelBtn);

       modal.appendChild(titleEl);
       modal.appendChild(progressText);
       modal.appendChild(progressBar);
       modal.appendChild(btnRow);
       overlay.appendChild(modal);
       // Do NOT close on overlay click — only Cancel
       document.body.appendChild(overlay);

       function updateProgress(current, styleName, status) {
           var pct = Math.round((current / total) * 100);
           progressFill.style.width = pct + "%";
           progressText.textContent = current + " / " + total +
               (styleName ? " — " + styleName.split("_").slice(1).join(" ") : "") +
               (status ? " (" + status + ")" : "");
       }

       function processNext(index) {
           if (_batchState.cancelled || index >= queue.length) {
               // Finished
               _batchState.running = false;
               overlay.remove();
               var msg = "Done: " + done + "/" + total + " generated";
               if (failed > 0) msg += ", " + failed + " failed";
               if (skipped > 0) msg += ", " + skipped + " skipped";
               showStatusMessage(tabName, msg);
               loadThumbnailList(tabName);
               return;
           }

           var styleName = queue[index].name;
           _batchState.skipped = false;
           updateProgress(index + 1, styleName, "generating...");

           apiPost("/style_grid/thumbnail/generate", { name: styleName })
               .then(function (r) {
                   if (r.error) {
                       if (r.error.indexOf("busy") !== -1) {
                           // SD busy — wait and retry same index
                           updateProgress(index + 1, styleName, "SD busy, waiting...");
                           setTimeout(function () { processNext(index); }, 5000);
                           return;
                       }
                       failed++;
                       processNext(index + 1);
                       return;
                   }
                   pollBatchStatus(tabName, styleName, index, 0);
               })
               .catch(function () {
                   failed++;
                   processNext(index + 1);
               });
       }

       function pollBatchStatus(tabName2, styleName, index, attempts) {
           if (_batchState.cancelled) {
               _batchState.running = false;
               overlay.remove();
               showStatusMessage(tabName2, "Cancelled. " + done + "/" + total + " completed.");
               loadThumbnailList(tabName2);
               return;
           }
           if (_batchState.skipped) {
               skipped++;
               processNext(index + 1);
               return;
           }
           if (attempts > 60) {
               failed++;
               processNext(index + 1);
               return;
           }

           apiGet("/style_grid/thumbnail/gen_status?name=" +
               encodeURIComponent(styleName))
               .then(function (r) {
                   if (!r || r.detail === "Not Found" || r.status === undefined) {
                       failed++;
                       processNext(index + 1);
                       return;
                   }
                   if (r.status === "done") {
                       done++;
                       state[tabName2].hasThumbnail.add(styleName);
                       _thumbVersions[styleName] = Date.now();
                       localStorage.setItem("sg_thumb_v_" + styleName, _thumbVersions[styleName].toString());
                       _saveThumbVersions();
                       qsa('.sg-card[data-style-name="' +
                           CSS.escape(styleName) + '"]', state[tabName2].panel)
                           .forEach(function (c) { c.classList.add("sg-has-thumb"); });
                       updateProgress(index + 1, styleName, "✓");
                       setTimeout(function () { processNext(index + 1); }, 300);
                   } else if (r.status === "error") {
                       failed++;
                       processNext(index + 1);
                   } else {
                       setTimeout(function () {
                           pollBatchStatus(tabName2, styleName, index, attempts + 1);
                       }, 2000);
                   }
               })
               .catch(function () {
                   failed++;
                   processNext(index + 1);
               });
       }

       processNext(0);
   }

   function generateThumbnail(tabName, styleName, onDone, onProgress) {
        showStatusMessage(tabName, "🎨 Generating preview for " +
            styleName.split("_").slice(1).join(" ") + "...");
        if (typeof onProgress === "function") {
            onProgress("generating", 0);
        }

        apiPost("/style_grid/thumbnail/generate", { name: styleName, source: state[tabName].selectedSource || "" })
            .then(function (r) {
                if (r.error) {
                    showStatusMessage(tabName, "Generation failed: " + r.error, true);
                    if (typeof onProgress === "function") {
                        onProgress("error");
                    }
                    return;
                }
                pollGenerationStatus(tabName, styleName, 0, onDone, onProgress);
            })
            .catch(function () {
                showStatusMessage(tabName, "Generation failed", true);
                if (typeof onProgress === "function") {
                    onProgress("error");
                }
            });
    }

    function pollGenerationStatus(tabName, styleName, attempts, onDone, onProgress) {
        if (attempts > 60) {
            showStatusMessage(tabName, "Generation timed out", true);
            if (typeof onProgress === "function") {
                onProgress("error");
            }
            return;
        }
        apiGet("/style_grid/thumbnail/gen_status?name=" +
            encodeURIComponent(styleName))
            .then(function (r) {
                if (!r || r.detail === "Not Found" || r.status === undefined) {
                    showStatusMessage(tabName, "Generation endpoint not found", true);
                    if (typeof onProgress === "function") {
                        onProgress("error");
                    }
                    return;
                }
                if (r.status === "done") {
                    state[tabName].hasThumbnail.add(styleName);
                    _thumbVersions[styleName] = Date.now();
                    localStorage.setItem("sg_thumb_v_" + styleName, _thumbVersions[styleName].toString());
                    _saveThumbVersions();
                    qsa('.sg-card[data-style-name="' +
                        CSS.escape(styleName) + '"]',
                        state[tabName].panel)
                        .forEach(function (c) {
                            c.classList.add("sg-has-thumb");
                        });
                    showStatusMessage(tabName, "✓ Preview ready!");
                    if (typeof onProgress === "function") {
                        onProgress("done", 100);
                    }
                    if (typeof onDone === "function") onDone(_thumbVersions[styleName]);
                } else if (r.status === "error") {
                    showStatusMessage(tabName,
                        "Generation failed: " + (r.message || "unknown"), true);
                    if (typeof onProgress === "function") {
                        onProgress("error");
                    }
                } else if (r.status === "running" || r.status === "idle") {
                    if (typeof onProgress === "function") {
                        onProgress("generating", Math.min(90, Math.round((attempts / 60) * 100)));
                    }
                    setTimeout(function () {
                        pollGenerationStatus(tabName, styleName, attempts + 1, onDone, onProgress);
                    }, 2000);
                } else {
                    showStatusMessage(tabName, "Unknown generation status: " + r.status, true);
                    if (typeof onProgress === "function") {
                        onProgress("error");
                    }
                }
            })
            .catch(function () {
                showStatusMessage(tabName, "Generation status unavailable", true);
                if (typeof onProgress === "function") {
                    onProgress("error");
                }
            });
    }

    function prepareThumbnailData(file) {
        return new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onerror = function () { reject(new Error("Unable to read image")); };
            reader.onload = function () {
                var image = new Image();
                image.onerror = function () { reject(new Error("Unable to decode image")); };
                image.onload = function () {
                    var size = 512;
                    var canvas = document.createElement("canvas");
                    canvas.width = size;
                    canvas.height = size;
                    var ctx = canvas.getContext("2d");
                    if (!ctx) {
                        reject(new Error("Canvas unavailable"));
                        return;
                    }
                    var scale = Math.max(size / image.naturalWidth, size / image.naturalHeight);
                    var width = image.naturalWidth * scale;
                    var height = image.naturalHeight * scale;
                    ctx.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
                    resolve(canvas.toDataURL("image/webp", 0.9));
                };
                image.src = reader.result;
            };
            reader.readAsDataURL(file);
        });
    }
    function syncTemporaryWildcardInput(tab) {
        var elemId = "style_grid_temp_wildcards_" + tab;
        var input = gradioApp().querySelector("#" + elemId + " textarea");
        if (!input) return;
        var pools = state[tab].temporaryWildcards || {};
        var serialized = JSON.stringify(pools);
        if (input.value !== serialized) {
            input.value = serialized;
            input.dispatchEvent(new Event("input", { bubbles: true }));
        }
    }

    function uploadThumbnail(tabName, styleName, isPreset) {
        var input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.addEventListener("change", function () {
            var file = input.files[0];
            if (!file) return;
            prepareThumbnailData(file).then(function (imageData) {
                apiPost(isPreset ? "/style_grid/preset-thumbnail/upload" : "/style_grid/thumbnail/upload", {
                    name: styleName,
                    image: imageData
                })
                    .then(function (r) {
                        if (r.ok) {
                            if (!isPreset) {
                                state[tabName].hasThumbnail.add(styleName);
                                qsa('.sg-card[data-style-name="' +
                                    CSS.escape(styleName) + '"]',
                                    state[tabName].panel)
                                    .forEach(function (c) {
                                        c.classList.add("sg-has-thumb");
                                    });
                            }
                            var version = Date.now();
                            if (!isPreset) _thumbVersions[styleName] = version;
                            localStorage.setItem((isPreset ? "sg_preset_thumb_v_" : "sg_thumb_v_") + styleName, version.toString());
                            if (!isPreset) _saveThumbVersions();
                            var sgFrame = document.getElementById("sg-frame-" + tabName);
                            if (sgFrame && sgFrame.contentWindow) {
                                sgFrame.contentWindow.postMessage({
                                    type: "SG_THUMB_DONE",
                                    styleId: styleName,
                                    version: version,
                                    preset: isPreset === true,
                                    imageData: isPreset ? imageData : undefined
                                }, "*");
                            }
                            showStatusMessage(tabName, "Preview saved ✓");
                        } else {
                            showStatusMessage(tabName,
                                "Upload failed: " + (r.error || "?"), true);
                        }
                    })
                    .catch(function () {
                        showStatusMessage(tabName, "Upload failed", true);
                    });
            }).catch(function (err) {
                showStatusMessage(tabName, "Upload failed: " + (err.message || "invalid image"), true);
            });
        });
        input.click();
    }

    // ════════════════════════════════════════════════════
    // UI: EDITOR / CONTEXT MENU
    // ════════════════════════════════════════════════════
    function showContextMenu(e, tabName, styleName, style) {
        e.preventDefault();
        // Remove existing
        const old = qs(".sg-context-menu");
        if (old) old.remove();

        const menu = el("div", { className: "sg-context-menu" });
        menu.style.left = e.clientX + "px";
        menu.style.top = e.clientY + "px";

        const items = [
            { label: "✏️ Edit style", action: function () { openStyleEditor(tabName, style); } },
            { label: "Replace from prompt box...", action: function () { replaceStyleFromPrompt(tabName, style); } },
            { label: "📋 Duplicate", action: function () { duplicateStyle(tabName, style); } },
            { label: "🗑️ Delete", action: function () { deleteStyle(tabName, styleName, style.source); } },
            { label: "📂 Move to category...", action: function () { moveToCategory(tabName, style); } },
            { label: "📎 Copy prompt", action: function () { navigator.clipboard.writeText(style.prompt || ""); } },
        ];

        items.push({
            label: "🎨 Generate preview (SD)",
            action: function () { generateThumbnail(tabName, styleName); }
        });

        items.push({
            label: "🖼️ Upload preview image",
            action: function () { uploadThumbnail(tabName, styleName); }
        });

        items.forEach(function (item) {
            const btn = el("div", { className: "sg-ctx-item", textContent: item.label, onClick: function () { menu.remove(); item.action(); } });
            menu.appendChild(btn);
        });

        document.body.appendChild(menu);
        // Clamp position to viewport
        const rect = menu.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        let x = parseFloat(menu.style.left) || e.clientX;
        let y = parseFloat(menu.style.top) || e.clientY;

        if (x + rect.width > vw) x = vw - rect.width - 8;
        if (y + rect.height > vh) y = vh - rect.height - 8;
        if (x < 8) x = 8;
        if (y < 8) y = 8;

        menu.style.left = x + "px";
        menu.style.top = y + "px";

        // Auto-close
        setTimeout(function () {
            const close = function () { menu.remove(); document.removeEventListener("click", close); };
            document.addEventListener("click", close);
        }, 0);
    }

    // -----------------------------------------------------------------------
    // Style editor modal
    // -----------------------------------------------------------------------
    function openStyleEditor(tabName, existingStyle, sourceFile) {
        const isNew = !existingStyle;
        const overlay = el("div", { className: "sg-editor-overlay" });
        const modal = el("div", { className: "sg-editor-modal" });

        const title = el("h3", { textContent: isNew ? "Create New Style" : "Edit Style: " + (existingStyle ? existingStyle.name : ""), className: "sg-editor-title" });
        modal.appendChild(title);

        const nameInput = el("input", { className: "sg-editor-input", type: "text", placeholder: "Style name (e.g. BODY_Thicc)", value: existingStyle ? existingStyle.name : "" });
        const promptInput = el("textarea", { className: "sg-editor-textarea", placeholder: "Prompt (use {prompt} as placeholder)", rows: "4" });
        promptInput.value = existingStyle ? (existingStyle.prompt || "") : "";
        const negInput = el("textarea", { className: "sg-editor-textarea", placeholder: "Negative prompt", rows: "3" });
        negInput.value = existingStyle ? (existingStyle.negative_prompt || "") : "";

        modal.appendChild(el("label", { className: "sg-editor-label", textContent: "Name" }));
        modal.appendChild(nameInput);
        modal.appendChild(el("label", { className: "sg-editor-label", textContent: "Prompt" }));
        modal.appendChild(promptInput);
        modal.appendChild(el("label", { className: "sg-editor-label", textContent: "Negative Prompt" }));
        modal.appendChild(negInput);

        var descInput = el("textarea", {
            className: "sg-editor-textarea",
            placeholder: "Description. Use 'Combos: STYLE_X; CATEGORY_*' for recommendations.",
            rows: "3"
        });
        descInput.value = existingStyle ? (existingStyle.description || "") : "";

        modal.appendChild(el("label", {
            className: "sg-editor-label",
            textContent: "Description & Combos"
        }));
        modal.appendChild(descInput);

        const btnRow = el("div", { className: "sg-editor-btns" });
        btnRow.appendChild(el("button", {
            className: "sg-btn sg-btn-primary", textContent: "💾 Save",
            onClick: function () {
                const name = nameInput.value.trim();
                if (!name) { nameInput.style.borderColor = "#f87171"; return; }
                apiPost("/style_grid/style/save", {
                    name: name,
                    prompt: promptInput.value,
                    negative_prompt: negInput.value,
                    description: descInput.value,
                    source: existingStyle ? existingStyle.source : (sourceFile || null),
                }).then(assertNoApiError).then(function () {
                    overlay.remove();
                    refreshPanel(tabName);
                    var notify = state[tabName] && state[tabName].refreshAndNotifyFrame;
                    if (typeof notify === "function") notify();
                }).catch(function () {
                    showStatusMessage(tabName, "Save failed", true);
                });
            }
        }));
        btnRow.appendChild(el("button", {
            className: "sg-btn sg-btn-secondary", textContent: "Cancel",
            onClick: function () { overlay.remove(); }
        }));
        modal.appendChild(btnRow);
        overlay.appendChild(modal);
        var editorOverlayMouseDownTarget = null;
        overlay.addEventListener("mousedown", function (e) {
            editorOverlayMouseDownTarget = e.target;
        });
        overlay.addEventListener("click", function (e) {
            if (editorOverlayMouseDownTarget === overlay || editorOverlayMouseDownTarget === e.currentTarget) {
                overlay.remove();
            }
            editorOverlayMouseDownTarget = null;
        });
        document.body.appendChild(overlay);
        nameInput.focus();
    }


    /*
CSV table editor — full implementation kept for restoration; currently inactive.

    var CSV_TABLE_FIELDS = ["name", "prompt", "negative_prompt", "description", "category"];

    function isAllSourcesSourceFilter(value, domLabelTrimmed) {
        if (value == null || value === "") return true;
        var s = String(value);
        if (s === "All" || s === "all" || s === "All Sources" || s === "__all__") return true;
        if (domLabelTrimmed === "All Sources") return true;
        return false;
    }

    function getEffectiveCsvEditorSourceAtClick(tabName) {
        // getStoredSource is the only reliable source of truth —
        // state may be stale if _buildSourceList ran after the last pick.
        var stored = getStoredSource(tabName);
        var selectedSource = (stored && stored !== "" && stored !== "All") ? stored : "All";
        return { selectedSource: selectedSource, domText: selectedSource };
    }

    function openCsvTableEditor(tabName) {
        var eff = getEffectiveCsvEditorSourceAtClick(tabName);
        var selectedSource = eff.selectedSource;
        if (isAllSourcesSourceFilter(selectedSource, eff.domText)) {
            alert("Choose a single CSV in the source filter (not “All Sources”) to edit that file as a table.");
            return;
        }
        var rows = [];
        Object.values(state[tabName].categories || {}).forEach(function (arr) {
            arr.forEach(function (s) {
                if (s.source === selectedSource) {
                    rows.push({
                        name: s.name || "",
                        prompt: s.prompt || "",
                        negative_prompt: s.negative_prompt || "",
                        description: s.description || "",
                        category: (s.category_explicit !== null && s.category_explicit !== undefined && String(s.category_explicit).trim() !== "")
                            ? String(s.category_explicit).trim()
                            : (s.category || ""),
                        source: s.source || selectedSource,
                    });
                }
            });
        });
        rows.sort(function (a, b) { return (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" }); });

        var baselineRows = rows.map(function (r) {
            var o = {};
            CSV_TABLE_FIELDS.forEach(function (f) { o[f] = (r[f] !== null && r[f] !== undefined) ? String(r[f]) : ""; });
            o.source = r.source;
            return o;
        });
        var rowModels = baselineRows.map(function (r) {
            var o = {};
            CSV_TABLE_FIELDS.forEach(function (f) { o[f] = r[f]; });
            o.source = r.source;
            return o;
        });
        var dirty = {};

        function hasTableUnsavedChanges() {
            recomputeDirty();
            return Object.keys(dirty).length > 0;
        }

        function closeCsvEditorOverlay() {
            overlay.remove();
        }

        function requestCloseCsvEditor() {
            if (hasTableUnsavedChanges()) {
                if (!confirm("Close the table editor? Unsaved changes will be lost.")) return;
            }
            closeCsvEditorOverlay();
        }

        function recomputeDirty() {
            dirty = {};
            rowModels.forEach(function (rm, i) {
                var base = i < baselineRows.length ? baselineRows[i] : null;
                var empty = { name: "", prompt: "", negative_prompt: "", description: "", category: "" };
                var ref = base || empty;
                CSV_TABLE_FIELDS.forEach(function (f) {
                    if (String(rm[f] !== null && rm[f] !== undefined ? rm[f] : "") !== String(ref[f] !== null && ref[f] !== undefined ? ref[f] : "")) {
                        if (!dirty[i]) dirty[i] = {};
                        dirty[i][f] = rm[f];
                    }
                });
            });
        }

        function refreshDirtyUi() {
            recomputeDirty();
            qsa("tr.sg-csv-data-row", tbody).forEach(function (tr) {
                var ri = parseInt(tr.getAttribute("data-row-index"), 10);
                tr.classList.toggle("sg-csv-dirty", !!dirty[ri]);
            });
        }

        var overlay = el("div", { className: "sg-csv-editor-overlay" });
        var shell = el("div", { className: "sg-csv-editor-shell" });

        var topBar = el("div", { className: "sg-csv-editor-topbar" });
        topBar.appendChild(el("h2", {
            className: "sg-csv-editor-title",
            textContent: "Edit CSV — " + selectedSource,
        }));
        var closeTop = el("button", {
            type: "button",
            className: "sg-btn sg-csv-editor-close",
            textContent: "✕",
            title: "Close",
            onClick: function () { requestCloseCsvEditor(); },
        });
        topBar.appendChild(closeTop);
        shell.appendChild(topBar);

        var toolRow = el("div", { className: "sg-csv-editor-toolbar" });
        var filterInputs = {};
        function clearFilters() {
            Object.keys(filterInputs).forEach(function (k) {
                filterInputs[k].value = "";
            });
            applyFilters();
        }
        toolRow.appendChild(el("button", {
            type: "button",
            className: "sg-btn sg-btn-primary",
            textContent: "💾 Save Changes",
            onClick: function () {
                recomputeDirty();
                var indices = Object.keys(dirty).map(function (x) { return parseInt(x, 10); }).filter(function (i) { return !isNaN(i); });
                if (indices.length === 0) {
                    alert("No changes to save.");
                    return;
                }
                indices.sort(function (a, b) { return a - b; });
                var v;
                for (v = 0; v < indices.length; v++) {
                    var vi = indices[v];
                    if (!(rowModels[vi].name || "").trim()) {
                        alert("Row " + (vi + 1) + ": name is required.");
                        return;
                    }
                }
                var usedNames = Object.create(null);
                var u;
                for (u = 0; u < rowModels.length; u++) {
                    var un = (rowModels[u].name || "").trim();
                    if (!un) continue;
                    if (usedNames[un]) {
                        alert("Duplicate style name \"" + un + "\". Each row must have a unique name before saving.");
                        return;
                    }
                    usedNames[un] = true;
                }
                var totalDirty = indices.length;
                var savedCount = 0;
                clearSaveStatusUi();
                indices.forEach(function (idx) {
                    setRowSaveStatus(idx, "pending", "Pending");
                });
                var chain = Promise.resolve();
                indices.forEach(function (i) {
                    var rm = rowModels[i];
                    var orig = i < baselineRows.length ? baselineRows[i] : null;
                    var nameTrim = (rm.name || "").trim();
                    var src = (orig && orig.source) || selectedSource;
                    chain = chain.then(function () {
                        setRowSaveStatus(i, "saving", "Saving…");
                        var savePromise;
                        if (orig && orig.name !== nameTrim) {
                            savePromise = apiPost("/style_grid/style/delete", { name: orig.name, source: orig.source || selectedSource })
                                .then(assertNoApiError)
                                .then(function () {
                                    return apiPost("/style_grid/style/save", {
                                        name: nameTrim,
                                        prompt: rm.prompt || "",
                                        negative_prompt: rm.negative_prompt || "",
                                        description: rm.description || "",
                                        category: rm.category || "",
                                        source: src,
                                    }).then(assertNoApiError);
                                });
                        } else {
                            savePromise = apiPost("/style_grid/style/save", {
                                name: nameTrim,
                                prompt: rm.prompt || "",
                                negative_prompt: rm.negative_prompt || "",
                                description: rm.description || "",
                                category: rm.category || "",
                                source: src,
                            }).then(assertNoApiError);
                        }
                        return savePromise.then(function () {
                            savedCount++;
                            setRowSaveStatus(i, "saved", "✓ saved");
                        }).catch(function (err) {
                            setRowSaveStatus(i, "error", "✗ error");
                            var msg = (err && err.message) ? err.message : "unknown error";
                            var wrapped = new Error(msg);
                            wrapped._sgCsvSaved = savedCount;
                            wrapped._sgCsvTotal = totalDirty;
                            wrapped._sgCsvRowName = nameTrim;
                            throw wrapped;
                        });
                    });
                });
                chain.then(function () {
                    closeCsvEditorOverlay();
                    refreshPanel(tabName);
                    var notify = state[tabName] && state[tabName].refreshAndNotifyFrame;
                    if (typeof notify === "function") notify();
                }).catch(function (e) {
                    var x = (e && e._sgCsvSaved !== null && e._sgCsvSaved !== undefined) ? e._sgCsvSaved : 0;
                    var n = (e && e._sgCsvTotal !== null && e._sgCsvTotal !== undefined) ? e._sgCsvTotal : totalDirty;
                    var nm = (e && e._sgCsvRowName) ? e._sgCsvRowName : "?";
                    var msg = (e && e.message) ? e.message : "unknown error";
                    alert("Saved " + x + " of " + n + " rows. Row \"" + nm + "\" failed: " + msg + ". Rows above are written to disk.");
                });
            },
        }));
        toolRow.appendChild(el("button", {
            type: "button",
            className: "sg-btn sg-btn-secondary",
            textContent: "Discard",
            onClick: function () {
                rowModels = baselineRows.map(function (r) {
                    var o = {};
                    CSV_TABLE_FIELDS.forEach(function (f) { o[f] = r[f]; });
                    o.source = r.source;
                    return o;
                });
                renderTableBody();
                recomputeDirty();
                refreshDirtyUi();
            },
        }));
        toolRow.appendChild(el("button", {
            type: "button",
            className: "sg-btn sg-btn-secondary",
            textContent: "➕ Add Row",
            onClick: function () {
                rowModels.push({
                    name: "",
                    prompt: "",
                    negative_prompt: "",
                    description: "",
                    category: "",
                    source: selectedSource,
                });
                renderTableBody();
                refreshDirtyUi();
            },
        }));
        toolRow.appendChild(el("button", {
            type: "button",
            className: "sg-btn sg-btn-secondary",
            textContent: "Clear filters",
            onClick: function () { clearFilters(); },
        }));
        shell.appendChild(toolRow);

        var filterRowWrap = el("div", { className: "sg-csv-editor-filters" });
        var filterTable = el("table", { className: "sg-csv-editor-filter-table" });
        var filterTr = el("tr");
        filterTr.appendChild(el("th", { className: "sg-csv-col-actions" }));
        filterTr.appendChild(el("th", { className: "sg-csv-col-status" }));
        CSV_TABLE_FIELDS.forEach(function (f) {
            var th = el("th");
            var inp = el("input", {
                type: "text",
                className: "sg-csv-filter-input",
                placeholder: "Filter " + f.replace(/_/g, " ") + "…",
            });
            filterInputs[f] = inp;
            inp.addEventListener("input", function () { applyFilters(); });
            th.appendChild(inp);
            filterTr.appendChild(th);
        });
        var filterThead = el("thead");
        filterThead.appendChild(filterTr);
        filterTable.appendChild(filterThead);
        filterRowWrap.appendChild(filterTable);
        shell.appendChild(filterRowWrap);

        var scroll = el("div", { className: "sg-csv-editor-scroll" });
        var dataTable = el("table", { className: "sg-csv-editor-table" });
        var thead = el("thead");
        var headTr = el("tr");
        headTr.appendChild(el("th", { className: "sg-csv-col-actions", textContent: "" }));
        headTr.appendChild(el("th", { className: "sg-csv-col-status", textContent: "Status" }));
        headTr.appendChild(el("th", { textContent: "Name" }));
        headTr.appendChild(el("th", { textContent: "Prompt" }));
        headTr.appendChild(el("th", { textContent: "Negative Prompt" }));
        headTr.appendChild(el("th", { textContent: "Description" }));
        headTr.appendChild(el("th", { textContent: "Category" }));
        thead.appendChild(headTr);
        dataTable.appendChild(thead);
        var tbody = el("tbody");
        dataTable.appendChild(tbody);
        scroll.appendChild(dataTable);
        shell.appendChild(scroll);

        function clearSaveStatusUi() {
            qsa("tr.sg-csv-data-row", tbody).forEach(function (tr) {
                tr.classList.remove("sg-csv-save-pending", "sg-csv-save-saving", "sg-csv-save-ok", "sg-csv-save-err");
                var st = tr.querySelector(".sg-csv-save-status-text");
                if (st) st.textContent = "";
            });
        }

        function setRowSaveStatus(rowIndex, phase, label) {
            var tr = tbody.querySelector('tr.sg-csv-data-row[data-row-index="' + rowIndex + '"]');
            if (!tr) return;
            tr.classList.remove("sg-csv-save-pending", "sg-csv-save-saving", "sg-csv-save-ok", "sg-csv-save-err");
            if (phase === "pending") tr.classList.add("sg-csv-save-pending");
            else if (phase === "saving") tr.classList.add("sg-csv-save-saving");
            else if (phase === "saved") tr.classList.add("sg-csv-save-ok");
            else if (phase === "error") tr.classList.add("sg-csv-save-err");
            var st = tr.querySelector(".sg-csv-save-status-text");
            if (st) st.textContent = (label !== null && label !== undefined) ? label : "";
        }

        function applyFilters() {
            qsa("tr.sg-csv-data-row", tbody).forEach(function (tr) {
                var show = true;
                CSV_TABLE_FIELDS.forEach(function (f) {
                    var q = (filterInputs[f].value || "").trim().toLowerCase();
                    if (!q) return;
                    var cell = tr.querySelector('.sg-csv-cell--' + f + ' .sg-csv-cell-input');
                    var val = cell ? (cell.value || "").toLowerCase() : "";
                    if (val.indexOf(q) === -1) show = false;
                });
                tr.style.display = show ? "" : "none";
            });
        }

        function focusNextCell(elInput) {
            var all = Array.prototype.slice.call(tbody.querySelectorAll("input.sg-csv-cell-input, textarea.sg-csv-cell-input"));
            var idx = all.indexOf(elInput);
            if (idx === -1) return;
            var j = idx + 1;
            while (j < all.length) {
                var next = all[j];
                var tr = next.closest && next.closest("tr");
                if (tr && tr.style.display !== "none") {
                    next.focus();
                    if (next.select) next.select();
                    return;
                }
                j++;
            }
        }

        function deleteRowAt(rowIndex) {
            var rm = rowModels[rowIndex];
            if (rowIndex < baselineRows.length) {
                if (!confirm("Delete style \"" + (rm.name || "") + "\" from CSV?")) return;
                apiPost("/style_grid/style/delete", { name: baselineRows[rowIndex].name, source: baselineRows[rowIndex].source || selectedSource })
                    .then(assertNoApiError)
                    .then(function () {
                        rowModels.splice(rowIndex, 1);
                        baselineRows.splice(rowIndex, 1);
                        renderTableBody();
                        refreshDirtyUi();
                    })
                    .catch(function () {
                        alert("Delete failed");
                    });
            } else {
                rowModels.splice(rowIndex, 1);
                renderTableBody();
                refreshDirtyUi();
            }
        }

        function renderTableBody() {
            tbody.innerHTML = "";
            rowModels.forEach(function (rm, rowIdx) {
                var tr = el("tr", { className: "sg-csv-data-row", "data-row-index": String(rowIdx) });
                tr.addEventListener("contextmenu", function (e) {
                    e.preventDefault();
                    var prevMenu = qs(".sg-context-menu");
                    if (prevMenu) prevMenu.remove();
                    var menu = el("div", { className: "sg-context-menu" });
                    menu.style.left = e.clientX + "px";
                    menu.style.top = e.clientY + "px";
                    menu.appendChild(el("div", {
                        className: "sg-ctx-item",
                        textContent: "🗑️ Delete row",
                        onClick: function () {
                            menu.remove();
                            deleteRowAt(rowIdx);
                        },
                    }));
                    document.body.appendChild(menu);
                    setTimeout(function () {
                        var close = function () { menu.remove(); document.removeEventListener("click", close); };
                        document.addEventListener("click", close);
                    }, 0);
                });

                var tdAct = el("td", { className: "sg-csv-col-actions" });
                var delBtn = el("button", {
                    type: "button",
                    className: "sg-csv-row-del",
                    textContent: "×",
                    title: "Delete row",
                    onClick: function (ev) {
                        ev.stopPropagation();
                        deleteRowAt(rowIdx);
                    },
                });
                tdAct.appendChild(delBtn);
                tr.appendChild(tdAct);

                var tdSaveSt = el("td", { className: "sg-csv-col-status" });
                tdSaveSt.appendChild(el("span", { className: "sg-csv-save-status-text" }));
                tr.appendChild(tdSaveSt);

                CSV_TABLE_FIELDS.forEach(function (field) {
                    var isLong = field === "prompt" || field === "negative_prompt";
                    var td = el("td", { className: "sg-csv-cell sg-csv-cell--" + field });
                    var inp = isLong
                        ? el("textarea", { className: "sg-csv-cell-input", rows: field === "prompt" ? 4 : 3 })
                        : el("input", { type: "text", className: "sg-csv-cell-input" });
                    inp.value = (rm[field] !== null && rm[field] !== undefined) ? String(rm[field]) : "";
                    inp.setAttribute("data-row", String(rowIdx));
                    inp.setAttribute("data-field", field);
                    inp.addEventListener("input", function () {
                        rowModels[rowIdx][field] = inp.value;
                        refreshDirtyUi();
                    });
                    inp.addEventListener("keydown", function (e) {
                        if (e.key === "Tab" && !e.shiftKey) {
                            e.preventDefault();
                            focusNextCell(inp);
                        }
                    });
                    td.appendChild(inp);
                    tr.appendChild(td);
                });
                tbody.appendChild(tr);
            });
            applyFilters();
            refreshDirtyUi();
        }

        renderTableBody();
        overlay.appendChild(shell);
        var csvOverlayMouseDownTarget = null;
        overlay.addEventListener("mousedown", function (e) {
            csvOverlayMouseDownTarget = e.target;
        });
        overlay.addEventListener("click", function (e) {
            if (csvOverlayMouseDownTarget === overlay || csvOverlayMouseDownTarget === e.currentTarget) {
                requestCloseCsvEditor();
            }
            csvOverlayMouseDownTarget = null;
        });
        document.body.appendChild(overlay);
    }
    */

    function openCsvTableEditor(tabName) {
        void tabName;
    }


    function duplicateStyle(tabName, style, onDone) {
        const newName = style.name + "_copy";
        apiPost("/style_grid/style/save", {
            name: newName,
            prompt: style.prompt || "",
            negative_prompt: style.negative_prompt || "",
            description: style.description || "",
            category: style.category || "",
            organizer_tags: style.organizer_tags || [],
            source: style.source,
        }).then(assertNoApiError).then(function () {
            refreshPanel(tabName);
            var notify = state[tabName] && state[tabName].refreshAndNotifyFrame;
            if (typeof notify === "function") notify();
            if (typeof onDone === "function") onDone();
        }).catch(function () {});
    }

    function replaceStyleFromPrompt(tabName, style, onDone) {
        replaceSavedPromptFromPromptBox(tabName, {
            kind: "style",
            name: style.name,
            source: style.source_file || style.source || null
        }, onDone);
    }

    function replacePresetFromPrompt(tabName, presetName, onDone) {
        replaceSavedPromptFromPromptBox(tabName, {
            kind: "preset",
            name: presetName
        }, onDone);
    }

    function replaceSavedPromptFromPromptBox(tabName, target, onDone) {
        const promptEl = qs("#" + tabName + "_prompt textarea");
        const negEl = qs("#" + tabName + "_neg_prompt textarea");
        if (!promptEl || !negEl) {
            showStatusMessage(tabName, "Could not read the prompt boxes", true);
            return;
        }

        const replacementPrompt = promptEl.value || "";
        const replacementNegative = negEl.value || "";
        if (!replacementPrompt.trim() && !replacementNegative.trim()) {
            showStatusMessage(tabName, "Both prompt boxes are empty", true);
            return;
        }

        const overlay = el("div", { className: "sg-editor-overlay" });
        const modal = el("div", { className: "sg-editor-modal" });
        modal.appendChild(el("h3", {
            className: "sg-editor-title",
            textContent: "Replace saved prompt?"
        }));
        modal.appendChild(el("p", {
            textContent: target.kind === "preset"
                ? "Update preset \"" + target.name + "\" from the current " + tabName + " prompt boxes. Its name, categories, assigned image, and other metadata will be kept."
                : "Update style \"" + target.name + "\" from the current " + tabName + " prompt boxes. Its name, category, description, source, and preview will be kept.",
            style: "font-size:13px; color: var(--body-text-color-subdued, #9ca3af);"
        }));

        const promptPreview = el("textarea", {
            className: "sg-editor-textarea",
            rows: "5",
            readonly: "readonly"
        });
        promptPreview.value = replacementPrompt;
        modal.appendChild(el("label", { className: "sg-editor-label", textContent: "New positive prompt" }));
        modal.appendChild(promptPreview);

        const negPreview = el("textarea", {
            className: "sg-editor-textarea",
            rows: "3",
            readonly: "readonly"
        });
        negPreview.value = replacementNegative;
        modal.appendChild(el("label", { className: "sg-editor-label", textContent: "New negative prompt" }));
        modal.appendChild(negPreview);

        const btns = el("div", { className: "sg-editor-btns" });
        btns.appendChild(el("button", {
            className: "sg-btn sg-btn-primary",
            textContent: "Replace",
            onClick: function () {
                const endpoint = target.kind === "preset"
                    ? "/style_grid/presets/replace"
                    : "/style_grid/style/replace";
                const payload = {
                    name: target.name,
                    prompt: replacementPrompt,
                    negative_prompt: replacementNegative
                };
                if (target.kind === "style") payload.source = target.source;
                apiPost(endpoint, payload).then(assertNoApiError).then(function (result) {
                    overlay.remove();
                    if (target.kind === "preset") {
                        state[tabName].presets = result.presets || state[tabName].presets || {};
                        var frame = document.getElementById("sg-frame-" + tabName);
                        if (frame && frame.contentWindow) {
                            frame.contentWindow.postMessage({ type: "SG_PRESETS_UPDATED" }, "*");
                        }
                    } else {
                        refreshPanel(tabName);
                        var notify = state[tabName] && state[tabName].refreshAndNotifyFrame;
                        if (typeof notify === "function") notify();
                    }
                    if (typeof onDone === "function") onDone();
                    showStatusMessage(tabName, target.kind === "preset" ? "Preset replaced ✓" : "Saved prompt replaced ✓");
                }).catch(function (err) {
                    showStatusMessage(tabName, "Replace failed: " + (err.message || "unknown error"), true);
                });
            }
        }));
        btns.appendChild(el("button", {
            className: "sg-btn sg-btn-secondary",
            textContent: "Cancel",
            onClick: function () { overlay.remove(); }
        }));
        modal.appendChild(btns);
        overlay.appendChild(modal);
        overlay.addEventListener("mousedown", function (event) {
            if (event.target === overlay) overlay.remove();
        });
        document.body.appendChild(overlay);
    }

    function deleteStyle(tabName, styleName, source, onDeleted) {
        const overlay = el("div", { className: "sg-editor-overlay" });
        const modal = el("div", { className: "sg-editor-modal" });
        modal.appendChild(el("h3", {
            className: "sg-editor-title",
            textContent: "Delete style?"
        }));
        modal.appendChild(el("p", {
            textContent: "\"" + styleName + "\" will be permanently removed from the CSV.",
            style: "font-size:13px; color: var(--body-text-color-subdued, #9ca3af);"
        }));
        const btns = el("div", { className: "sg-editor-btns" });
        btns.appendChild(el("button", {
            className: "sg-btn",
            style: "background:#dc2626; border-color:#dc2626; color:#fff;",
            textContent: "🗑️ Delete",
            onClick: function () {
                overlay.remove();
                apiPost("/style_grid/style/delete", { name: styleName, source: source })
                    .then(assertNoApiError)
                    .then(function () {
                        refreshPanel(tabName);
                        var notify = state[tabName] && state[tabName].refreshAndNotifyFrame;
                        if (typeof notify === "function") notify();
                        if (typeof onDeleted === "function") onDeleted();
                    })
                    .catch(function () {
                        showStatusMessage(tabName, "Delete failed", true);
                    });
            }
        }));
        btns.appendChild(el("button", {
            className: "sg-btn sg-btn-secondary",
            textContent: "Cancel",
            onClick: function () { overlay.remove(); }
        }));
        modal.appendChild(btns);
        overlay.appendChild(modal);
        var deleteOverlayMouseDownTarget = null;
        overlay.addEventListener("mousedown", function (e) {
            deleteOverlayMouseDownTarget = e.target;
        });
        overlay.addEventListener("click", function (e) {
            if (deleteOverlayMouseDownTarget === overlay || deleteOverlayMouseDownTarget === e.currentTarget) {
                overlay.remove();
            }
            deleteOverlayMouseDownTarget = null;
        });
        document.body.appendChild(overlay);
    }

    function moveToCategory(tabName, style, onDone) {
        const overlay = el("div", { className: "sg-editor-overlay" });
        const modal = el("div", { className: "sg-editor-modal" });

        modal.appendChild(el("h3", {
            className: "sg-editor-title",
            textContent: "Move to category"
        }));
        modal.appendChild(el("label", {
            className: "sg-editor-label",
            textContent: "New category name"
        }));
        const input = el("input", {
            className: "sg-editor-input",
            type: "text",
            value: style.category || "",
            placeholder: "New category name"
        });
        modal.appendChild(input);

        const btns = el("div", { className: "sg-editor-btns" });
        btns.appendChild(el("button", {
            className: "sg-btn sg-btn-primary",
            textContent: "Move",
            onClick: function () {
                const newCat = (input.value || "").trim();
                if (!newCat) { input.style.borderColor = "#f87171"; return; }
                const oldName = style.name;
                const rest = oldName.includes("_") ? oldName.split("_").slice(1).join("_") : oldName;
                const newName = newCat.toUpperCase() + "_" + rest;
                apiPost("/style_grid/style/delete", { name: oldName, source: style.source }).then(assertNoApiError).then(function () {
                    return apiPost("/style_grid/style/save", {
                        name: newName,
                        prompt: style.prompt,
                        negative_prompt: style.negative_prompt,
                        source: style.source
                    }).then(assertNoApiError);
                }).then(function () {
                    overlay.remove();
                    refreshPanel(tabName);
                    var notify = state[tabName] && state[tabName].refreshAndNotifyFrame;
                    if (typeof notify === "function") notify();
                    if (typeof onDone === "function") onDone();
                }).catch(function () {
                    showStatusMessage(tabName, "Move failed", true);
                });
            }
        }));
        btns.appendChild(el("button", {
            className: "sg-btn sg-btn-secondary",
            textContent: "Cancel",
            onClick: function () { overlay.remove(); }
        }));

        modal.appendChild(btns);
        overlay.appendChild(modal);
        var moveOverlayMouseDownTarget = null;
        overlay.addEventListener("mousedown", function (e) {
            moveOverlayMouseDownTarget = e.target;
        });
        overlay.addEventListener("click", function (e) {
            if (moveOverlayMouseDownTarget === overlay || moveOverlayMouseDownTarget === e.currentTarget) {
                overlay.remove();
            }
            moveOverlayMouseDownTarget = null;
        });
        document.body.appendChild(overlay);
    }

    function showBatchStyleCategoryDialog(tabName, styles, onSave) {
        const old = qs(".sg-style-batch-category-overlay");
        if (old) old.remove();

        const overlay = el("div", { className: "sg-editor-overlay sg-style-batch-category-overlay" });
        const modal = el("div", { className: "sg-editor-modal" });
        modal.appendChild(el("h3", {
            className: "sg-editor-title",
            textContent: "Edit category for " + styles.length + " styles"
        }));
        modal.appendChild(el("p", {
            className: "sg-preset-category-help",
            textContent: "All selected styles will move to this category. Names, prompts, descriptions, and source files stay unchanged."
        }));
        modal.appendChild(el("label", {
            className: "sg-editor-label",
            textContent: "Category name"
        }));

        const firstCategory = styles.length ? String(styles[0].category || "") : "";
        const sharedCategory = styles.every(function (style) {
            return String(style.category || "") === firstCategory;
        }) ? firstCategory : "";
        const listId = "sg-style-category-options-" + Date.now();
        const input = el("input", {
            className: "sg-editor-input",
            type: "text",
            value: sharedCategory,
            placeholder: "Category name",
            maxlength: "100",
            list: listId
        });
        modal.appendChild(input);

        const categoryNames = Object.keys((state[tabName] && state[tabName].categories) || {}).sort(function (a, b) {
            return a.localeCompare(b);
        });
        modal.appendChild(el("datalist", { id: listId }, categoryNames.map(function (category) {
            return el("option", { value: category });
        })));

        function closeDialog() {
            document.removeEventListener("keydown", onKeyDown);
            overlay.remove();
        }
        function submit() {
            const category = (input.value || "").trim();
            if (!category) {
                input.style.borderColor = "#f87171";
                input.focus();
                return;
            }
            closeDialog();
            onSave(category);
        }
        function onKeyDown(event) {
            if (event.key === "Escape") closeDialog();
            if (event.key === "Enter") {
                event.preventDefault();
                submit();
            }
        }

        const btns = el("div", { className: "sg-editor-btns" });
        btns.appendChild(el("button", {
            className: "sg-btn sg-btn-primary",
            textContent: "Apply to selected",
            onClick: submit
        }));
        btns.appendChild(el("button", {
            className: "sg-btn sg-btn-secondary",
            textContent: "Cancel",
            onClick: closeDialog
        }));
        modal.appendChild(btns);
        overlay.appendChild(modal);
        overlay.addEventListener("mousedown", function (event) {
            if (event.target === overlay) closeDialog();
        });
        document.addEventListener("keydown", onKeyDown);
        document.body.appendChild(overlay);
        input.focus();
        input.select();
    }

    // -----------------------------------------------------------------------
    // Presets UI
    // -----------------------------------------------------------------------
    function loadPreset(tabName, presetName) {
        var p = (state[tabName].presets || {})[presetName];
        if (!p) return;
        var sgFrame = document.getElementById("sg-frame-" + tabName);
        if (p.mode === "scene") {
            const scenePromptEl = qs("#" + tabName + "_prompt textarea");
            const sceneNegEl = qs("#" + tabName + "_neg_prompt textarea");
            if (!scenePromptEl || !sceneNegEl) return;
            clearAll(tabName);
            setPromptValue(scenePromptEl, typeof p.prompt === "string" ? p.prompt : "");
            setPromptValue(sceneNegEl, typeof p.negative_prompt === "string" ? p.negative_prompt : "");
            if (sgFrame && sgFrame.contentWindow) {
                sgFrame.contentWindow.postMessage({ type: "SG_CLEAR_SELECTION" }, "*");
                sgFrame.contentWindow.postMessage({
                    type: "SG_TOAST", message: "Scene loaded", variant: "success"
                }, "*");
            }
            return;
        }
        if (typeof p.prompt === "string" && p.prompt.length > 0) {
            const promptEl = qs("#" + tabName + "_prompt textarea");
            if (!promptEl) return;
            // Literal text templates keep their whitespace and Markdown markers.
            insertPromptTokenAtCursor(promptEl, p.prompt);
            if (sgFrame && sgFrame.contentWindow) {
                sgFrame.contentWindow.postMessage({
                    type: "SG_TOAST", message: "Template inserted", variant: "success"
                }, "*");
            }
        }
        const presetStyles = p.styles || [];
        if (presetStyles.length === 0) return;
        presetStyles.forEach(function (sn) {
            if (state[tabName].selected.has(sn)) return;
            state[tabName].selected.add(sn);
            state[tabName].selectedOrder.push(sn);
            applyStyleImmediate(tabName, sn);
            qsa('.sg-card[data-style-name="' + CSS.escape(sn) + '"]', state[tabName].panel).forEach(function (c) {
                c.classList.add("sg-selected");
                c.classList.add("sg-applied");
            });
            if (sgFrame && sgFrame.contentWindow) {
                var styleObj = findStyleByName(tabName, sn);
                if (styleObj) {
                    sgFrame.contentWindow.postMessage({ type: "SG_STYLE_APPLIED", style: styleObj }, "*");
                }
            }
        });
        updateSelectedUI(tabName);
    }

    function getPresetCategories(preset) {
        const raw = Array.isArray(preset && preset.categories) ? preset.categories :
            (preset && preset.category ? [preset.category] : []);
        const seen = new Set();
        return raw.map(function (category) { return String(category).trim(); }).filter(function (category) {
            const key = category.toLowerCase();
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    function getBatchCategoryGroups(categoryLists) {
        const counts = new Map();
        const names = new Map();
        categoryLists.forEach(function (categories) {
            getPresetCategories({ categories: categories || [] }).forEach(function (category) {
                const key = category.toLowerCase();
                names.set(key, names.get(key) || category);
                counts.set(key, (counts.get(key) || 0) + 1);
            });
        });
        const shared = [];
        const mixed = [];
        names.forEach(function (category, key) {
            if (counts.get(key) === categoryLists.length) shared.push(category);
            else mixed.push(category);
        });
        shared.sort(function (a, b) { return a.localeCompare(b); });
        mixed.sort(function (a, b) { return a.localeCompare(b); });
        return { shared: shared, mixed: mixed };
    }

    function showPresetCategoryPicker(tabName, initialCategories, onSave, pickerConfig) {
        const old = qs(".sg-preset-category-picker-overlay");
        if (old) old.remove();

        pickerConfig = pickerConfig || {};
        const itemLabel = pickerConfig.itemLabel || "preset";
        const colorPrefix = pickerConfig.colorPrefix || "preset:";
        const batchMode = pickerConfig.batchMode === true;
        const categoryNames = new Map();
        const suppliedCategories = Array.isArray(pickerConfig.availableCategories)
            ? pickerConfig.availableCategories
            : null;
        if (suppliedCategories) {
            suppliedCategories.forEach(function (category) {
                categoryNames.set(category.toLowerCase(), category);
            });
        } else {
            Object.keys(state[tabName].presets || {}).forEach(function (name) {
                getPresetCategories(state[tabName].presets[name]).forEach(function (category) {
                    categoryNames.set(category.toLowerCase(), category);
                });
            });
        }
        getPresetCategories({ categories: initialCategories || [] }).forEach(function (category) {
            categoryNames.set(category.toLowerCase(), category);
        });
        getPresetCategories({ categories: pickerConfig.mixedCategories || [] }).forEach(function (category) {
            categoryNames.set(category.toLowerCase(), category);
        });

        const selected = new Set(getPresetCategories({ categories: initialCategories || [] }).map(function (category) {
            return category.toLowerCase();
        }));
        const mixed = new Set(getPresetCategories({ categories: pickerConfig.mixedCategories || [] }).map(function (category) {
            return category.toLowerCase();
        }).filter(function (key) { return !selected.has(key); }));
        const originalSelected = new Set(selected);
        const originalMixed = new Set(mixed);
        const overlay = el("div", { className: "sg-editor-overlay sg-preset-category-picker-overlay" });
        const modal = el("div", { className: "sg-editor-modal sg-preset-category-picker" });
        modal.appendChild(el("h3", {
            className: "sg-editor-title",
            textContent: pickerConfig.title || "Preset categories"
        }));
        modal.appendChild(el("p", {
            className: "sg-preset-category-help",
            textContent: pickerConfig.help ||
                ("Select every category this " + itemLabel + " belongs to. Leave all unchecked for Uncategorized.")
        }));
        if (batchMode) {
            modal.appendChild(el("div", { className: "sg-batch-category-legend" }, [
                el("span", { textContent: "✓ All" }),
                el("span", { textContent: "− Some (unchanged)" }),
                el("span", { textContent: "□ None" })
            ]));
        }

        const changeSummary = batchMode
            ? el("div", { className: "sg-batch-category-summary" })
            : null;
        if (changeSummary) modal.appendChild(changeSummary);

        const options = el("div", { className: "sg-preset-category-options" });
        modal.appendChild(options);

        function getBatchChanges() {
            const additions = [];
            const removals = [];
            categoryNames.forEach(function (category, key) {
                if (selected.has(key) && !originalSelected.has(key)) additions.push(category);
                if (!selected.has(key) && !mixed.has(key) &&
                        (originalSelected.has(key) || originalMixed.has(key))) {
                    removals.push(category);
                }
            });
            additions.sort(function (a, b) { return a.localeCompare(b); });
            removals.sort(function (a, b) { return a.localeCompare(b); });
            return { add: additions, remove: removals };
        }

        function updateChangeSummary() {
            if (!changeSummary) return;
            const changes = getBatchChanges();
            const parts = [];
            if (changes.add.length) parts.push("Add to all: " + changes.add.join(", "));
            if (changes.remove.length) parts.push("Remove from all: " + changes.remove.join(", "));
            changeSummary.textContent = parts.length
                ? parts.join(" • ")
                : "No changes yet. Tags marked Some will stay on their current items.";
            applyBtn.disabled = parts.length === 0;
        }

        function renderOptions() {
            options.innerHTML = "";
            const ordered = Array.from(categoryNames.entries()).sort(function (a, b) {
                return a[1].localeCompare(b[1]);
            });
            if (!ordered.length) {
                options.appendChild(el("div", {
                    className: "sg-preset-category-empty",
                    textContent: "No " + itemLabel + " categories yet. Create the first one below."
                }));
                return;
            }
            ordered.forEach(function (entry) {
                const key = entry[0], category = entry[1];
                const checkbox = el("input", { type: "checkbox" });
                checkbox.checked = selected.has(key);
                checkbox.indeterminate = batchMode && mixed.has(key);
                const stateLabel = batchMode ? el("span", { className: "sg-batch-category-state" }) : null;
                function updateStateLabel() {
                    if (!stateLabel) return;
                    stateLabel.textContent = mixed.has(key) ? "Some" : (selected.has(key) ? "All" : "None");
                }
                updateStateLabel();
                checkbox.addEventListener("change", function () {
                    mixed.delete(key);
                    if (checkbox.checked) selected.add(key);
                    else selected.delete(key);
                    checkbox.indeterminate = false;
                    updateStateLabel();
                    updateChangeSummary();
                });
                options.appendChild(el("label", { className: "sg-preset-category-option" }, [
                    checkbox,
                    el("span", { className: "sg-category-dot", style: "background-color:" + getCategoryColor(colorPrefix + category) }),
                    el("span", { className: "sg-preset-category-name", textContent: category }),
                    stateLabel
                ]));
            });
        }

        const newCategoryRow = el("div", { className: "sg-preset-category-new-row" });
        const newCategoryInput = el("input", {
            className: "sg-editor-input",
            type: "text",
            maxlength: "100",
            placeholder: pickerConfig.placeholder || "New category name...",
            "aria-label": "New " + itemLabel + " category"
        });
        const addCategoryBtn = el("button", {
            className: "sg-btn sg-btn-secondary",
            textContent: "Add",
            onClick: addCategory
        });
        function addCategory() {
            const category = newCategoryInput.value.trim();
            if (!category) return;
            const key = category.toLowerCase();
            if (!categoryNames.has(key)) categoryNames.set(key, category);
            mixed.delete(key);
            selected.add(key);
            newCategoryInput.value = "";
            renderOptions();
            updateChangeSummary();
        }
        newCategoryInput.addEventListener("keydown", function (event) {
            if (event.key === "Enter") {
                event.preventDefault();
                addCategory();
            }
        });
        newCategoryRow.appendChild(newCategoryInput);
        newCategoryRow.appendChild(addCategoryBtn);
        modal.appendChild(newCategoryRow);

        const actions = el("div", { className: "sg-editor-btns sg-preset-category-actions" });
        const cancelBtn = el("button", { className: "sg-btn sg-btn-secondary", textContent: "Cancel" });
        const applyBtn = el("button", {
            className: "sg-btn sg-btn-primary",
            textContent: batchMode ? "Apply changes" : "Save categories"
        });
        actions.appendChild(cancelBtn);
        actions.appendChild(applyBtn);
        modal.appendChild(actions);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        function closePicker() {
            document.removeEventListener("keydown", onPickerKeyDown);
            overlay.remove();
        }
        function onPickerKeyDown(event) {
            if (event.key === "Escape") closePicker();
        }
        cancelBtn.addEventListener("click", closePicker);
        overlay.addEventListener("mousedown", function (event) {
            if (event.target === overlay) closePicker();
        });
        applyBtn.addEventListener("click", function () {
            const categories = Array.from(selected).map(function (key) {
                return categoryNames.get(key);
            }).filter(Boolean).sort(function (a, b) { return a.localeCompare(b); });
            const changes = getBatchChanges();
            closePicker();
            onSave(categories, changes);
        });
        document.addEventListener("keydown", onPickerKeyDown);
        renderOptions();
        updateChangeSummary();
    }

    function showPresetRenameDialog(currentName, onSave, renameConfig) {
        renameConfig = renameConfig || {};
        const itemLabel = renameConfig.itemLabel || "preset";
        const old = qs(".sg-preset-rename-overlay");
        if (old) old.remove();

        const overlay = el("div", { className: "sg-editor-overlay sg-preset-rename-overlay" });
        const modal = el("div", { className: "sg-editor-modal sg-preset-rename-modal" });
        modal.appendChild(el("h3", { className: "sg-editor-title", textContent: renameConfig.title || "Rename preset" }));
        modal.appendChild(el("label", { className: "sg-editor-label", textContent: renameConfig.label || "Preset name" }));
        const nameInput = el("input", {
            className: "sg-editor-input",
            type: "text",
            maxlength: String(renameConfig.maxLength || 200),
            value: currentName,
            "aria-label": renameConfig.label || "Preset name"
        });
        modal.appendChild(nameInput);
        const errorText = el("div", { className: "sg-preset-rename-error" });
        modal.appendChild(errorText);

        const actions = el("div", { className: "sg-editor-btns sg-preset-category-actions" });
        const cancelBtn = el("button", { className: "sg-btn sg-btn-secondary", textContent: "Cancel" });
        const renameBtn = el("button", { className: "sg-btn sg-btn-primary", textContent: "Rename" });
        actions.appendChild(cancelBtn);
        actions.appendChild(renameBtn);
        modal.appendChild(actions);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        function closeDialog() {
            document.removeEventListener("keydown", onRenameKeyDown);
            overlay.remove();
        }
        function submitRename() {
            const newName = nameInput.value.trim();
            if (!newName) {
                errorText.textContent = "Enter a " + itemLabel + " name.";
                nameInput.focus();
                return;
            }
            if (newName === currentName) {
                closeDialog();
                return;
            }
            closeDialog();
            onSave(newName);
        }
        function onRenameKeyDown(event) {
            if (event.key === "Escape") closeDialog();
            if (event.key === "Enter") {
                event.preventDefault();
                submitRename();
            }
        }
        cancelBtn.addEventListener("click", closeDialog);
        renameBtn.addEventListener("click", submitRename);
        overlay.addEventListener("mousedown", function (event) {
            if (event.target === overlay) closeDialog();
        });
        document.addEventListener("keydown", onRenameKeyDown);
        nameInput.focus();
        nameInput.select();
    }

    function showLoraRenameDialog(currentName, onSave) {
        const old = qs(".sg-lora-rename-overlay");
        if (old) old.remove();

        const overlay = el("div", { className: "sg-editor-overlay sg-preset-rename-overlay sg-lora-rename-overlay" });
        const modal = el("div", { className: "sg-editor-modal sg-preset-rename-modal" });
        modal.appendChild(el("h3", { className: "sg-editor-title", textContent: "Rename LoRA" }));
        modal.appendChild(el("p", {
            className: "sg-preset-category-help",
            textContent: "Renames the model and every same-name sidecar beside it, including preview images, JSON, and text files."
        }));
        modal.appendChild(el("label", { className: "sg-editor-label", textContent: "Filename (without extension)" }));
        const nameInput = el("input", {
            className: "sg-editor-input",
            type: "text",
            maxlength: "200",
            value: currentName,
            "aria-label": "LoRA filename without extension"
        });
        modal.appendChild(nameInput);

        const unloadCheckbox = el("input", { type: "checkbox" });
        const unloadLabel = el("label", { className: "sg-lora-rename-unload" }, [
            unloadCheckbox,
            el("span", { textContent: "Unload Forge model memory before renaming" })
        ]);
        modal.appendChild(unloadLabel);
        modal.appendChild(el("p", {
            className: "sg-preset-category-help",
            textContent: "Enable this if Windows says the LoRA is in use. Forge will reload the model when it is next needed."
        }));

        const errorText = el("div", { className: "sg-preset-rename-error" });
        modal.appendChild(errorText);
        const actions = el("div", { className: "sg-editor-btns sg-preset-category-actions" });
        const cancelBtn = el("button", { className: "sg-btn sg-btn-secondary", textContent: "Cancel" });
        const renameBtn = el("button", { className: "sg-btn sg-btn-primary", textContent: "Rename" });
        actions.appendChild(cancelBtn);
        actions.appendChild(renameBtn);
        modal.appendChild(actions);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        function closeDialog() {
            document.removeEventListener("keydown", onRenameKeyDown);
            overlay.remove();
        }
        function submitRename() {
            const newName = nameInput.value.trim();
            if (!newName) {
                errorText.textContent = "Enter a LoRA filename.";
                nameInput.focus();
                return;
            }
            if (newName === currentName) {
                closeDialog();
                return;
            }
            closeDialog();
            onSave(newName, unloadCheckbox.checked);
        }
        function onRenameKeyDown(event) {
            if (event.key === "Escape") closeDialog();
            if (event.key === "Enter") {
                event.preventDefault();
                submitRename();
            }
        }
        cancelBtn.addEventListener("click", closeDialog);
        renameBtn.addEventListener("click", submitRename);
        overlay.addEventListener("mousedown", function (event) {
            if (event.target === overlay) closeDialog();
        });
        document.addEventListener("keydown", onRenameKeyDown);
        nameInput.focus();
        nameInput.select();
    }

    function showPresetsMenu(tabName) {
        const old = qs(".sg-presets-overlay");
        if (old) old.remove();

        apiGet("/style_grid/presets").then(function (presets) {
            state[tabName].presets = presets || {};
        }).catch(function () {}).then(function () {
        const overlay = el("div", { className: "sg-editor-overlay sg-presets-overlay" });
        const modal = el("div", { className: "sg-editor-modal" });
        modal.classList.add("sg-presets-modal");
        modal.appendChild(el("h3", { className: "sg-editor-title", textContent: "📦 Scenes & Templates" }));

        // Save both complete prompt boxes as a reusable scene.
        const saveRow = el("div", { className: "sg-presets-save-row" });
        const nameIn = el("input", { className: "sg-editor-input", type: "text", placeholder: "Scene name..." });
        let selectedSaveCategories = [];
        const categoryBtn = el("button", {
            className: "sg-btn sg-btn-secondary sg-presets-category-btn",
            textContent: "Choose categories...",
            onClick: function () {
                showPresetCategoryPicker(tabName, selectedSaveCategories, function (categories) {
                    selectedSaveCategories = categories;
                    categoryBtn.textContent = categories.length ? categories.join(", ") : "Choose categories...";
                    categoryBtn.title = categories.length ? categories.join(", ") : "Uncategorized";
                });
            }
        });
        const saveBtn = el("button", {
            className: "sg-btn sg-btn-primary", textContent: "💾 Save scene",
            onClick: function () {
                const name = nameIn.value.trim();
                if (!name) return;
                const promptEl = qs("#" + tabName + "_prompt textarea");
                const negEl = qs("#" + tabName + "_neg_prompt textarea");
                if (!promptEl || !negEl) return;
                apiPost("/style_grid/presets/save", {
                    name: name,
                    mode: "scene",
                    prompt: promptEl.value,
                    negative_prompt: negEl.value,
                    categories: selectedSaveCategories,
                    styles: []
                }).then(function (r) {
                    state[tabName].presets = r.presets || {};
                    renderPresetsList();
                    nameIn.value = "";
                    var sgFrameSave = document.getElementById("sg-frame-" + tabName);
                    if (sgFrameSave && sgFrameSave.contentWindow) {
                        sgFrameSave.contentWindow.postMessage({ type: "SG_PRESETS_UPDATED" }, "*");
                    }
                }).catch(function () {});
            }
        });
        saveRow.appendChild(nameIn);
        saveRow.appendChild(categoryBtn);
        saveRow.appendChild(saveBtn);
        modal.appendChild(saveRow);

        const filterRow = el("div", { className: "sg-presets-filter-row" });
        const searchIn = el("input", {
            className: "sg-editor-input",
            type: "search",
            placeholder: "Search saved scenes...",
            "aria-label": "Search saved scenes"
        });
        const countLabel = el("span", { className: "sg-presets-count" });
        filterRow.appendChild(searchIn);
        filterRow.appendChild(countLabel);
        modal.appendChild(filterRow);

        const list = el("div", { className: "sg-presets-list" });
        modal.appendChild(list);

        function renderPresetsList() {
            list.innerHTML = "";
            const presets = state[tabName].presets || {};
            const names = Object.keys(presets).sort(function (a, b) {
                const pinOrder = Number(presets[b].pinned === true) - Number(presets[a].pinned === true);
                if (pinOrder) return pinOrder;
                const dateOrder = String(presets[b].created || "").localeCompare(String(presets[a].created || ""));
                return dateOrder || a.localeCompare(b);
            });
            const term = searchIn.value.trim().toLowerCase();
            const filteredNames = names.filter(function (name) {
                const p = presets[name];
                const styleCount = (p.styles || []).length;
                const detail = p.mode === "scene" ? "saved scene" :
                    (p.prompt ? "text template" : (styleCount ? "selected styles" : "empty preset"));
                const categoriesText = getPresetCategories(p).join(" ") || "uncategorized";
                return !term || (name + " " + detail + " " + categoriesText).toLowerCase().includes(term);
            });
            countLabel.textContent = filteredNames.length === names.length ?
                names.length + (names.length === 1 ? " item" : " items") :
                filteredNames.length + " of " + names.length;

            filteredNames.forEach(function (name) {
                const p = presets[name];
                const row = el("div", { className: "sg-preset-row" });
                const styleCount = (p.styles || []).length;
                const detail = p.mode === "scene" ? "Saved scene" :
                    (p.prompt ? "Text template" :
                        (styleCount ? styleCount + (styleCount === 1 ? " selected style" : " selected styles") : "Empty preset"));
                const detailWithCategory = detail + " · " + (getPresetCategories(p).join(", ") || "Uncategorized");
                const identity = el("div", { className: "sg-preset-identity" });
                identity.appendChild(el("span", { className: "sg-preset-name", textContent: name }));
                identity.appendChild(el("span", {
                    className: "sg-preset-kind" + (detail === "Empty preset" ? " sg-preset-kind-empty" : ""),
                    textContent: detailWithCategory
                }));
                row.appendChild(identity);
                const loadBtn = el("button", {
                    className: "sg-btn sg-btn-secondary", textContent: "Load",
                    onClick: function () {
                        loadPreset(tabName, p.name ?? name);
                        overlay.remove();
                    }
                });
                if (detail === "Empty preset") {
                    loadBtn.disabled = true;
                    loadBtn.title = "This legacy entry contains no saved prompt";
                }
                row.appendChild(loadBtn);
                row.appendChild(el("button", {
                    className: "sg-btn sg-btn-secondary sg-preset-delete", textContent: "🗑️",
                    title: "Delete " + name,
                    "aria-label": "Delete " + name,
                    onClick: function () {
                        apiPost("/style_grid/presets/delete", { name: name }).then(function (r) {
                            state[tabName].presets = r.presets || {};
                            renderPresetsList();
                            var sgFrameDel = document.getElementById("sg-frame-" + tabName);
                            if (sgFrameDel && sgFrameDel.contentWindow) {
                                sgFrameDel.contentWindow.postMessage({ type: "SG_PRESETS_UPDATED" }, "*");
                            }
                        }).catch(function () {});
                    }
                }));
                list.appendChild(row);
            });
            if (names.length === 0) {
                list.appendChild(el("div", { className: "sg-preset-empty", textContent: "No scenes or templates saved yet" }));
            } else if (filteredNames.length === 0) {
                list.appendChild(el("div", { className: "sg-preset-empty", textContent: "No matching scenes or templates" }));
            }
        }
        searchIn.addEventListener("input", renderPresetsList);
        renderPresetsList();

        const closeBtn = el("button", { className: "sg-btn sg-btn-secondary", textContent: "Close", onClick: function () { overlay.remove(); } });
        modal.appendChild(closeBtn);
        overlay.appendChild(modal);
        var presetsOverlayMouseDownTarget = null;
        overlay.addEventListener("mousedown", function (e) {
            presetsOverlayMouseDownTarget = e.target;
        });
        overlay.addEventListener("click", function (e) {
            if (presetsOverlayMouseDownTarget === overlay || presetsOverlayMouseDownTarget === e.currentTarget) {
                overlay.remove();
            }
            presetsOverlayMouseDownTarget = null;
        });
        document.body.appendChild(overlay);
        });
    }

    // -----------------------------------------------------------------------
    // Import/Export
    // -----------------------------------------------------------------------
    function showExportImport(tabName) {
        const overlay = el("div", { className: "sg-editor-overlay" });
        const modal = el("div", { className: "sg-editor-modal" });
        modal.appendChild(el("h3", { className: "sg-editor-title", textContent: "📥 Import / Export" }));

        const btnExport = el("button", {
            className: "sg-btn sg-btn-primary", textContent: "⬇️ Export all (JSON)",
            onClick: function () {
                apiGet("/style_grid/export").then(function (data) {
                    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
                    const a = document.createElement("a");
                    a.href = URL.createObjectURL(blob);
                    a.download = "style_grid_export_" + new Date().toISOString().slice(0, 10) + ".json";
                    a.click();
                }).catch(function () {});
            }
        });
        modal.appendChild(btnExport);

        const importLabel = el("label", { className: "sg-editor-label", textContent: "Import JSON file:" });
        const importInput = el("input", { type: "file", accept: ".json" });
        importInput.addEventListener("change", function () {
            const file = importInput.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = function () {
                try {
                    const data = JSON.parse(reader.result);
                    apiPost("/style_grid/import", data).then(function () {
                        overlay.remove();
                        refreshPanel(tabName);
                        var notify = state[tabName] && state[tabName].refreshAndNotifyFrame;
                        if (typeof notify === "function") notify();
                    }).catch(function () {});
                } catch (_e) { alert("Invalid JSON file"); }
            };
            reader.readAsText(file);
        });
        modal.appendChild(importLabel);
        modal.appendChild(importInput);

        modal.appendChild(el("button", { className: "sg-btn sg-btn-secondary", textContent: "Close", onClick: function () { overlay.remove(); } }));
        overlay.appendChild(modal);
        var importExportOverlayMouseDownTarget = null;
        overlay.addEventListener("mousedown", function (e) {
            importExportOverlayMouseDownTarget = e.target;
        });
        overlay.addEventListener("click", function (e) {
            if (importExportOverlayMouseDownTarget === overlay || importExportOverlayMouseDownTarget === e.currentTarget) {
                overlay.remove();
            }
            importExportOverlayMouseDownTarget = null;
        });
        document.body.appendChild(overlay);
    }

    // -----------------------------------------------------------------------
    // Refresh panel (rebuild from API data)
    // -----------------------------------------------------------------------
    function refreshPanel(tabName) {
        apiGet("/style_grid/styles").then(function (data) {
            if (data && Object.prototype.hasOwnProperty.call(data, "presets")) {
                state[tabName].presets = data.presets || {};
            }
            const dataEl = qs("#style_grid_data_" + tabName + " textarea");
            if (dataEl) {
                const full = { categories: data.categories || {}, usage: data.usage || {}, presets: state[tabName].presets };
                setPromptValue(dataEl, JSON.stringify(full));
            }
            // Save state before rebuild
            const savedSelection = new Set(state[tabName].selected);
            const wasVisible = state[tabName].panel && state[tabName].panel.classList.contains("sg-visible");
            if (state[tabName].panel) {
                state[tabName].panel.remove();
                state[tabName].panel = null;
            }
            state[tabName].categories = data.categories || {};
            state[tabName].usage = data.usage || {};
            buildPanel(tabName);
            // Restore selection
            savedSelection.forEach(function (n) {
                state[tabName].selected.add(n);
                qsa('.sg-card[data-style-name="' + CSS.escape(n) + '"]', state[tabName].panel).forEach(function (c) {
                    c.classList.add("sg-selected");
                    c.classList.add("sg-applied");
                });
            });
            var restoreOrder;
            if (state[tabName].appliedOrder && state[tabName].appliedOrder.length) {
                restoreOrder = state[tabName].appliedOrder.filter(function (n) { return savedSelection.has(n); });
            } else {
                restoreOrder = [];
                savedSelection.forEach(function (n) { restoreOrder.push(n); });
            }
            state[tabName].applied.clear();
            if (!state[tabName].silentMode) {
                state[tabName]._restoreSimP = state[tabName].userPromptBase;
                state[tabName]._restoreSimN = state[tabName].userPromptBaseNeg;
            }
            restoreOrder.forEach(function (n) {
                applyStyleImmediate(tabName, n, { silent: true });
            });
            if (!state[tabName].silentMode) {
                delete state[tabName]._restoreSimP;
                delete state[tabName]._restoreSimN;
            }
            updateSelectedUI(tabName);
            // Restore visibility — keep panel open if it was open
            if (wasVisible) {
                state[tabName].panel.classList.add("sg-visible");
            }
        }).catch(function () {
            showStatusMessage(tabName, "Refresh failed", true);
        });
    }

    function applyRandomStyle(tabName) {
        const allStyles = [];
        const src = state[tabName].selectedSource;
        Object.values(state[tabName].categories).forEach(function (arr) {
            arr.forEach(function (s) {
                if (src === "All" || s.source === src) allStyles.push(s);
            });
        });
        if (allStyles.length === 0) return;
        const rand = allStyles[Math.floor(Math.random() * allStyles.length)];
        if (!state[tabName].selected.has(rand.name)) {
            state[tabName].selected.add(rand.name);
            if (state[tabName].selectedOrder.indexOf(rand.name) === -1) state[tabName].selectedOrder.push(rand.name);
            applyStyleImmediate(tabName, rand.name);
            qsa('.sg-card[data-style-name="' + CSS.escape(rand.name) + '"]', state[tabName].panel).forEach(function (c) { c.classList.add("sg-selected"); c.classList.add("sg-applied"); });
            updateSelectedUI(tabName);
        }
    }

    function runManualStyleBackup(tabName) {
        apiPost("/style_grid/backup").then(function (r) {
            if (r && r.ok) alert("Backup saved successfully!");
            else alert("Nothing to backup or backup failed.");
        }).catch(function () {
            showStatusMessage(tabName, "Backup failed", true);
        });
    }

    // -----------------------------------------------------------------------
    // Dynamic polling for file changes
    // -----------------------------------------------------------------------
    let _pollInterval = null;
    function startPolling() {
        if (_pollInterval) return;
        _pollInterval = setInterval(function () {
            apiGet("/style_grid/check_update").then(function (r) {
                if (r && r.changed) {
                    ["txt2img", "img2img"].forEach(function (t) {
                        if (state[t].panel) refreshPanel(t);
                        apiGet("/style_grid/styles").then(function (data) {
                            var styles = [];
                            if (Array.isArray(data)) {
                                styles = data;
                            } else if (data.categories) {
                                styles = Object.values(data.categories).flat();
                            } else if (data.styles) {
                                styles = data.styles;
                            }
                            state[t].categories = {};
                            styles.forEach(function (s) {
                                var cat = s.category || "OTHER";
                                if (!state[t].categories[cat]) state[t].categories[cat] = [];
                                state[t].categories[cat].push(s);
                            });
                            var frame = state[t] && state[t].sgFrame;
                            if (frame && frame.contentWindow) {
                                // Full list for v2: dedupe by name only in iframe when "All sources" (selectFilteredStyles).
                                var v2styles = Object.values(state[t].categories).flat();
                                frame.contentWindow.postMessage({
                                    type: "SG_STYLES_UPDATE",
                                    styles: v2styles
                                }, "*");
                            }
                        });
                    });
                }
            }).catch(function () {});
        }, 5000);
    }

    // ════════════════════════════════════════════════════
    // UI: PANEL
    // ════════════════════════════════════════════════════
    // Build the Grid Panel
    // -----------------------------------------------------------------------
    function buildPanel(tabName) {
        const categories = loadStyles(tabName);
        state[tabName].categories = categories;
        state[tabName].silentMode = getSilentMode(tabName);
        const catOrder = getCategoryOrder(tabName);

        const catKeys = Object.keys(categories);
        var savedOrder = loadCategoryOrder();
        const sortedCats = [];
        if (savedOrder && Array.isArray(savedOrder)) {
            savedOrder.forEach(function (c) { if (catKeys.includes(c)) sortedCats.push(c); });
            catKeys.sort().forEach(function (c) { if (!sortedCats.includes(c)) sortedCats.push(c); });
        } else {
            catOrder.forEach(function (c) { if (catKeys.includes(c)) sortedCats.push(c); });
            catKeys.sort().forEach(function (c) { if (!sortedCats.includes(c)) sortedCats.push(c); });
        }

        // Overlay
        const overlay = el("div", { className: "sg-overlay", id: "sg_overlay_" + tabName });
        const panel = el("div", { className: "sg-panel" });

        function _attachPanelEventDelegation() {
            let overlayMouseDownTarget = null;
            overlay.addEventListener("mousedown", function (e) { overlayMouseDownTarget = e.target; }, true);
            overlay.addEventListener("click", function (e) { if (e.target === overlay && overlayMouseDownTarget === overlay) togglePanel(tabName, false); overlayMouseDownTarget = null; });
        }
        _attachPanelEventDelegation();

        function _buildPanelHeader() {
        const header = el("div", { className: "sg-header" });
        const titleRow = el("div", { className: "sg-title-row" });
        const title = el("span", { className: "sg-title" });
        title.appendChild(createPixelBagSvg(20));
        title.appendChild(document.createTextNode("Forgeventory"));
        titleRow.appendChild(title);

        // Conflict warning area
        const conflictBadge = el("span", { className: "sg-conflict-badge", id: "sg_conflict_" + tabName });
        conflictBadge.style.display = "none";
        conflictBadge.addEventListener("click", function () {
            showConflictResolver(tabName, conflictBadge._conflicts || []);
        });
        titleRow.appendChild(conflictBadge);

        const selectedCount = el("span", { className: "sg-selected-count", id: "sg_count_" + tabName, textContent: "0 selected" });
        titleRow.appendChild(selectedCount);
        header.appendChild(titleRow);
        return header;
        }

        function _buildSourceList() {
        const searchRow = el("div", { className: "sg-search-row" });

        // Source dropdown
        state[tabName].selectedSource = getStoredSource(tabName);
        const sources = getUniqueSources(tabName);
        let currentSource = state[tabName].selectedSource;
        if (sources.indexOf(currentSource) === -1) currentSource = "All";
        state[tabName].selectedSource = currentSource;
        syncSourceInput(tabName);

        const srcWrap = el("div", { className: "sg-source-dropdown-wrap" });
        const srcBtn = el("button", { type: "button", className: "sg-source-select lg secondary gradio-button", id: "sg_source_" + tabName, title: "Filter by source", textContent: currentSource === "All" ? "All Sources" : currentSource });
        const srcList = el("div", { className: "sg-source-dropdown-list" });
        [{ value: "All", label: "All Sources" }].concat(sources.map(function (s) { return { value: s, label: s }; })).forEach(function (opt) {
            const item = el("div", { className: "sg-source-dropdown-item" + (opt.value === currentSource ? " sg-active" : ""), "data-value": opt.value, textContent: opt.label });
            item.addEventListener("click", function (e) {
                e.stopPropagation();
                state[tabName].selectedSource = opt.value;
                if (opt.value === "All") {
                    state[tabName].selectedSourceFile = null;
                } else {
                    var _pickedFile = null;
                    Object.values(state[tabName].categories || {}).forEach(function (arr) {
                        arr.forEach(function (st) {
                            if (_pickedFile) return;
                            if (st.source === opt.value) _pickedFile = st.source_file;
                        });
                    });
                    state[tabName].selectedSourceFile = _pickedFile ? String(_pickedFile).replace(/\\/g, "/") : null;
                }
                syncSourceInput(tabName);
                setStoredSource(tabName, opt.value);
                srcBtn.textContent = opt.label;
                srcList.classList.remove("sg-open");
                qsa(".sg-source-dropdown-item", srcList).forEach(function (i) { i.classList.toggle("sg-active", i.getAttribute("data-value") === opt.value); });
                filterStyles(tabName);
            });
            srcList.appendChild(item);
        });
        srcBtn.addEventListener("click", function (e) {
            e.stopPropagation();
                srcList.classList.toggle("sg-open");
            if (srcList.classList.contains("sg-open")) {
                    const close = function (e2) { if (!srcWrap.contains(e2.target)) { srcList.classList.remove("sg-open"); document.removeEventListener("click", close); } };
                setTimeout(function () { document.addEventListener("click", close); }, 0);
            }
        });
        srcWrap.appendChild(srcBtn);
        srcWrap.appendChild(srcList);
        searchRow.appendChild(srcWrap);

        // Search
        const searchInput = el("input", { className: "sg-search", type: "text", placeholder: "Search styles...", id: "sg_search_" + tabName, maxlength: "200" });
        const searchWrapper = el("div", { className: "sg-search-wrapper" });
        const clearBtn = el("span", { className: "sg-search-clear", textContent: "×" });
        clearBtn.addEventListener("click", function () {
            searchInput.value = "";
            clearBtn.classList.remove("sg-visible");
            filterStyles(tabName);
        });

        const acDropdown = el("div", { className: "sg-ac-dropdown" });
        acDropdown.style.display = "none";
        searchWrapper.style.position = "relative";
        searchWrapper.appendChild(searchInput);
        searchWrapper.appendChild(clearBtn);
        searchWrapper.appendChild(acDropdown);
        searchRow.appendChild(searchWrapper);

        let acSuppressNext = false;

        searchInput.addEventListener("input", function () {
            const val = this.value;
            clearBtn.classList.toggle("sg-visible", val.length > 0);

            if (acSuppressNext) {
                acSuppressNext = false;
                if (window._sgSearchTimer) clearTimeout(window._sgSearchTimer);
                window._sgSearchTimer = setTimeout(function () { filterStyles(tabName); }, 200);
                return;
            }

            if (!val.trim()) {
                acDropdown.style.display = "none";
            } else {
                const tokens = val.split(/\s+/);
                const lastToken = tokens[tokens.length - 1] || "";

                const suggestions = buildSuggestions(tabName);
                const matches = suggestions.filter(function (s) {
                    return acMatches(s, lastToken);
                }).slice(0, 8);

                if (matches.length === 0) {
                    acDropdown.style.display = "none";
                } else {
                    acDropdown.innerHTML = "";
                    matches.forEach(function (match) {
                        const item = el("div", {
                            className: "sg-ac-item",
                            textContent: match
                        });
                        item.addEventListener("mousedown", function (e) {
                            e.preventDefault();
                            const tokensInner = val.split(/\s+/);
                            tokensInner[tokensInner.length - 1] = match;
                            const needsValue = match.lastIndexOf(":") === match.length - 1;
                            searchInput.value = tokensInner.join(" ") + (needsValue ? "" : " ");
                            acSuppressNext = true;
                            acDropdown.style.display = "none";
                            var styleObj = findStyleByName(tabName, match);
                            if (!styleObj) {
                                Object.values(state[tabName].categories || {}).forEach(function (arr) {
                                    if (styleObj) return;
                                    var f = arr.find(function (st) { return (st.display_name || st.name) === match; });
                                    if (f) styleObj = f;
                                });
                            }
                            if (styleObj) {
                                if (!state[tabName].selected.has(styleObj.name)) {
                                    state[tabName].selected.add(styleObj.name);
                                    if (state[tabName].selectedOrder.indexOf(styleObj.name) === -1) {
                                        state[tabName].selectedOrder.push(styleObj.name);
                                    }
                                    applyStyleImmediate(tabName, styleObj.name);
                                    qsa('.sg-card[data-style-name="' + CSS.escape(styleObj.name) + '"]', state[tabName].panel).forEach(function (c) {
                                        c.classList.add("sg-selected");
                                        c.classList.add("sg-applied");
                                    });
                                    updateSelectedUI(tabName);
                                }
                            }
                            searchInput.dispatchEvent(new Event("input", { bubbles: true }));
                            searchInput.focus();
                        });
                        acDropdown.appendChild(item);
                    });
                    acDropdown.style.display = "block";
                }
            }

            if (window._sgSearchTimer) clearTimeout(window._sgSearchTimer);
            window._sgSearchTimer = setTimeout(function () { filterStyles(tabName); }, 200);
        });

        searchInput.addEventListener("focus", function () {
            if (!this.value.trim()) {
                acDropdown.style.display = "none";
            }
        });

        searchInput.addEventListener("blur", function () {
            setTimeout(function () { acDropdown.style.display = "none"; }, 150);
        });

        searchInput.addEventListener("keydown", function (e) {
            const items = Array.prototype.slice.call(qsa(".sg-ac-item", acDropdown));
            if (!items.length || acDropdown.style.display === "none") return;
            const active = qs(".sg-ac-item.sg-ac-active", acDropdown);
            const idx = items.indexOf(active);
            if (e.key === "ArrowDown") {
                e.preventDefault();
                if (active) active.classList.remove("sg-ac-active");
                const next = items[idx + 1 < items.length ? idx + 1 : 0];
                if (next) next.classList.add("sg-ac-active");
            } else if (e.key === "ArrowUp") {
                e.preventDefault();
                if (active) active.classList.remove("sg-ac-active");
                const prev = items[idx - 1 >= 0 ? idx - 1 : items.length - 1];
                if (prev) prev.classList.add("sg-ac-active");
            } else if ((e.key === "Enter" || e.key === "Tab") && active) {
                e.preventDefault();
                active.dispatchEvent(new MouseEvent("mousedown"));
            } else if (e.key === "Escape") {
                acDropdown.style.display = "none";
            }
        });

        // Silent mode toggle
        const silentBtn = el("button", {
            className: "sg-btn sg-btn-secondary" + (state[tabName].silentMode ? " sg-active" : ""),
            textContent: "👁 Silent",
            title: "Silent mode: styles won't appear in prompt fields but will be applied during generation",
            onClick: function () {
                state[tabName].silentMode = !state[tabName].silentMode;
                setSilentMode(tabName, state[tabName].silentMode);
                if (!state[tabName].silentMode) {
                    clearHostSilentSelection(tabName);
                    postClearSelectionToIframes();
                }
                silentBtn.classList.toggle("sg-active", state[tabName].silentMode);
                setSilentGradio(tabName);
            }
        });
        searchRow.appendChild(silentBtn);

        // Random style
        const btnRandom = el("button", {
            className: "sg-btn sg-btn-secondary", textContent: "🎲", title: "Random style (use at your own risk!)",
            onClick: function () { applyRandomStyle(tabName); }
        });
        searchRow.appendChild(btnRandom);

        // Presets
        searchRow.appendChild(el("button", { className: "sg-btn sg-btn-secondary", textContent: "📦", title: "Presets", onClick: function () { showPresetsMenu(tabName); } }));

        // Collapse/Expand
        searchRow.appendChild(el("button", {
            className: "sg-btn sg-btn-secondary", textContent: "↕", title: "Collapse all",
            onClick: function () {
                const allCollapsed = qsa(".sg-category:not(.sg-collapsed)", panel).length === 0;
                qsa(".sg-category", panel).forEach(function (sec) {
                    if (allCollapsed) { sec.classList.remove("sg-collapsed"); const a = sec.querySelector(".sg-cat-arrow"); if (a) a.textContent = "▾"; }
                    else { sec.classList.add("sg-collapsed"); const a = sec.querySelector(".sg-cat-arrow"); if (a) a.textContent = "▸"; }
                });
            }
        }));

        // Compact
        let compactMode = localStorage.getItem("sg_compact") === "1";
        const btnCompact = el("button", {
            className: "sg-btn sg-btn-secondary" + (compactMode ? " sg-active" : ""), textContent: "▪", title: "Compact mode",
            onClick: function () { compactMode = !compactMode; localStorage.setItem("sg_compact", compactMode ? "1" : "0"); panel.classList.toggle("sg-compact", compactMode); btnCompact.classList.toggle("sg-active", compactMode); }
        });
        if (compactMode) panel.classList.add("sg-compact");
        searchRow.appendChild(btnCompact);

        // Refresh
        searchRow.appendChild(el("button", { className: "sg-btn sg-btn-secondary", textContent: "🔄", title: "Refresh styles", onClick: function () { refreshPanel(tabName); } }));

        // CSV table editor — disabled (implementation kept commented above openCsvTableEditor stub)
        searchRow.appendChild(el("button", {
            type: "button",
            className: "sg-btn sg-btn-secondary sg-csv-editor-btn-disabled",
            textContent: "📋",
            title: "CSV table editor is temporarily unavailable",
            disabled: true,
        }));

        // New style
        searchRow.appendChild(el("button", { className: "sg-btn sg-btn-secondary", textContent: "➕", title: "Create new style", onClick: function () { openStyleEditor(tabName, null); } }));

        // Import/Export
        searchRow.appendChild(el("button", { className: "sg-btn sg-btn-secondary", textContent: "📥", title: "Import/Export", onClick: function () { showExportImport(tabName); } }));

        // Manual backup
        searchRow.appendChild(el("button", {
            className: "sg-btn sg-btn-secondary", textContent: "💾",
            title: "Backup all CSV style files manually. Saves a timestamped copy to data/backups/ (keeps last 20).",
            onClick: function () { runManualStyleBackup(tabName); }
        }));

        // Thumbnail cleanup — remove orphaned previews
        searchRow.appendChild(el("button", {
            className: "sg-btn sg-btn-secondary", textContent: "🧹",
            title: "Clean up orphaned thumbnail previews. Removes preview images for styles that no longer exist in any CSV.",
            onClick: function () {
                if (!confirm("Remove preview images for styles that no longer exist in any CSV?")) return;
                apiPost("/style_grid/thumbnails/cleanup").then(function (r) {
                    if (r && r.removed !== undefined) {
                        alert("Cleaned up " + r.removed + " orphaned thumbnail(s).");
                    } else {
                        alert("Cleanup failed.");
                    }
                }).catch(function () {
                    showStatusMessage(tabName, "Cleanup failed", true);
                });
            }
        }));

        // Clear
        searchRow.appendChild(el("button", { className: "sg-btn sg-btn-secondary", textContent: "Clear", title: "Clear all selections", onClick: function () { clearAll(tabName); } }));

        // Close
        searchRow.appendChild(el("button", { className: "sg-btn sg-btn-close", textContent: "✕", title: "Close", onClick: function () { togglePanel(tabName, false); } }));

        return searchRow;
        }
        var header = _buildPanelHeader();
        header.appendChild(_buildSourceList());
        panel.appendChild(header);

        function _buildCategoryGrid() {
        // ---- Body ----
        const body = el("div", { className: "sg-body" });
        const main = el("div", { className: "sg-main", id: "sg_main_" + tabName });
        const showSidebar = sortedCats.length > 5;
        const favSet = getFavorites(tabName);

        function showOnlyCategory(catId) {
            qsa(".sg-category", main).forEach(function (sec) {
                const vis = sec.querySelectorAll(".sg-card:not(.sg-card-hidden)").length;
                if (vis === 0) { sec.style.display = "none"; return; }
                if (catId === null) { sec.style.display = ""; }
                else { sec.style.display = (sec.getAttribute("data-category") === catId) ? "" : "none"; }
            });
        }

        if (showSidebar) {
            const sidebar = el("div", { className: "sg-sidebar" });
            sidebar.appendChild(el("div", { className: "sg-sidebar-label", textContent: "Categories" }));
            const btnAll = el("button", { type: "button", className: "sg-sidebar-btn sg-sidebar-btn-all sg-active", textContent: "All", onClick: function () { showOnlyCategory(null); qsa(".sg-sidebar-btn", sidebar).forEach(function (b) { b.classList.remove("sg-active"); }); btnAll.classList.add("sg-active"); } });
            sidebar.appendChild(btnAll);
            sidebar.appendChild(el("button", { type: "button", className: "sg-sidebar-btn", textContent: "★ Favorites", onClick: function () { showOnlyCategory("FAVORITES"); qsa(".sg-sidebar-btn", sidebar).forEach(function (b) { b.classList.remove("sg-active"); }); this.classList.add("sg-active"); } }));
            sidebar.appendChild(el("button", { type: "button", className: "sg-sidebar-btn", textContent: "🕑 Recent", onClick: function () { showOnlyCategory("RECENT"); qsa(".sg-sidebar-btn", sidebar).forEach(function (b) { b.classList.remove("sg-active"); }); this.classList.add("sg-active"); } }));
            sortedCats.forEach(function (catName) {
                var btn = el("button", {
                    type: "button",
                    className: "sg-sidebar-btn",
                    "data-category": catName,
                    textContent: catName,
                    draggable: "true",
                    onClick: function () {
                        showOnlyCategory(catName);
                        qsa(".sg-sidebar-btn", sidebar).forEach(function (b) {
                            b.classList.remove("sg-active");
                        });
                        btn.classList.add("sg-active");
                    }
                });

                btn.addEventListener("dragstart", function (e) {
                    e.dataTransfer.setData("text/plain", catName);
                    e.dataTransfer.effectAllowed = "move";
                    btn.classList.add("sg-sidebar-dragging");
                });
                btn.addEventListener("dragend", function () {
                    btn.classList.remove("sg-sidebar-dragging");
                    qsa(".sg-sidebar-btn", sidebar).forEach(function (b) {
                        b.classList.remove("sg-drag-over-top", "sg-drag-over-bottom");
                    });
                });
                btn.addEventListener("dragover", function (e) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    // Clear ALL sidebar buttons first — same pattern as footer tags
                    qsa(".sg-sidebar-btn[data-category]", sidebar).forEach(function (b) {
                        b.classList.remove("sg-drag-over-top", "sg-drag-over-bottom");
                    });
                    var rect = btn.getBoundingClientRect();
                    var midY = rect.top + rect.height / 2;
                    if (e.clientY < midY) {
                        btn.classList.add("sg-drag-over-top");
                    } else {
                        btn.classList.add("sg-drag-over-bottom");
                    }
                });
                btn.addEventListener("dragleave", function () {
                    btn.classList.remove("sg-drag-over-top", "sg-drag-over-bottom");
                });
                btn.addEventListener("drop", function (e) {
                    e.preventDefault();
                    qsa(".sg-sidebar-btn[data-category]", sidebar).forEach(function (b) {
                        b.classList.remove("sg-drag-over-top", "sg-drag-over-bottom");
                    });
                    var fromCat = e.dataTransfer.getData("text/plain");
                    if (!fromCat || fromCat === catName) return;

                    // Reorder sortedCats in-place
                    var fromIdx = sortedCats.indexOf(fromCat);
                    var toIdx = sortedCats.indexOf(catName);
                    if (fromIdx === -1 || toIdx === -1) return;

                    var rect2 = btn.getBoundingClientRect();
                    var insertIdx = e.clientY < (rect2.top + rect2.height / 2) ? toIdx : toIdx + 1;
                    sortedCats.splice(fromIdx, 1);
                    if (fromIdx < insertIdx) insertIdx--;
                    sortedCats.splice(insertIdx, 0, fromCat);

                    // Save custom order
                    saveCategoryOrder(sortedCats);

                    // Rebuild grid to match new order
                    rebuildGridCards(tabName);
                });

                sidebar.appendChild(btn);
            });
            body.appendChild(sidebar);
        } else {
            const filterBar = el("div", { className: "sg-filter-bar" });
            const fAll = el("button", { type: "button", className: "sg-filter-btn sg-active", textContent: "All", onClick: function () { showOnlyCategory(null); fAll.classList.add("sg-active"); fFav.classList.remove("sg-active"); } });
            const fFav = el("button", { type: "button", className: "sg-filter-btn", textContent: "★ Favorites", onClick: function () { showOnlyCategory("FAVORITES"); fFav.classList.add("sg-active"); fAll.classList.remove("sg-active"); } });
            filterBar.appendChild(fAll);
            filterBar.appendChild(fFav);
            body.appendChild(filterBar);
        }

        // Build favorites section
        const favStyles = [];
        sortedCats.forEach(function (catName) {
            (categories[catName] || []).forEach(function (s) { if (favSet.has(s.name)) favStyles.push(s); });
        });
        appendCategorySection(main, "★ " + FAV_CAT, favStyles, "#eab308", true, tabName);

        // Build recent section
        const recentHistory = getRecentHistory(tabName);
        const recentStyles = [];
        recentHistory.slice(0, 10).forEach(function (n) {
            const s = findStyleByName(tabName, n);
            if (s) recentStyles.push(s);
        });
        if (recentStyles.length > 0) {
            appendCategorySection(main, "🕑 RECENT", recentStyles, "#8b5cf6", false, tabName, "RECENT");
        }

        // Build category sections
        sortedCats.forEach(function (catName) {
            const styles = categories[catName];
            if (!styles || styles.length === 0) return;
            appendCategorySection(main, catName, styles, getCategoryColor(catName), false, tabName);
        });

        body.appendChild(main);
        panel.appendChild(body);
        }
        _buildCategoryGrid();

        function _buildPanelFooter() {
        const footer = el("div", { className: "sg-footer", id: "sg_footer_" + tabName });
        footer.appendChild(el("span", { className: "sg-footer-label", textContent: "Selected: " }));
        footer.appendChild(el("div", { className: "sg-footer-tags", id: "sg_tags_" + tabName }));
        const combosRow = el("div", {
            className: "sg-combos-row",
            id: "sg_combos_" + tabName
        });
        combosRow.style.display = "none";
        footer.appendChild(combosRow);
        panel.appendChild(footer);
        }
        _buildPanelFooter();

        overlay.appendChild(panel);
        document.body.appendChild(overlay);
        state[tabName].panel = overlay;
        filterStyles(tabName);
        loadThumbnailList(tabName);
        return overlay;
    }

    function rebuildGridCards(tabName) {
      const wasVisible =
        state[tabName].panel &&
        state[tabName].panel.classList.contains("sg-visible");
      const savedSelection = new Set(state[tabName].selected);
      const savedOrder = (state[tabName].selectedOrder || []).slice();
      const savedApplied = new Map(state[tabName].applied);
      if (state[tabName].panel) {
        state[tabName].panel.remove();
        state[tabName].panel = null;
      }
      buildPanel(tabName);
      state[tabName].selectedOrder = savedOrder.filter(function (n) { return savedSelection.has(n); });
      savedSelection.forEach(function (n) {
        state[tabName].selected.add(n);
        if (state[tabName].selectedOrder.indexOf(n) === -1) state[tabName].selectedOrder.push(n);
        qsa(
          '.sg-card[data-style-name="' + CSS.escape(n) + '"]',
          state[tabName].panel,
        ).forEach(function (c) {
          c.classList.add("sg-selected");
          if (savedApplied.has(n)) c.classList.add("sg-applied");
        });
      });
      state[tabName].applied = savedApplied;
      updateSelectedUI(tabName);
      if (wasVisible) state[tabName].panel.classList.add("sg-visible");
    }

    // -----------------------------------------------------------------------
    // Build a category section
    // -----------------------------------------------------------------------
    function appendCategorySection(container, catName, styles, color, isFav, tabName, overrideCatId) {
        const catId = overrideCatId || (isFav ? "FAVORITES" : catName);
        const section = el("div", { className: "sg-category", "data-category": catId });
        section.id = "sg-cat-" + catId.replace(/\s/g, "_");

        const catHeader = el("div", { className: "sg-cat-header" });
        catHeader.style.borderLeftColor = color;
        const catTitle = el("span", { className: "sg-cat-title" });
        const catBadge = el("span", { className: "sg-cat-badge" }); catBadge.style.backgroundColor = color; catBadge.textContent = catName;
        catTitle.appendChild(catBadge);
        catTitle.appendChild(document.createTextNode(" (" + styles.length + ")"));
        const catArrow = el("span", { className: "sg-cat-arrow", textContent: "▾" });
        const catSelectAll = el("button", {
            className: "sg-cat-select-all", textContent: "Select All",
            onClick: function (e) { e.stopPropagation(); toggleCategoryAll(tabName, catId); }
        });
        catHeader.appendChild(catTitle);
        catHeader.appendChild(catSelectAll);
        catHeader.appendChild(catArrow);
        catHeader.addEventListener("click", function () {
            section.classList.toggle("sg-collapsed");
            catArrow.textContent = section.classList.contains("sg-collapsed") ? "▸" : "▾";
            saveCollapsedCategories(tabName);
        });
       catHeader.addEventListener("contextmenu", function (e) {
           e.preventDefault();
           e.stopPropagation();
           const old = qs(".sg-context-menu"); if (old) old.remove();
           const menu = el("div", { className: "sg-context-menu" });
           menu.style.left = e.clientX + "px"; menu.style.top = e.clientY + "px";
           const item = el("div", {
               className: "sg-ctx-item",
               textContent: "🎲 Add category as wildcard",
               onClick: function () {
                   menu.remove();
                   const wcTag = "{sg:" + catId.toLowerCase() + "}";
                   const promptEl = qs("#" + tabName + "_prompt textarea");
                   if (promptEl) {
                       insertPromptTokenAtCursor(promptEl, wcTag);
                   }
               }
           });
           menu.appendChild(item);

           // Batch thumbnail generation for this category
           var stylesInCat = styles || [];
           var activeSource = state[tabName].selectedSource || "All";
           if (activeSource !== "All") {
               var batchKey = function (str) {
                   if (!str) return "";
                   var base = String(str).replace(/\\/g, "/").split("/").pop() || "";
                   return base.replace(/\.csv$/i, "").toLowerCase();
               };
               var ak = batchKey(activeSource);
               stylesInCat = stylesInCat.filter(function (s) { return batchKey(s.source || s.source_file) === ak; });
           }
           var missingCount = 0;
           stylesInCat.forEach(function (s) {
               if (!state[tabName].hasThumbnail.has(s.name)) missingCount++;
           });
           if (missingCount > 0) {
               var batchItem = el("div", {
                   className: "sg-ctx-item",
                   textContent: "🎨 Generate previews (" + missingCount + " missing)",
                   onClick: function () {
                       menu.remove();
                       startBatchThumbnails(tabName, catId, stylesInCat);
                   }
               });
               menu.appendChild(batchItem);
           }

           document.body.appendChild(menu);
           setTimeout(function () {
               const close = function () { menu.remove(); document.removeEventListener("click", close); };
               document.addEventListener("click", close);
           }, 0);
       });
        section.appendChild(catHeader);

        // Restore collapsed state from localStorage
        var collapsedList = getCollapsedCategories();
        if (collapsedList.indexOf(catId) !== -1) {
            section.classList.add("sg-collapsed");
            catArrow.textContent = "▸";
        }

        const grid = el("div", { className: "sg-grid" });
        styles.forEach(function (style) {
            const card = el("div", {
                className: "sg-card" + (style.has_placeholder ? " sg-has-placeholder" : ""),
                "data-style-name": style.name,
                "data-category": catId,
                "data-search-name": buildSearchText(style),
                "data-source": style.source || "",
            });
            card._styleRef = style;
            card.style.setProperty("--cat-color", color);
            if (state[tabName].selected.has(style.name)) { card.classList.add("sg-selected"); card.classList.add("sg-applied"); }

            const icons = el("div", { className: "sg-card-icons" });
            const check = el("span", { className: "sg-card-check", textContent: "✓" });
            icons.appendChild(check);
            const star = el("span", {
                className: "sg-card-star" + (getFavorites(tabName).has(style.name) ? " sg-fav" : ""),
                title: "Toggle favorite", textContent: "★",
                onClick: function (e) {
                    e.stopPropagation();
                    toggleFavorite(tabName, style.name);
                    star.classList.toggle("sg-fav", getFavorites(tabName).has(style.name));
                }
            });
            icons.appendChild(star);
            card.appendChild(icons);

            const usage = state[tabName].usage || {};
            const uCount = (usage[style.name] || {}).count || 0;
            if (uCount > 0) {
                const uBadge = el("span", { className: "sg-card-usage", textContent: uCount.toString(), title: "Used " + uCount + " times" });
                card.appendChild(uBadge);
            }

            card.appendChild(el("div", { className: "sg-card-name", textContent: style.display_name || style.name }));

            card.addEventListener("click", function () { toggleStyle(tabName, style.name, card); });
            card.addEventListener("contextmenu", function (e) { showContextMenu(e, tabName, style.name, style); });

            card.addEventListener("mouseenter", function () {
                var name = card.getAttribute("data-style-name");
                var displayName = (card.querySelector(".sg-card-name") || {}).textContent
                    || name;
                var styleRef = card._styleRef;
                var promptText = styleRef ? (styleRef.prompt || "") : "";

                clearTimeout(_thumbHoverTimer);
                _thumbHoverTimer = setTimeout(function () {
                    showThumbPopup(card, name, tabName, displayName, promptText);
                }, 700);

                if (state[tabName].hasThumbnail && state[tabName].hasThumbnail.has(name)) {
                    card.classList.add("sg-thumb-loading");
                    _thumbProgressTimer = setTimeout(function () {
                        card.classList.remove("sg-thumb-loading");
                    }, 700);
                }

                updateCombosPanel(tabName, name);
            });

            card.addEventListener("mouseleave", function () {
                clearTimeout(_thumbHoverTimer);
                clearTimeout(_thumbProgressTimer);
                card.classList.remove("sg-thumb-loading");
                hideThumbPopup();
                var lastSelected = state[tabName].selectedOrder.length > 0
                    ? state[tabName].selectedOrder[state[tabName].selectedOrder.length - 1]
                    : null;
                updateCombosPanel(tabName, lastSelected);
            });

            grid.appendChild(card);
        });
        section.appendChild(grid);
        container.appendChild(section);
    }

    function createThumbPopup() {
        if (_thumbPopup) return _thumbPopup;
        var popup = el("div", { className: "sg-thumb-popup" });

        var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("class", "sg-thumb-progress");
        svg.setAttribute("viewBox", "0 0 36 36");
        var circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.setAttribute("class", "sg-thumb-progress-ring");
        circle.setAttribute("cx", "18");
        circle.setAttribute("cy", "18");
        circle.setAttribute("r", "15");
        svg.appendChild(circle);
        popup.appendChild(svg);

        var img = el("img", { className: "sg-thumb-img" });
        img.style.display = "none";
        popup.appendChild(img);

        var info = el("div", { className: "sg-thumb-info" });
        popup.appendChild(info);

        document.body.appendChild(popup);
        _thumbPopup = popup;
        return popup;
    }

    function showThumbPopup(card, styleName, tabName, displayName, promptText) {
        var popup = createThumbPopup();
        var hasThumbnail = state[tabName].hasThumbnail.has(styleName);

        var rect = card.getBoundingClientRect();
        var popupW = 253;
        var left = rect.right + 10;
        if (left + popupW > window.innerWidth - 20) {
            left = rect.left - popupW - 10;
        }
        var top = Math.max(10, Math.min(
            rect.top,
            window.innerHeight - 300
        ));
        popup.style.left = left + "px";
        popup.style.top = top + "px";

        var img = popup.querySelector(".sg-thumb-img");
        var info = popup.querySelector(".sg-thumb-info");
        var svg = popup.querySelector(".sg-thumb-progress");
        img.style.display = "none";
        svg.style.display = "block";
        popup.classList.add("sg-thumb-popup-visible");

        info.innerHTML = "";
        info.appendChild(el("div", {
            className: "sg-thumb-name",
            textContent: displayName
        }));
        if (promptText) {
            info.appendChild(el("div", {
                className: "sg-thumb-prompt",
                textContent: promptText.length > 100
                    ? promptText.slice(0, 100) + "…"
                    : promptText
            }));
        }
        if (!hasThumbnail) {
            info.appendChild(el("div", {
                className: "sg-thumb-hint",
                textContent: "Right-click → Upload preview image"
            }));
            svg.style.display = "none";
            return;
        }

        var srcFile = "";
        if (card._styleRef && card._styleRef.source_file) {
            srcFile = card._styleRef.source_file;
        } else if (state[tabName] && state[tabName].selectedSourceFile) {
            srcFile = state[tabName].selectedSourceFile;
        }
        var url = "/style_grid/thumbnail?name=" +
            encodeURIComponent(styleName) +
            (srcFile ? "&source=" + encodeURIComponent(srcFile) : "") +
            "&t=" +
            (_thumbVersions[styleName] || Date.now());
        img.onload = function () {
            svg.style.display = "none";
            img.style.display = "block";
        };
        img.onerror = function () {
            svg.style.display = "none";
            img.style.display = "none";
        };
        img.src = url;
    }

    function hideThumbPopup() {
        clearTimeout(_thumbHoverTimer);
        clearTimeout(_thumbProgressTimer);
        _thumbHoverTimer = null;
        if (_thumbPopup) {
            _thumbPopup.classList.remove("sg-thumb-popup-visible");
            var img = _thumbPopup.querySelector(".sg-thumb-img");
            if (img) { img.src = ""; img.style.display = "none"; }
        }
    }

    // -----------------------------------------------------------------------
    // Search autocomplete suggestions
    // -----------------------------------------------------------------------
    function buildSuggestions(tabName) {
        const sugg = new Set();
        var selectedSource = state[tabName].selectedSource || "All";
        Object.values(state[tabName].categories || {}).forEach(function (arr) {
            arr.forEach(function (style) {
                if (selectedSource === "All" || style.source === selectedSource) {
                    sugg.add(style.display_name || style.name);
                }
            });
        });
        return Array.from(sugg);
    }

    // -----------------------------------------------------------------------
    // Interaction handlers
    // -----------------------------------------------------------------------
    function updateCombosPanel(tabName, styleName) {
        var panel = state[tabName].panel;
        if (!panel) return;

        var combosEl = qs("#sg_combos_" + tabName, panel);
        if (!combosEl) return;

        if (!styleName) {
            combosEl.style.display = "none";
            if (!state[tabName]._comboStyles) state[tabName]._comboStyles = [];
            state[tabName]._comboStyles = [];
            return;
        }

        if (!state[tabName]._comboStyles) state[tabName]._comboStyles = [];
        if (state[tabName]._comboStyles.indexOf(styleName) === -1) {
            state[tabName]._comboStyles.push(styleName);
        }

        var style = findStyleByName(tabName, styleName);
        if (!style || !style.description) return;

        var parsed = parseDescription(style.description);
        if (!parsed.combos.length && !parsed.conflicts.length && !parsed.text) return;

        // Re-render full accumulated combos panel
        combosEl.innerHTML = "";
        combosEl.style.display = "flex";

        // Description text (truncated)
        if (parsed.text) {
            var descEl = el("span", {
                className: "sg-combo-desc",
                textContent: parsed.text.length > 80
                    ? parsed.text.slice(0, 80) + "…"
                    : parsed.text
            });
            descEl.title = parsed.text;
            combosEl.appendChild(descEl);
        }

        // Combos
        if (parsed.combos.length) {
            var labelEl = el("span", {
                className: "sg-combo-label",
                textContent: "Works with:"
            });
            combosEl.appendChild(labelEl);

            var loadedStyles = getLoadedStylesWithCategory(tabName);
            parsed.combos.forEach(function (comboStr) {
                var resolved = resolveComboItem(tabName, comboStr, loadedStyles);
                var chip = el("span", { className: "sg-combo-chip" });

                if (resolved.type === "style") {
                    chip.textContent = resolved.label;
                    chip.classList.add("sg-combo-chip-style");
                    var alreadySelected = state[tabName].selected.has(resolved.styleName);
                    if (alreadySelected) chip.classList.add("sg-combo-chip-active");
                    chip.title = resolved.styleName;
                    chip.addEventListener("click", function () {
                        var cardEl = qs('.sg-card[data-style-name="' + CSS.escape(resolved.styleName) + '"]', panel);
                        if (!cardEl) cardEl = { classList: { remove: function () {} } };
                        toggleStyle(tabName, resolved.styleName, cardEl);
                        chip.classList.toggle("sg-combo-chip-active", state[tabName].selected.has(resolved.styleName));
                    });

                } else if (resolved.type === "wildcard") {
                    chip.textContent = resolved.label;
                    chip.classList.add("sg-combo-chip-cat");
                    chip.title = "Filter styles by prefix " + (resolved.searchPrefix || resolved.label);
                    chip.addEventListener("click", function () {
                        var searchEl = qs("#sg_search_" + tabName, panel);
                        if (searchEl && resolved.searchPrefix) {
                            searchEl.value = resolved.searchPrefix;
                            searchEl.dispatchEvent(new Event("input", { bubbles: true }));
                            searchEl.focus();
                        }
                    });
                } else {
                    // Plain text — not a valid category or style, gray non-clickable
                    chip.textContent = resolved.label;
                    chip.classList.add("sg-combo-chip-hint");
                }

                combosEl.appendChild(chip);
            });
        }

        // Conflicts warning
        if (parsed.conflicts.length) {
            var conflLabel = el("span", {
                className: "sg-combo-label sg-combo-conflict-label",
                textContent: "⚠ Avoid:"
            });
            combosEl.appendChild(conflLabel);
            parsed.conflicts.forEach(function (c) {
                combosEl.appendChild(el("span", {
                    className: "sg-combo-chip sg-combo-chip-conflict",
                    textContent: c
                }));
            });
        }
    }

    function showSourcePicker(tabName, styleName, anchorCard) {
        // Remove any existing picker
        var old = qs(".sg-source-picker");
        if (old) old.remove();

        var ownSource = anchorCard.getAttribute("data-source");
        var ownStyle = anchorCard._styleRef;
        var variants = anchorCard._sourceVariants || [];
        var allVariants = (ownSource && ownStyle)
            ? [{ source: ownSource, style: ownStyle }].concat(variants)
            : variants;
        if (allVariants.length < 2) return;

        var picker = el("div", { className: "sg-source-picker" });
        picker.appendChild(el("div", {
            className: "sg-source-picker-title",
            textContent: "Source for \"" + (anchorCard.querySelector(".sg-card-name") || {}).textContent + "\":"
        }));

        allVariants.forEach(function (v) {
            var sourceLabel = v.source.replace(/\.csv$/i, "").replace(/^styles_?/i, "") || v.source;
            var row = el("div", { className: "sg-source-picker-row" });
            row.appendChild(el("span", {
                className: "sg-source-picker-name",
                textContent: sourceLabel
            }));
            // Show first few prompt tags as preview
            var preview = (v.style.prompt || "").split(",").slice(0, 3).map(function (t) { return t.trim(); }).filter(Boolean).join(", ");
            if (preview.length > 60) preview = preview.slice(0, 60) + "…";
            row.appendChild(el("span", {
                className: "sg-source-picker-preview",
                textContent: preview
            }));
            row.addEventListener("click", function (e) {
                e.stopPropagation();
                picker.remove();
                // Temporarily swap card's styleRef to chosen source
                anchorCard._styleRef = v.style;
                anchorCard.setAttribute("data-source", v.source);
                anchorCard._sourceVariants = [];
                toggleStyle(tabName, styleName, anchorCard);
            });
            picker.appendChild(row);
        });

        // Position near the card
        var rect = anchorCard.getBoundingClientRect();
        picker.style.position = "fixed";
        picker.style.zIndex = "10005";
        if (rect.width > 0 && rect.height > 0) {
            // Card is on-screen — position beside it
            picker.style.left = Math.min(rect.right + 8, window.innerWidth - 260) + "px";
            picker.style.top = Math.max(8, rect.top) + "px";
        } else {
            // Card is in a hidden/collapsed category — center the picker
            picker.style.left = Math.max(8, Math.round((window.innerWidth - 260) / 2)) + "px";
            picker.style.top = Math.max(8, Math.round((window.innerHeight - 200) / 2)) + "px";
        }

        document.body.appendChild(picker);

        // Auto-close on outside click
        setTimeout(function () {
            var close = function (e2) {
                if (!picker.contains(e2.target)) {
                    picker.remove();
                    document.removeEventListener("click", close);
                }
            };
            document.addEventListener("click", close);
        }, 0);
    }

    function toggleStyle(tabName, styleName, cardEl) {
        // If card has multiple source variants and style is not yet selected,
        // show source picker instead of immediately toggling
        var cardElResolved = cardEl || qsa('.sg-card[data-style-name="' + CSS.escape(styleName) + '"]:not(.sg-card-hidden)', state[tabName].panel)[0];
        if (cardElResolved && cardElResolved._sourceVariants && cardElResolved._sourceVariants.length > 1
            && !state[tabName].selected.has(styleName)) {
            showSourcePicker(tabName, styleName, cardElResolved);
            return;
        }
        cardEl = cardElResolved || cardEl;

        if (state[tabName].selected.has(styleName)) {
            state[tabName].selected.delete(styleName);
            state[tabName].selectedOrder = state[tabName].selectedOrder.filter(function (n) { return n !== styleName; });
            cardEl.classList.remove("sg-selected");
            cardEl.classList.remove("sg-applied");
            unapplyStyle(tabName, styleName);
            // Also update all duplicate cards (e.g. in favorites)
            qsa('.sg-card[data-style-name="' + CSS.escape(styleName) + '"]', state[tabName].panel).forEach(function (c) {
                c.classList.remove("sg-selected");
                c.classList.remove("sg-applied");
            });
        } else {
            state[tabName].selected.add(styleName);
            if (state[tabName].selectedOrder.indexOf(styleName) === -1) state[tabName].selectedOrder.push(styleName);
            applyStyleImmediate(tabName, styleName);
            // Update all matching cards
            qsa('.sg-card[data-style-name="' + CSS.escape(styleName) + '"]', state[tabName].panel).forEach(function (c) {
                c.classList.add("sg-selected");
                c.classList.add("sg-applied");
            });
            addToRecentHistory(tabName, [styleName]);
            if (!state[tabName].usage[styleName]) {
                state[tabName].usage[styleName] = { count: 0 };
            }
            state[tabName].usage[styleName].count =
                (state[tabName].usage[styleName].count || 0) + 1;
        }
        updateSelectedUI(tabName);
        // Check conflicts
        updateConflicts(tabName);
        var lastSelected = state[tabName].selectedOrder.length > 0
            ? state[tabName].selectedOrder[state[tabName].selectedOrder.length - 1]
            : null;
        updateCombosPanel(tabName, lastSelected);
    }

    function clearAll(tabName) {
        state[tabName].applied.forEach(function (_, n) { unapplyStyle(tabName, n); });
        state[tabName].selected.clear();
        state[tabName].selectedOrder = [];
        state[tabName].applied.clear();
        state[tabName].userPromptBase = "";
        state[tabName].userPromptBaseNeg = "";

        if (state[tabName].panel) {
            qsa(".sg-card.sg-selected, .sg-card.sg-applied", state[tabName].panel).forEach(function (c) { c.classList.remove("sg-selected"); c.classList.remove("sg-applied"); });
        }
        setSilentGradio(tabName);
        updateSelectedUI(tabName);
        updateConflicts(tabName);
        updateCombosPanel(tabName, null);
    }

    function toggleCategoryAll(tabName, catName) {
        const cards = qsa('.sg-category[data-category="' + catName + '"] .sg-card', state[tabName].panel);
        const allSelected = Array.from(cards).every(function (c) { return c.classList.contains("sg-selected"); });
        cards.forEach(function (c) {
            const name = c.getAttribute("data-style-name");
            if (allSelected) {
                unapplyStyle(tabName, name);
                state[tabName].selected.delete(name);
                state[tabName].selectedOrder = state[tabName].selectedOrder.filter(function (n) { return n !== name; });
                c.classList.remove("sg-selected");
                c.classList.remove("sg-applied");
            } else {
                if (!state[tabName].selected.has(name)) {
                    state[tabName].selected.add(name);
                    if (state[tabName].selectedOrder.indexOf(name) === -1) state[tabName].selectedOrder.push(name);
                    applyStyleImmediate(tabName, name);
                }
                c.classList.add("sg-selected");
                c.classList.add("sg-applied");
            }
        });
        updateSelectedUI(tabName);
        updateConflicts(tabName);
        updateCombosPanel(tabName, state[tabName].selectedOrder.length > 0
            ? state[tabName].selectedOrder[state[tabName].selectedOrder.length - 1]
            : null);
        saveCollapsedCategories(tabName);
    }

    function filterStyles(tabName) {
        const panel = state[tabName].panel;
        if (!panel) return;
        const searchEl = qs("#sg_search_" + tabName, panel);
        const rawQuery = searchEl ? normalizeSearchText(searchEl.value) : "";
        const selectedSource = state[tabName].selectedSource || "All";

        function sourceFilter(src) {
            return selectedSource === "All" || src === selectedSource;
        }

        function cardPasses(card) {
            if (!sourceFilter(card.getAttribute("data-source") || "")) return false;

            if (!rawQuery) return true;

            var searchName = card.getAttribute("data-search-name") || "";
            var style = card._styleRef;
            var desc = (style && style.description || "").toLowerCase();

            return rawQuery.split(/\s+/).filter(Boolean).every(function (t) {
                return searchName.indexOf(t) !== -1 || desc.indexOf(t) !== -1;
            });
        }

        requestAnimationFrame(function () {
            // Dedup: when "All Sources", show only first card per name per category
            var dedupEnabled = selectedSource === "All";
            var seenPerCat = {};

            // Always reset variants first; will be re-populated below if dedupEnabled
            qsa(".sg-card", panel).forEach(function (card) {
                card._sourceVariants = [];
            });

            qsa(".sg-card", panel).forEach(function (card) {
                var visible = cardPasses(card);

                if (visible && dedupEnabled) {
                    var styleName = card.getAttribute("data-style-name");
                    var cat = card.getAttribute("data-category") || "_";
                    if (!seenPerCat[cat]) seenPerCat[cat] = {};
                    if (seenPerCat[cat][styleName]) {
                        // This is a duplicate — hide it, but record its source
                        // on the first (visible) card
                        var firstCard = seenPerCat[cat][styleName];
                        if (!firstCard._sourceVariants) firstCard._sourceVariants = [];
                        var dupSource = card.getAttribute("data-source") || "";
                        var dupStyle = card._styleRef;
                        if (dupSource && dupStyle) {
                            firstCard._sourceVariants.push({
                                source: dupSource,
                                style: dupStyle
                            });
                        }
                        visible = false;
                    } else {
                        // First occurrence — store card ref, init variants with own source
                        card._sourceVariants = [];
                        var ownSource = card.getAttribute("data-source") || "";
                        if (ownSource && card._styleRef) {
                            card._sourceVariants.push({
                                source: ownSource,
                                style: card._styleRef
                            });
                        }
                        seenPerCat[cat][styleName] = card;
                    }
                }

                card.classList.toggle("sg-card-hidden", !visible);
            });

            qsa(".sg-category", panel).forEach(function (sec) {
                const visible = sec.querySelectorAll(".sg-card:not(.sg-card-hidden)").length;
                const ct = sec.querySelector(".sg-cat-title");
                if (ct && ct.childNodes.length >= 2)
                    ct.childNodes[1].textContent = " (" + visible + ")";
                sec.style.display = visible > 0 ? "" : "none";
            });

            const sidebar = panel.querySelector(".sg-sidebar");
            if (sidebar) {
                qsa(".sg-sidebar-btn[data-category]", sidebar).forEach(function (btn) {
                    const sec = panel.querySelector(
                        "#sg-cat-" +
                        (btn.getAttribute("data-category") || "").replace(/\s/g, "_")
                    );
                    btn.style.display =
                        (!sec || sec.querySelectorAll(".sg-card:not(.sg-card-hidden)").length > 0)
                        ? "" : "none";
                });
            }
        });
    }

    function updateSelectedUI(tabName) {
        const count = state[tabName].selected.size;
        const countEl = qs("#sg_count_" + tabName);
        if (countEl) countEl.textContent = count + " selected";

        let order = state[tabName].selectedOrder || [];
        order = order.filter(function (n) { return state[tabName].selected.has(n); });
        state[tabName].selected.forEach(function (n) {
            if (order.indexOf(n) === -1) order.push(n);
        });
        state[tabName].selectedOrder = order;

        const tagsEl = qs("#sg_tags_" + tabName);
        if (tagsEl) {
            tagsEl.innerHTML = "";
            order.forEach(function (name) {
                const tag = el("span", { className: "sg-tag", draggable: "false", "data-style-name": name });
                tag.style.cursor = "default";
                let displayName = name;
                for (const styles of Object.values(state[tabName].categories)) {
                    const f = styles.find(function (s) { return s.name === name; });
                    if (f) { displayName = f.display_name; break; }
                }
                tag.textContent = displayName;
                tag.appendChild(el("span", {
                    className: "sg-tag-remove", textContent: "×",
                    onClick: function (e) {
                        e.stopPropagation();
                        unapplyStyle(tabName, name);
                        state[tabName].selected.delete(name);
                        state[tabName].selectedOrder = state[tabName].selectedOrder.filter(function (n) { return n !== name; });
                        qsa('.sg-card[data-style-name="' + CSS.escape(name) + '"]', state[tabName].panel).forEach(function (c) { c.classList.remove("sg-selected"); c.classList.remove("sg-applied"); });
                        updateSelectedUI(tabName);
                        updateConflicts(tabName);
                    }
                }));

                tagsEl.appendChild(tag);
            });
        }

        const badge = qs("#sg_btn_badge_" + tabName);
        if (badge) { badge.textContent = count > 0 ? count : ""; badge.style.display = count > 0 ? "flex" : "none"; }
    }

    function updateConflicts(tabName) {
        const conflicts = checkConflictsLocal(tabName);
        const badge = qs("#sg_conflict_" + tabName);
        if (!badge) return;
        // Store conflicts on badge for resolver to read
        badge._conflicts = conflicts;
        if (conflicts.length > 0) {
            badge.style.display = "inline-flex";
            badge.style.cursor = "pointer";
            badge.textContent = "⚠ " + conflicts.length +
                " conflict" + (conflicts.length > 1 ? "s" : "");
            badge.title = "Click to resolve";
        } else {
            badge.style.display = "none";
            badge._conflicts = [];
        }
    }

    function showConflictResolver(tabName, initialConflicts) {
        const overlay = el("div", { className: "sg-editor-overlay" });
        const modal = el("div", { className: "sg-editor-modal" });
        let conflicts = initialConflicts || [];

        function render() {
            modal.innerHTML = "";
            modal.appendChild(el("h3", {
                className: "sg-editor-title",
                textContent: "⚠ Style Conflicts (" + conflicts.length + ")"
            }));

            if (conflicts.length === 0) {
                modal.appendChild(el("div", {
                    className: "sg-preset-empty",
                    textContent: "✓ All conflicts resolved!"
                }));
                modal.appendChild(el("button", {
                    className: "sg-btn sg-btn-secondary",
                    textContent: "Close",
                    onClick: function () { overlay.remove(); }
                }));
                return;
            }

            // Auto-fix all button
            const autoFixable = conflicts.filter(function (c) { return c.suggestion === "drop_b"; });
            if (autoFixable.length > 0) {
                modal.appendChild(el("button", {
                    className: "sg-btn sg-btn-primary",
                    textContent: "⚡ Auto-fix all (" + autoFixable.length + ")",
                    style: "margin-bottom: 10px;",
                    onClick: function () {
                        const toRemove = new Set(
                            autoFixable.map(function (c) { return c.styleB; })
                        );
                        toRemove.forEach(function (name) { removeStyleForConflict(tabName, name); });
                        conflicts = checkConflictsLocal(tabName);
                        render();
                    }
                }));
            }

            // Per-conflict rows
            conflicts.forEach(function (conflict) {
                const row = el("div", {
                    style: "padding:10px; margin-bottom:8px; border-radius:6px; " +
                        "border:1px solid rgba(239,68,68,0.3); " +
                        "background:rgba(239,68,68,0.05);"
                });
                row.appendChild(el("div", {
                    textContent: "⚡ " + conflict.tokens.join(", "),
                    style: "font-size:11px; color:#fca5a5; margin-bottom:6px;"
                }));
                row.appendChild(el("div", {
                    textContent: conflict.suggestionText,
                    style: "font-size:12px; color:var(--body-text-color,#d1d5db); " +
                        "margin-bottom:8px;"
                }));
                const btns = el("div", { className: "sg-editor-btns" });
                btns.appendChild(el("button", {
                    className: "sg-btn",
                    style: "background:#dc2626; border-color:#dc2626; color:#fff;",
                    textContent: "Remove \"" + conflict.styleB + "\"",
                    onClick: function () {
                        removeStyleForConflict(tabName, conflict.styleB);
                        conflicts = checkConflictsLocal(tabName);
                        render();
                    }
                }));
                btns.appendChild(el("button", {
                    className: "sg-btn sg-btn-secondary",
                    textContent: "Ignore",
                    onClick: function () {
                        conflicts = conflicts.filter(function (c) { return c !== conflict; });
                        render();
                    }
                }));
                row.appendChild(btns);
                modal.appendChild(row);
            });

            modal.appendChild(el("button", {
                className: "sg-btn sg-btn-secondary",
                textContent: "Close",
                onClick: function () { overlay.remove(); }
            }));
        }

        render();
        overlay.appendChild(modal);
        var conflictOverlayMouseDownTarget = null;
        overlay.addEventListener("mousedown", function (e) {
            conflictOverlayMouseDownTarget = e.target;
        });
        overlay.addEventListener("click", function (e) {
            if (conflictOverlayMouseDownTarget === overlay || conflictOverlayMouseDownTarget === e.currentTarget) {
                overlay.remove();
            }
            conflictOverlayMouseDownTarget = null;
        });
        document.body.appendChild(overlay);
    }

    function removeStyleForConflict(tabName, name) {
        unapplyStyle(tabName, name);
        state[tabName].selected.delete(name);
        state[tabName].selectedOrder =
            state[tabName].selectedOrder.filter(function (n) { return n !== name; });
        qsa('.sg-card[data-style-name="' + CSS.escape(name) + '"]',
            state[tabName].panel
        ).forEach(function (c) {
            c.classList.remove("sg-selected", "sg-applied");
            c.setAttribute("aria-checked", "false");
        });
        updateSelectedUI(tabName);
        updateConflicts(tabName);
    }

    // -----------------------------------------------------------------------
    // Forgeventory v2 iframe — push SG_INIT to frame when needed
    // -----------------------------------------------------------------------
    function postSGInitToFrame(tabName) {
        var fr = state[tabName].sgFrame;
        if (!fr || !fr.contentWindow) return;
        fetch("/style_grid/styles")
            .then(function (r) { return r.json(); })
            .then(function (data) {
                var styles = Array.isArray(data)
                    ? data
                    : Object.values(data.categories || {}).flat();
                fr.contentWindow.postMessage({
                    type: "SG_INIT",
                    tab: tabName,
                    styles: styles,
                }, "*");
                postPromptStateToFrame(tabName, fr);
                state[tabName].sgV2HostInitSent = true;
            })
            .catch(function () {});
    }

    // -----------------------------------------------------------------------
    // A1111 / Gradio: visible txt2img vs img2img main tab → v2 iframe header badge
    // -----------------------------------------------------------------------
    var _sgForgeTabSyncInstalled = false;
    var _sgLastBroadcastForgeTab = null;
    var _sgForgeTabsObserver = null;
    var _sgForgeTabsPendingRetry = null;

    function getForgeUiRoot() {
        if (typeof gradioApp === "function") {
            try {
                var g = gradioApp();
                if (g) return g;
            } catch (_) { /* ignore */ }
        }
        return document;
    }

    function forgeTabPanelVisible(root, sel) {
        var el = root.querySelector(sel);
        if (!el) return false;
        var st = window.getComputedStyle(el);
        if (st.display === "none" || st.visibility === "hidden") return false;
        if (sel.indexOf("tab_txt2img") !== -1 || sel.indexOf("tab_img2img") !== -1) {
            if (el.classList && el.classList.contains("tabitem")) {
                var hidden = el.getAttribute("style") || "";
                if (hidden.indexOf("display: none") !== -1 || hidden.indexOf("display:none") !== -1) return false;
            }
        }
        return true;
    }

    function detectActiveForgeMainTab() {
        var root = getForgeUiRoot();
        var txtOn = forgeTabPanelVisible(root, "#tab_txt2img");
        var imgOn = forgeTabPanelVisible(root, "#tab_img2img");
        if (txtOn && !imgOn) return "txt2img";
        if (imgOn && !txtOn) return "img2img";

        var nav = root.querySelector("#tabs > .tab-nav") || root.querySelector("#tabs .tab-nav") || root.querySelector(".tab-nav");
        if (nav) {
            var btns = nav.querySelectorAll("button");
            var i;
            for (i = 0; i < btns.length; i++) {
                var b = btns[i];
                var sel = b.classList && b.classList.contains("selected");
                var aria = b.getAttribute("aria-selected") === "true";
                if (!sel && !aria) continue;
                var label = ((b.textContent || "") + " " + (b.getAttribute("data-testid") || "")).toLowerCase();
                if (label.indexOf("img2img") !== -1) return "img2img";
                if (label.indexOf("txt2img") !== -1) return "txt2img";
            }
            if (btns.length >= 2) {
                for (i = 0; i < btns.length; i++) {
                    if (btns[i].classList && btns[i].classList.contains("selected")) {
                        return i === 0 ? "txt2img" : "img2img";
                    }
                }
            }
        }
        if (imgOn) return "img2img";
        return "txt2img";
    }

    function postForgeHostTabToV2Frames(hostTab) {
        if (hostTab !== "txt2img" && hostTab !== "img2img") return;
        ["txt2img", "img2img"].forEach(function (t) {
            var fr = state[t] && state[t].sgFrame;
            if (fr && fr.contentWindow) {
                fr.contentWindow.postMessage({ type: "SG_HOST_TAB", tab: hostTab }, "*");
            }
        });
    }

    function syncForgeHostTabToV2Frames() {
        var tab = detectActiveForgeMainTab();
        if (_sgLastBroadcastForgeTab === tab) return;
        _sgLastBroadcastForgeTab = tab;
        postForgeHostTabToV2Frames(tab);
    }

    function scheduleSyncForgeHostTabToV2Frames() {
        syncForgeHostTabToV2Frames();
        setTimeout(syncForgeHostTabToV2Frames, 0);
        setTimeout(syncForgeHostTabToV2Frames, 120);
    }

    function installForgeMainTabSyncForV2() {
        if (_sgForgeTabSyncInstalled) return;
        _sgForgeTabSyncInstalled = true;

        document.addEventListener("click", function (e) {
            var t = e.target;
            if (!t || !t.closest) return;
            if (t.closest("#tabs > .tab-nav") || t.closest("#tabs .tab-nav") || (t.closest && t.closest(".tab-nav"))) {
                scheduleSyncForgeHostTabToV2Frames();
            }
        }, true);

        function observeTabsEl(tabsEl) {
            if (!tabsEl || _sgForgeTabsObserver) return;
            _sgForgeTabsObserver = new MutationObserver(function () {
                scheduleSyncForgeHostTabToV2Frames();
            });
            _sgForgeTabsObserver.observe(tabsEl, {
                attributes: true,
                childList: true,
                subtree: true,
                attributeFilter: ["class", "style", "aria-selected"],
            });
        }

        function tryAttachTabsObserver() {
            var r = getForgeUiRoot();
            var tabsEl = r.querySelector("#tabs");
            if (tabsEl) {
                observeTabsEl(tabsEl);
                if (_sgForgeTabsPendingRetry) {
                    clearInterval(_sgForgeTabsPendingRetry);
                    _sgForgeTabsPendingRetry = null;
                }
                return true;
            }
            return false;
        }

        if (!tryAttachTabsObserver()) {
            _sgForgeTabsPendingRetry = setInterval(function () {
                tryAttachTabsObserver();
            }, 500);
            setTimeout(function () {
                if (_sgForgeTabsPendingRetry) {
                    clearInterval(_sgForgeTabsPendingRetry);
                    _sgForgeTabsPendingRetry = null;
                }
            }, 30000);
        }

        scheduleSyncForgeHostTabToV2Frames();
    }

    // -----------------------------------------------------------------------
    // Toggle panel visibility
    // -----------------------------------------------------------------------
    var _sgHostPrevBodyOverflow = "";
    var _sgHostPrevDocOverflow = "";
    var _sgHostScrollLocked = false;
    function anySGFrameVisible() {
        return ["txt2img", "img2img"].some(function (t) {
            var fr = state[t] && state[t].sgFrame;
            var wr = state[t] && state[t].sgFrameWrapper;
            var target = wr || fr;
            return !!(target && target.style.display === "block");
        });
    }
    function setHostPageScrollLock(lock) {
        if (lock && !_sgHostScrollLocked) {
            _sgHostPrevBodyOverflow = document.body ? document.body.style.overflow : "";
            _sgHostPrevDocOverflow = document.documentElement ? document.documentElement.style.overflow : "";
            if (document.body) document.body.style.overflow = "hidden";
            if (document.documentElement) document.documentElement.style.overflow = "hidden";
            _sgHostScrollLocked = true;
            return;
        }
        if (!lock && _sgHostScrollLocked) {
            if (document.body) document.body.style.overflow = _sgHostPrevBodyOverflow || "";
            if (document.documentElement) document.documentElement.style.overflow = _sgHostPrevDocOverflow || "";
            _sgHostScrollLocked = false;
        }
    }

    function togglePanel(tabName, show) {
        var panel = state[tabName].panel;
        if (!state[tabName].sgFrame) ensureSGFramesOnce();
        var fr = state[tabName].sgFrame;
        var wr = state[tabName].sgFrameWrapper;
        if (!fr) {
            return;
        }
        if (!wr && fr.parentElement && fr.parentElement.id === "sg-panel-wrapper-" + tabName) {
            wr = fr.parentElement;
            state[tabName].sgFrameWrapper = wr;
        }
        var target = wr || fr;
        if (typeof show === "undefined") show = target.style.display !== "block";
        if (!show) {
            if (panel) panel.classList.remove("sg-visible");
            target.style.display = "none";
            setHostPageScrollLock(anySGFrameVisible());
            return;
        }
        if (panel && panel.classList.contains("sg-visible")) panel.classList.remove("sg-visible");
        target.style.display = "block";
        setHostPageScrollLock(true);
        if (!state[tabName].sgV2HostInitSent) postSGInitToFrame(tabName);
        _sgLastBroadcastForgeTab = null;
        scheduleSyncForgeHostTabToV2Frames();
    }

    // -----------------------------------------------------------------------
    // Trigger button
    // -----------------------------------------------------------------------
    function createPixelBagSvg(size) {
        const ns = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(ns, "svg");
        svg.setAttributeNS(null, "viewBox", "0 0 16 16");
        svg.setAttributeNS(null, "width", String(size));
        svg.setAttributeNS(null, "height", String(size));
        svg.setAttributeNS(null, "fill", "none");
        svg.setAttributeNS(null, "shape-rendering", "crispEdges");
        svg.setAttributeNS(null, "aria-hidden", "true");
        [
            [5, 1, 6, 1, "#2b180f"], [4, 2, 1, 3, "#2b180f"],
            [11, 2, 1, 3, "#2b180f"], [5, 2, 6, 1, "#2b180f"],
            [2, 5, 12, 9, "#2b180f"], [3, 6, 10, 7, "#b86d32"],
            [4, 6, 8, 3, "#d89443"], [3, 11, 10, 2, "#7b3f22"],
            [7, 8, 2, 3, "#4b2818"], [7, 8, 2, 2, "#f2c14e"],
            [7, 8, 1, 1, "#fff0a6"],
        ].forEach(function (pixel) {
            const rect = document.createElementNS(ns, "rect");
            rect.setAttributeNS(null, "x", String(pixel[0]));
            rect.setAttributeNS(null, "y", String(pixel[1]));
            rect.setAttributeNS(null, "width", String(pixel[2]));
            rect.setAttributeNS(null, "height", String(pixel[3]));
            rect.setAttributeNS(null, "fill", pixel[4]);
            svg.appendChild(rect);
        });
        return svg;
    }

    function createTriggerButton(tabName) {
        const svg = createPixelBagSvg(17);
        const btn = el("button", {
            className: "sg-trigger-btn lg secondary gradio-button tool svelte-cmf5ev",
            id: "sg_trigger_" + tabName, title: "Open Forgeventory",
        });
        btn.appendChild(svg);
        const badge = el("span", { className: "sg-btn-badge", id: "sg_btn_badge_" + tabName });
        badge.style.display = "none";
        btn.appendChild(badge);
        btn.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); togglePanel(tabName); });
        return btn;
    }

    function getStyleGridToolbarHost() {
        var root = (typeof gradioApp === "function" ? gradioApp() : null) || document;
        return root.querySelector(".forge-toolbar-container")
            || root.querySelector("#quicksettings")
            || root.querySelector(".gradio-container .top-row")
            || null;
    }

    function injectButton(tabName) {
        const selectors = [
            "#" + tabName + "_tools",
            "#" + tabName + "_styles_row",
            "#" + tabName + "_actions_column .style_create_row",
            "#" + tabName + "_actions_column",
        ];
        let target = null;
        for (let i = 0; i < selectors.length; i++) { target = qs(selectors[i]); if (target) break; }
        if (!target) {
            const dd = qs("#" + tabName + "_styles_row") || qs("#" + tabName + "_styles");
            if (dd) target = dd.parentElement;
        }
        if (!target) {
            const tab = qs("#tab_" + tabName);
            if (tab) { const btns = tab.querySelectorAll(".tool"); if (btns.length > 0) target = btns[btns.length - 1].parentElement; }
        }
        if (!target) {
            var toolbarHost = getStyleGridToolbarHost();
            if (!toolbarHost) return false;
            const btnToolbar = createTriggerButton(tabName);
            btnToolbar.classList.add("sg-trigger-btn--toolbar-host");
            toolbarHost.appendChild(btnToolbar);
            return true;
        }
        const btn = createTriggerButton(tabName);
        if (target.id && target.id.includes("tools")) {
            var toolsEl = target;
            var formEl = toolsEl.querySelector(":scope > div.form, :scope > div[style*='flex']");
            (formEl || toolsEl).appendChild(btn);
        } else if (target.classList.contains("style_create_row")) target.appendChild(btn);
        else target.parentNode.insertBefore(btn, target.nextSibling);
        return true;
    }

    // -----------------------------------------------------------------------
    // Keyboard
    // -----------------------------------------------------------------------
    document.addEventListener("keydown", function (e) {
        if (e.key === "Escape") {
            ["txt2img", "img2img"].forEach(function (t) {
                var frEsc = state[t].sgFrame;
                var wrEsc = state[t].sgFrameWrapper || (frEsc && frEsc.parentElement && frEsc.parentElement.id === "sg-panel-wrapper-" + t ? frEsc.parentElement : null);
                var targetEsc = wrEsc || frEsc;
                if (targetEsc && targetEsc.style.display === "block") {
                    targetEsc.style.display = "none";
                    setHostPageScrollLock(anySGFrameVisible());
                    e.preventDefault();
                    return;
                }
                if (state[t].panel && state[t].panel.classList.contains("sg-visible")) { togglePanel(t, false); e.preventDefault(); }
            });
        }
    });

    // ════════════════════════════════════════════════════
    // STATE + INIT (boot, triggers, MutationObserver)
    // ════════════════════════════════════════════════════
    function initSGFrame(tab) {
        var existing = document.getElementById("sg-frame-" + tab);
        if (existing) {
            return existing;
        }
        const frame = document.createElement("iframe");
        frame.id = "sg-frame-" + tab;
        // Query string busts stale index.html / iframe document cache after ui/dist updates (bump when shipping UI changes).
        frame.src = `/style_grid/ui?t=${Date.now()}`;
        var wrapper = document.createElement("div");
        wrapper.id = "sg-panel-wrapper-" + tab;
        wrapper.style.cssText = [
            "position:fixed",
            "top:80px",
            "right:16px",
            "left:auto",
            "width:1000px",
            "height:650px",
            "min-width:600px",
            "min-height:400px",
            "max-width:95vw",
            "max-height:90vh",
            "border:none",
            "border-radius:12px",
            "box-shadow:0 25px 60px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.05)",
            "z-index:10000",
            "display:none",
            "overflow:hidden",
            "resize:both",
        ].join(";");
        frame.style.cssText = "width:100%;height:100%;border:none;display:block;";
        document.body.appendChild(wrapper);
        wrapper.appendChild(frame);
        state[tab].sgFrameWrapper = wrapper;
        document.addEventListener("mousedown", function (e) {
            if (wrapper.style.display !== "block") return;
            var target = e.target;
            if (!target) return;
            if (target.closest && target.closest(".sg-trigger-btn")) return;
            if (target.closest && target.closest(".sg-editor-overlay, .sg-source-picker")) return;
            if (!wrapper.contains(target)) {
                wrapper.style.display = "none";
                setHostPageScrollLock(anySGFrameVisible());
            }
        }, true);
        document.addEventListener("keydown", function (e) {
            if (e.key === "Escape" && wrapper.style.display !== "none") {
                e.stopPropagation();
                wrapper.style.display = "none";
                setHostPageScrollLock(anySGFrameVisible());
            }
        }, true);

        frame.addEventListener("load", function () {
            setTimeout(function () {
                fetch("/style_grid/styles")
                    .then(function (r) { return r.json(); })
                    .then(function (data) {
                        var allStyles = Array.isArray(data) ? data : Object.values(data.categories || {}).flat();
                        if (!state[tab]) state[tab] = {};
                        if (!state[tab].categories) state[tab].categories = {};
                        allStyles.forEach(function (s) {
                            var cat = s.category || "OTHER";
                            if (!state[tab].categories[cat]) state[tab].categories[cat] = [];
                            var exists = state[tab].categories[cat].some(function (x) {
                                return x.name === s.name;
                            });
                            if (!exists) state[tab].categories[cat].push(s);
                        });
                        if (frame.contentWindow) {
                            frame.contentWindow.postMessage({
                                type: "SG_INIT",
                                tab: tab,
                                styles: allStyles,
                            }, "*");
                            postPromptStateToFrame(tab, frame);
                        }
                    });
            }, 500);
        });

        window.addEventListener("message", function (e) {
            if (!e.data || !e.data.type) return;
            if (!e.data.type.startsWith("SG_")) return;
            // Two iframes (txt2img / img2img) each register this listener; only handle messages from THIS frame.
            // Otherwise the other tab's handler runs with wrong tab closure → e.g. batch uses All while iframe shows a chosen source.
            if (e.source !== frame.contentWindow) return;
            const msg = e.data;

            function refreshAndNotifyFrame() {
                fetch("/style_grid/styles")
                    .then(function (r) { return r.json(); })
                    .then(function (data) {
                        var allStyles = Array.isArray(data) ? data : Object.values(data.categories || {}).flat();
                        state[tab].categories = {};
                        allStyles.forEach(function (s) {
                            var cat = s.category || "OTHER";
                            if (!state[tab].categories[cat]) state[tab].categories[cat] = [];
                            state[tab].categories[cat].push(s);
                        });
                        if (frame && frame.contentWindow) {
                            frame.contentWindow.postMessage({
                                type: "SG_STYLES_UPDATE",
                                styles: allStyles
                            }, "*");
                        }
                    });
            }
            state[tab].refreshAndNotifyFrame = refreshAndNotifyFrame;
            function findStyleByName(styleName, sourceFile) {
                // Searches the tab-local host cache built from state[tab].categories.
                var cats = (state[tab] && state[tab].categories) || {};
                var nameMatches = [];
                for (var cat in cats) {
                    if (!Object.prototype.hasOwnProperty.call(cats, cat)) continue;
                    var list = cats[cat] || [];
                    list.forEach(function (s) {
                        if (s.name === styleName) nameMatches.push(s);
                    });
                }
                if (!sourceFile) return nameMatches[0] || null;
                var normalizedSource = String(sourceFile).replace(/\\/g, "/").toLowerCase();
                var sourceBase = normalizedSource.split("/").pop();
                return nameMatches.find(function (s) {
                    var candidate = String(s.source_file || s.source || "").replace(/\\/g, "/").toLowerCase();
                    return candidate === normalizedSource || candidate.split("/").pop() === sourceBase;
                }) || null;
            }
            if (msg.type === "SG_READY") {
                if (state[tab].sgV2HostInitSent) {
                    postPromptStateToFrame(tab, frame);
                    return;
                }
                fetch("/style_grid/styles")
                    .then(function (r) { return r.json(); })
                    .then(function (data) {
                        var allStyles = Array.isArray(data)
                            ? data
                            : Object.values(data.categories || {}).flat();
                        // Populate host-side style cache for applyStyleImmediate
                        if (!state[tab]) state[tab] = {};
                        if (!state[tab].categories) state[tab].categories = {};
                        allStyles.forEach(function (s) {
                            var cat = s.category || "OTHER";
                            if (!state[tab].categories[cat]) state[tab].categories[cat] = [];
                            var exists = state[tab].categories[cat].some(function (x) {
                                return x.name === s.name;
                            });
                            if (!exists) state[tab].categories[cat].push(s);
                        });
                        frame.contentWindow.postMessage({
                            type: "SG_INIT",
                            tab: tab,
                            styles: allStyles,
                        }, "*");
                        postPromptStateToFrame(tab, frame);
                        state[tab].sgV2HostInitSent = true;
                    })
                    .catch(function () {});
            }

            if (msg.type === "SG_APPLY") {
                if (msg.silent) {
                    if (!state[tab].selected) state[tab].selected = new Set();
                    state[tab].selected.add(msg.styleId);
                    state[tab].selectedOrder = state[tab].selectedOrder || [];
                    if (state[tab].selectedOrder.indexOf(msg.styleId) === -1) {
                        state[tab].selectedOrder.push(msg.styleId);
                    }
                    state[tab].silentMode = true;
                } else {
                    state[tab].silentMode = false;
                    if (state[tab].selected) state[tab].selected.delete(msg.styleId);
                    state[tab].selectedOrder = (state[tab].selectedOrder || []).filter(function (name) {
                        return name !== msg.styleId;
                    });
                }
                window._sgApplyStyle(tab, msg.styleId, { silent: msg.silent });
                setSilentGradio(tab);
            }

            if (msg.type === "SG_UNAPPLY") {
                if (state[tab] && state[tab].selected) {
                    state[tab].selected.delete(msg.styleId);
                    state[tab].selectedOrder = (state[tab].selectedOrder || []).filter(function (n) { return n !== msg.styleId; });
                }
                window._sgUnapplyStyle(tab, msg.styleId);
            }

            if (msg.type === "SG_TOGGLE_SILENT") {
                var t = msg.tab || tab;
                if (state[t]) {
                    state[t].silentMode = msg.value;
                    setSilentMode(t, msg.value);
                    if (!msg.value) {
                        clearHostSilentSelection(t);
                        postClearSelectionToIframes();
                    }
                    setSilentGradio(t);
                }
            }

            if (msg.type === "SG_REORDER_STYLES") {
                var ids = Array.isArray(msg.styleIds) ? msg.styleIds : [];
                // Legacy/stale iframe messages may still arrive. Keep only the
                // visual tracking order; never rebuild or relocate prompt text.
                state[tab].selectedOrder = ids.filter(function (styleId) {
                    return state[tab].selected.has(styleId);
                });
            }

            if (msg.type === "SG_CLOSE_REQUEST") {
                var closeTarget = state[tab].sgFrameWrapper || frame;
                closeTarget.style.display = "none";
                setHostPageScrollLock(anySGFrameVisible());
            }

            if (msg.type === "SG_RANDOM") {
                var allStyles = Object.values((state[tab] && state[tab].categories) || {}).flat();
                if (allStyles.length > 0) {
                    var randomStyle = allStyles[Math.floor(Math.random() * allStyles.length)];
                    window._sgApplyStyle(tab, randomStyle.name);
                    if (frame.contentWindow) {
                        frame.contentWindow.postMessage({
                            type: "SG_STYLE_APPLIED",
                            style: randomStyle
                        }, "*");
                    }
                }
            }
            if (msg.type === "SG_BACKUP") {
                fetch("/style_grid/backup", { method: "POST" })
                    .then(function (r) {
                        if (!r.ok) { return r.text().then(function (t) { throw new Error("HTTP " + r.status + ": " + t.slice(0, 120)); }); }
                        return r.json();
                    })
                    .then(function (data) {
                        if (frame.contentWindow) {
                            var failed = data.error || data.ok === false;
                            frame.contentWindow.postMessage({
                                type: "SG_TOAST",
                                message: data.error
                                    ? ("Backup failed: " + data.error)
                                    : data.ok === false
                                        ? "Nothing to backup (no CSV files found)"
                                        : "💾 Backup created",
                                variant: failed ? "error" : "success"
                            }, "*");
                        }
                    })
                    .catch(function (err) {
                        if (frame.contentWindow) {
                            frame.contentWindow.postMessage({
                                type: "SG_TOAST",
                                message: "Backup request failed: " + (err && err.message ? err.message : String(err)),
                                variant: "error"
                            }, "*");
                        }
                    });
            }
            if (msg.type === "SG_OPEN_LORA_FOLDER") {
                apiPost("/style_grid/open-lora-folder", {}).then(assertNoApiError).then(function () {
                    showStatusMessage(tab, "LoRA folder opened ✓");
                }).catch(function (err) {
                    showStatusMessage(tab, "Could not open LoRA folder: " + (err.message || "unknown error"), true);
                });
            }
            if (msg.type === "SG_APPLY_LORA") {
                var loraResult = toggleLoraPrompts(
                    tab,
                    msg.name || "",
                    msg.prompt || msg.token,
                    msg.negativePrompt || "",
                    msg.token || ""
                );
                if (loraResult) {
                    showStatusMessage(tab, loraResult.applied ? "LoRA added ✓" : "LoRA removed ✓");
                    postPromptStateToFrame(tab, frame);
                } else {
                    showStatusMessage(tab, "Could not update the LoRA in the prompt", true);
                }
            }
            if (msg.type === "SG_EDIT_LORA_METADATA") {
                try {
                    openForgeLoraMetadataEditor(tab, msg.name);
                } catch (err) {
                    showStatusMessage(tab, "Could not open LoRA metadata: " + (err.message || "unknown error"), true);
                }
            }
            if (msg.type === "SG_RENAME_LORA") {
                showLoraRenameDialog(msg.name, function (newName, unloadBeforeRename) {
                    apiPost("/style_grid/loras/rename", {
                        id: msg.id,
                        new_name: newName,
                        unload_before_rename: unloadBeforeRename
                    }).then(assertNoApiError).then(function (result) {
                        if (frame.contentWindow) {
                            frame.contentWindow.postMessage({ type: "SG_LORAS_UPDATED" }, "*");
                        }
                        showStatusMessage(tab, "LoRA renamed to " + result.new_name + " ✓");
                    }).catch(function (err) {
                        showStatusMessage(tab, "LoRA rename failed: " + (err.message || "unknown error"), true);
                    });
                });
            }
            if (msg.type === "SG_BATCH_EDIT_LORA_CATEGORIES") {
                var selectedLoraIds = Array.isArray(msg.ids) ? msg.ids : [];
                if (!selectedLoraIds.length) return;
                apiGet("/style_grid/loras").then(function (data) {
                    var loras = Array.isArray(data.loras) ? data.loras : [];
                    var selectedIds = new Set(selectedLoraIds);
                    var selectedLoras = loras.filter(function (lora) { return selectedIds.has(lora.id); });
                    if (!selectedLoras.length) throw new Error("Selected LoRAs were not found");
                    var tagGroups = getBatchCategoryGroups(selectedLoras.map(function (lora) {
                        return lora.categories || [];
                    }));
                    showPresetCategoryPicker(tab, tagGroups.shared, function (_categories, changes) {
                        if (!changes.add.length && !changes.remove.length) {
                            showStatusMessage(tab, "No LoRA tag changes to apply");
                            return;
                        }
                        apiPost("/style_grid/loras/categories/batch", {
                            ids: selectedLoras.map(function (lora) { return lora.id; }),
                            add_categories: changes.add,
                            remove_categories: changes.remove
                        }).then(assertNoApiError).then(function (result) {
                            if (frame.contentWindow) {
                                frame.contentWindow.postMessage({
                                    type: "SG_LORAS_UPDATED",
                                    clearSelection: true
                                }, "*");
                            }
                            showStatusMessage(tab, (result.updated || selectedLoras.length) + " LoRAs updated ✓");
                        }).catch(function (err) {
                            showStatusMessage(tab, "LoRA batch update failed: " + (err.message || "unknown error"), true);
                        });
                    }, {
                        itemLabel: "LoRA",
                        title: "Edit tags for " + selectedLoras.length +
                            (selectedLoras.length === 1 ? " LoRA" : " LoRAs"),
                        help: "Checked tags are on every selected LoRA. A dash means only some have the tag; leave it alone to preserve those differences.",
                        colorPrefix: "lora:",
                        availableCategories: Array.isArray(data.categories) ? data.categories : [],
                        placeholder: "New LoRA tag...",
                        batchMode: true,
                        mixedCategories: tagGroups.mixed
                    });
                }).catch(function (err) {
                    showStatusMessage(tab, "Could not load LoRA tags: " + (err.message || "unknown error"), true);
                });
            }
            if (msg.type === "SG_RENAME_LORA_CATEGORY") {
                showPresetRenameDialog(msg.category, function (newName) {
                    apiPost("/style_grid/loras/categories/rename", {
                        category: msg.category,
                        new_name: newName
                    }).then(assertNoApiError).then(function (result) {
                        if (frame.contentWindow) {
                            frame.contentWindow.postMessage({ type: "SG_LORAS_UPDATED" }, "*");
                        }
                        showStatusMessage(tab, "Tag renamed on " + (result.updated || 0) + " LoRAs ✓");
                    }).catch(function (err) {
                        showStatusMessage(tab, "Tag rename failed: " + (err.message || "unknown error"), true);
                    });
                }, {
                    itemLabel: "tag",
                    title: "Rename LoRA tag",
                    label: "Tag name",
                    maxLength: 100
                });
            }
            if (msg.type === "SG_REFRESH") {
                refreshPanel(tab);
                fetch("/style_grid/check_update")
                    .then(function () { return fetch("/style_grid/styles"); })
                    .then(function (r) { return r.json(); })
                    .then(function (data) {
                        var allStyles = Array.isArray(data) ? data : Object.values(data.categories || {}).flat();
                        state[tab].categories = {};
                        allStyles.forEach(function (s) {
                            var cat = s.category || "OTHER";
                            if (!state[tab].categories[cat]) state[tab].categories[cat] = [];
                            state[tab].categories[cat].push(s);
                        });
                        if (frame.contentWindow) {
                            frame.contentWindow.postMessage({
                                type: "SG_STYLES_UPDATE",
                                styles: allStyles
                            }, "*");
                        }
                    });
            }
            /*
            if (msg.type === "SG_CSV_EDITOR") {
                if (window._sgCsvEditorOpening) return;
                window._sgCsvEditorOpening = true;
                setTimeout(function () { window._sgCsvEditorOpening = false; }, 300);
                var activeTab = (function() {
                    var tabs = ["txt2img", "img2img"];
                    for (var i = 0; i < tabs.length; i++) {
                        var wrapper = document.getElementById("style_grid_wrapper_" + tabs[i]);
                        if (wrapper && wrapper.offsetParent !== null) return tabs[i];
                    }
                    return "txt2img";
                })();
                openCsvTableEditor(activeTab);
            }
            */
            if (msg.type === "SG_CSV_EDITOR") {
                if (frame.contentWindow) {
                    frame.contentWindow.postMessage({
                        type: "SG_TOAST",
                        message: "CSV table editor is temporarily unavailable.",
                        variant: "info"
                    }, "*");
                }
            }
            if (msg.type === "SG_CLEAR_ALL") {
                clearAll(tab);
            }
            if (msg.type === "SG_LOAD_PRESET") {
                var presetName = msg.name;
                var tabName = tab;
                var existing = (state[tabName].presets || {})[presetName];
                if (existing) {
                    loadPreset(tabName, presetName);
                } else {
                    fetch('/style_grid/presets/list')
                        .then(function(r) { return r.json(); })
                        .then(function(data) {
                            state[tabName].presets = data || {};
                            loadPreset(tabName, presetName);
                        });
                }
            }
            if (msg.type === "SG_PRESETS") {
                showPresetsMenu(tab);
            }
            if (msg.type === "SG_EDIT_PRESET_CATEGORIES") {
                apiGet("/style_grid/presets").then(function (presets) {
                    state[tab].presets = presets || {};
                }).catch(function () {}).then(function () {
                    var currentPreset = (state[tab].presets || {})[msg.name];
                    var currentCategories = currentPreset ? getPresetCategories(currentPreset) : (msg.categories || []);
                    showPresetCategoryPicker(tab, currentCategories, function (categories) {
                        apiPost("/style_grid/presets/category", {
                            name: msg.name,
                            categories: categories
                        }).then(assertNoApiError).then(function (r) {
                            state[tab].presets = r.presets || {};
                            if (frame.contentWindow) {
                                frame.contentWindow.postMessage({ type: "SG_PRESETS_UPDATED" }, "*");
                            }
                            showStatusMessage(tab, "Preset categories updated ✓");
                        }).catch(function (err) {
                            showStatusMessage(tab, "Category update failed: " + (err.message || "unknown error"), true);
                        });
                    });
                });
            }
            if (msg.type === "SG_BATCH_EDIT_PRESET_CATEGORIES") {
                var selectedPresetNames = Array.isArray(msg.names) ? msg.names : [];
                if (!selectedPresetNames.length) return;
                apiGet("/style_grid/presets").then(function (presets) {
                    state[tab].presets = presets || {};
                    var selectedPresets = selectedPresetNames.filter(function (name) {
                        return Object.prototype.hasOwnProperty.call(state[tab].presets, name);
                    });
                    if (!selectedPresets.length) throw new Error("Selected presets were not found");
                    var categoryGroups = getBatchCategoryGroups(selectedPresets.map(function (name) {
                        return getPresetCategories(state[tab].presets[name]);
                    }));
                    showPresetCategoryPicker(tab, categoryGroups.shared, function (_categories, changes) {
                        if (!changes.add.length && !changes.remove.length) {
                            showStatusMessage(tab, "No preset category changes to apply");
                            return;
                        }
                        apiPost("/style_grid/presets/categories/batch", {
                            names: selectedPresets,
                            add_categories: changes.add,
                            remove_categories: changes.remove
                        }).then(assertNoApiError).then(function (result) {
                            state[tab].presets = result.presets || state[tab].presets || {};
                            if (frame.contentWindow) {
                                frame.contentWindow.postMessage({ type: "SG_PRESETS_UPDATED" }, "*");
                            }
                            showStatusMessage(tab, (result.updated || selectedPresets.length) + " presets updated ✓");
                        }).catch(function (err) {
                            showStatusMessage(tab, "Preset batch update failed: " + (err.message || "unknown error"), true);
                        });
                    }, {
                        itemLabel: "preset",
                        title: "Edit categories for " + selectedPresets.length + " presets",
                        help: "Checked categories are on every selected preset. A dash means only some have the category; leave it alone to preserve those differences.",
                        placeholder: "New preset category...",
                        batchMode: true,
                        mixedCategories: categoryGroups.mixed
                    });
                }).catch(function (err) {
                    showStatusMessage(tab, "Could not load preset categories: " + (err.message || "unknown error"), true);
                });
            }
            if (msg.type === "SG_RENAME_PRESET_CATEGORY") {
                showPresetRenameDialog(msg.category, function (newName) {
                    apiPost("/style_grid/presets/categories/rename", {
                        category: msg.category,
                        new_name: newName
                    }).then(assertNoApiError).then(function (result) {
                        state[tab].presets = result.presets || state[tab].presets || {};
                        if (frame.contentWindow) {
                            frame.contentWindow.postMessage({ type: "SG_PRESETS_UPDATED" }, "*");
                        }
                        showStatusMessage(tab, "Category renamed on " + (result.updated || 0) + " presets ✓");
                    }).catch(function (err) {
                        showStatusMessage(tab, "Category rename failed: " + (err.message || "unknown error"), true);
                    });
                }, {
                    itemLabel: "category",
                    title: "Rename preset category",
                    label: "Category name",
                    maxLength: 100
                });
            }
            if (msg.type === "SG_RENAME_PRESET") {
                showPresetRenameDialog(msg.name, function (newName) {
                    apiPost("/style_grid/presets/rename", {
                        name: msg.name,
                        new_name: newName
                    }).then(assertNoApiError).then(function (r) {
                        state[tab].presets = r.presets || {};
                        if (frame.contentWindow) {
                            frame.contentWindow.postMessage({ type: "SG_PRESETS_UPDATED" }, "*");
                        }
                        showStatusMessage(tab, "Preset renamed ✓");
                    }).catch(function (err) {
                        showStatusMessage(tab, "Rename failed: " + (err.message || "unknown error"), true);
                    });
                });
            }
            if (msg.type === "SG_REPLACE_PRESET_PROMPTS") {
                replacePresetFromPrompt(tab, msg.name);
            }
            if (msg.type === "SG_DUPLICATE_PRESET") {
                apiPost("/style_grid/presets/duplicate", { name: msg.name }).then(assertNoApiError).then(function (r) {
                    state[tab].presets = r.presets || {};
                    if (frame.contentWindow) {
                        frame.contentWindow.postMessage({ type: "SG_PRESETS_UPDATED" }, "*");
                    }
                    showStatusMessage(tab, "Preset duplicated ✓");
                }).catch(function (err) {
                    showStatusMessage(tab, "Duplicate failed: " + (err.message || "unknown error"), true);
                });
            }
            if (msg.type === "SG_DELETE_PRESET") {
                if (!window.confirm("Delete preset \"" + msg.name + "\"? This cannot be undone.")) return;
                apiPost("/style_grid/presets/delete", { name: msg.name }).then(assertNoApiError).then(function (r) {
                    state[tab].presets = r.presets || {};
                    if (frame.contentWindow) {
                        frame.contentWindow.postMessage({ type: "SG_PRESETS_UPDATED" }, "*");
                    }
                    showStatusMessage(tab, "Preset deleted ✓");
                }).catch(function (err) {
                    showStatusMessage(tab, "Delete failed: " + (err.message || "unknown error"), true);
                });
            }
            if (msg.type === "SG_IMPORT_EXPORT") {
                showExportImport(tab);
            }
            if (msg.type === "SG_NEW_STYLE") {
                openStyleEditor(tab, null, msg.sourceFile);
            }
            if (msg.type === "SG_EDIT_STYLE") {
                var styleToEdit = findStyleByName(msg.styleId);
                if (styleToEdit) {
                    openStyleEditor(tab, styleToEdit);
                }
            }
            if (msg.type === "SG_REPLACE_STYLE_PROMPTS") {
                var styleToReplace = findStyleByName(msg.styleId, msg.source) || {
                    name: msg.styleId,
                    source_file: msg.source || null
                };
                replaceStyleFromPrompt(tab, styleToReplace);
            }
            if (msg.type === "SG_DUPLICATE_STYLE") {
                var styleToDup = findStyleByName(msg.styleId);
                if (styleToDup) {
                    duplicateStyle(tab, styleToDup, refreshAndNotifyFrame);
                }
            }
            if (msg.type === "SG_MOVE_TO_CATEGORY") {
                var styleToMove = findStyleByName(msg.styleId);
                if (styleToMove) {
                    moveToCategory(tab, styleToMove, refreshAndNotifyFrame);
                }
            }
            if (msg.type === "SG_BATCH_EDIT_STYLE_CATEGORIES") {
                var selectedStyleRefs = Array.isArray(msg.styles) ? msg.styles.filter(function (style) {
                    return style && typeof style.name === "string" && style.name.trim() &&
                        typeof style.source === "string" && style.source.trim();
                }).map(function (style) {
                    return {
                        name: style.name.trim(),
                        source: style.source,
                        category: typeof style.category === "string" ? style.category : ""
                    };
                }) : [];
                if (!selectedStyleRefs.length) return;
                showBatchStyleCategoryDialog(tab, selectedStyleRefs, function (category) {
                    apiPost("/style_grid/styles/categories/batch", {
                        styles: selectedStyleRefs,
                        category: category
                    }).then(assertNoApiError).then(function (result) {
                        refreshAndNotifyFrame();
                        if (frame.contentWindow) {
                            frame.contentWindow.postMessage({ type: "SG_STYLE_CATEGORIES_UPDATED" }, "*");
                        }
                        showStatusMessage(tab, (result.updated || selectedStyleRefs.length) + " styles moved to " + category + " âœ“");
                    }).catch(function (err) {
                        showStatusMessage(tab, "Style batch update failed: " + (err.message || "unknown error"), true);
                    });
                });
            }
            if (msg.type === "SG_BATCH_EDIT_STYLE_TAGS") {
                var selectedStyleTagRefs = Array.isArray(msg.styles) ? msg.styles.filter(function (style) {
                    return style && typeof style.name === "string" && style.name.trim() &&
                        typeof style.source === "string" && style.source.trim();
                }).map(function (style) {
                    return {
                        name: style.name.trim(),
                        source: style.source,
                        organizer_tags: Array.isArray(style.organizer_tags) ? style.organizer_tags : []
                    };
                }) : [];
                if (!selectedStyleTagRefs.length) return;
                var styleTagGroups = getBatchCategoryGroups(selectedStyleTagRefs.map(function (style) {
                    return style.organizer_tags;
                }));
                var availableStyleTags = [];
                var availableStyleTagKeys = new Set();
                getLoadedStylesWithCategory(tab).forEach(function (style) {
                    (style.organizer_tags || []).forEach(function (tag) {
                        var key = String(tag).trim().toLowerCase();
                        if (!key || availableStyleTagKeys.has(key)) return;
                        availableStyleTagKeys.add(key);
                        availableStyleTags.push(String(tag).trim());
                    });
                });
                availableStyleTags.sort(function (a, b) { return a.localeCompare(b); });
                showPresetCategoryPicker(tab, styleTagGroups.shared, function (_tags, changes) {
                    if (!changes.add.length && !changes.remove.length) {
                        showStatusMessage(tab, "No Style tag changes to apply");
                        return;
                    }
                    apiPost("/style_grid/styles/tags/batch", {
                        styles: selectedStyleTagRefs.map(function (style) {
                            return { name: style.name, source: style.source };
                        }),
                        add_categories: changes.add,
                        remove_categories: changes.remove
                    }).then(assertNoApiError).then(function (result) {
                        refreshAndNotifyFrame();
                        if (frame.contentWindow) {
                            frame.contentWindow.postMessage({ type: "SG_STYLE_CATEGORIES_UPDATED" }, "*");
                        }
                        showStatusMessage(tab, (result.updated || selectedStyleTagRefs.length) + " Styles updated");
                    }).catch(function (err) {
                        showStatusMessage(tab, "Style tag update failed: " + (err.message || "unknown error"), true);
                    });
                }, {
                    itemLabel: "Style",
                    title: "Edit tags for " + selectedStyleTagRefs.length +
                        (selectedStyleTagRefs.length === 1 ? " Style" : " Styles"),
                    help: "Checked tags are on every selected Style. A dash means only some have the tag; leave it alone to preserve those differences.",
                    colorPrefix: "style-tag:",
                    availableCategories: availableStyleTags,
                    placeholder: "New Style tag...",
                    batchMode: true,
                    mixedCategories: styleTagGroups.mixed
                });
            }
            if (msg.type === "SG_RENAME_STYLE_CATEGORY") {
                var categoryRenameScope = msg.scope === "family" ? "family" : "exact";
                var categoryRenameLabel = categoryRenameScope === "family" ? "category family" : "category";
                showPresetRenameDialog(msg.category, function (newName) {
                    apiPost("/style_grid/styles/categories/rename", {
                        category: msg.category,
                        new_name: newName,
                        scope: categoryRenameScope
                    }).then(assertNoApiError).then(function (result) {
                        refreshAndNotifyFrame();
                        if (frame.contentWindow) {
                            frame.contentWindow.postMessage({ type: "SG_STYLE_CATEGORIES_UPDATED" }, "*");
                        }
                        showStatusMessage(tab, "Category renamed on " + (result.updated || 0) + " styles");
                    }).catch(function (err) {
                        showStatusMessage(tab, "Category rename failed: " + (err.message || "unknown error"), true);
                    });
                }, {
                    title: categoryRenameScope === "family" ? "Rename category family" : "Rename category",
                    label: categoryRenameScope === "family" ? "Family name" : "Category name",
                    itemLabel: categoryRenameLabel,
                    maxLength: 100
                });
            }
            if (msg.type === "SG_RENAME_STYLE_TAG") {
                showPresetRenameDialog(msg.tag, function (newName) {
                    apiPost("/style_grid/styles/tags/rename", {
                        tag: msg.tag,
                        new_name: newName
                    }).then(assertNoApiError).then(function (result) {
                        refreshAndNotifyFrame();
                        if (frame.contentWindow) {
                            frame.contentWindow.postMessage({ type: "SG_STYLE_CATEGORIES_UPDATED" }, "*");
                        }
                        showStatusMessage(tab, "Style tag renamed on " + (result.updated || 0) + " rows");
                    }).catch(function (err) {
                        showStatusMessage(tab, "Style tag rename failed: " + (err.message || "unknown error"), true);
                    });
                }, {
                    itemLabel: "tag",
                    title: "Rename Style tag",
                    label: "Tag name",
                    maxLength: 100
                });
            }
            if (msg.type === "SG_WILDCARD_CATEGORY") {
                var catId = msg.category || "";
                if (catId) {
                    var wcTag = "{sg:" + String(catId).toLowerCase() + "}";
                    var promptEl = qs("#" + tab + "_prompt textarea");
                    if (promptEl) {
                        insertPromptTokenAtCursor(promptEl, wcTag);
                    }
                }
            }
            if (msg.type === "SG_CREATE_TEMP_WILDCARD") {
                var requestedNames = Array.isArray(msg.styleNames) ? msg.styleNames : [];
                var seenTempNames = new Set();
                var tempNames = requestedNames.filter(function (name) {
                    var cleanName = typeof name === "string" ? name.trim() : "";
                    var key = cleanName.toLowerCase();
                    if (!cleanName || seenTempNames.has(key)) return false;
                    seenTempNames.add(key);
                    return true;
                }).map(function (name) { return name.trim(); });
                var tempPromptEl = qs("#" + tab + "_prompt textarea");
                if (tempNames.length < 2) {
                    if (frame.contentWindow) {
                        frame.contentWindow.postMessage({
                            type: "SG_TOAST",
                            message: "Select at least two styles for a wildcard",
                            variant: "info"
                        }, "*");
                    }
                } else if (!tempPromptEl) {
                    if (frame.contentWindow) {
                        frame.contentWindow.postMessage({
                            type: "SG_TOAST",
                            message: "Prompt box is unavailable",
                            variant: "error"
                        }, "*");
                    }
                } else {
                    state[tab].temporaryWildcards = state[tab].temporaryWildcards || {};
                    state[tab].nextTemporaryWildcardId = state[tab].nextTemporaryWildcardId || 1;
                    var tempId;
                    do {
                        tempId = "temp-" + state[tab].nextTemporaryWildcardId++;
                    } while (Object.prototype.hasOwnProperty.call(state[tab].temporaryWildcards, tempId));
                    state[tab].temporaryWildcards[tempId] = tempNames;
                    syncTemporaryWildcardInput(tab);
                    insertPromptTokenAtCursor(tempPromptEl, "{sg:" + tempId + "}");
                    if (frame.contentWindow) {
                        frame.contentWindow.postMessage({
                            type: "SG_TEMP_WILDCARD_CREATED",
                            token: "{sg:" + tempId + "}",
                            count: tempNames.length
                        }, "*");
                    }
                }
            }
            if (msg.type === "SG_SOURCE_CHANGE") {
                if (!state[tab]) return;
                if (msg.source === state[tab].selectedSourceFile) return;
                var src = msg.source;
                if (src) {
                    var normalized = src.replace(/\\/g, "/");
                    state[tab].selectedSource = normalized.split("/").pop() || src;
                    // Full path for batch/API — same filter as V2 (`source_file`), not basename-only
                    state[tab].selectedSourceFile = (normalized.indexOf("/") !== -1 || src.indexOf("\\") !== -1)
                        ? normalized
                        : null;
                } else {
                    state[tab].selectedSource = "All";
                    state[tab].selectedSourceFile = null;
                }
                var syncBtn = document.getElementById("sg_source_" + tab);
                if (syncBtn) {
                    syncBtn.textContent = state[tab].selectedSource === "All" ? "All Sources" : state[tab].selectedSource;
                }
                syncSourceInput(tab);
            }
            if (msg.type === "SG_GENERATE_CATEGORY_PREVIEWS") {
                var catName = msg.category || "";
                if (catName) {
                    if (msg.source !== undefined) {
                        state[tab].selectedSourceFile = msg.source;
                    }
                    var batchSource = msg.source || state[tab].selectedSourceFile || "";
                    var sourceMatchKey = function (str) {
                        if (!str) return "";
                        var base = String(str).replace(/\\/g, "/").split("/").pop() || "";
                        return base.replace(/\.csv$/i, "").toLowerCase();
                    };
                    var rawState = (state[tab] && state[tab].selectedSource) || "All";
                    var srcBtn = document.getElementById("sg_source_" + tab);
                    var btnText = srcBtn ? srcBtn.textContent.trim() : "";
                    var fromBtn = (btnText && btnText !== "All Sources") ? btnText : "All";
                    var activeSource = (rawState && rawState !== "All") ? rawState : fromBtn;
                    var activeKey = null;
                    var exactPath = null;
                    if (batchSource) {
                        var ns = String(batchSource).replace(/\\/g, "/");
                        activeSource = ns.split("/").pop() || String(batchSource);
                        if (ns.indexOf("/") !== -1 || String(batchSource).indexOf("\\") !== -1) {
                            exactPath = ns;
                            activeKey = null;
                        } else {
                            exactPath = null;
                            activeKey = sourceMatchKey(String(batchSource));
                        }
                        state[tab].selectedSource = activeSource;
                        state[tab].selectedSourceFile = exactPath;
                        var syncBtnBatch = document.getElementById("sg_source_" + tab);
                        if (syncBtnBatch) {
                            syncBtnBatch.textContent = state[tab].selectedSource === "All" ? "All Sources" : state[tab].selectedSource;
                        }
                    } else {
                        activeKey = activeSource !== "All" ? sourceMatchKey(activeSource) : null;
                        exactPath = null;
                    }
                    // state[tab].categories dedupes by name only on first load — use API list; filter like V2 (source_file), not basename-only
                    fetch("/style_grid/styles")
                        .then(function (r) { return r.json(); })
                        .then(function (data) {
                            var allStyles = Array.isArray(data) ? data : Object.values(data.categories || {}).flat();
                            var inCat = allStyles.filter(function (s) {
                                var styleCategory = s.category || "OTHER";
                                return styleCategory === catName || styleCategory.indexOf(catName + " - ") === 0;
                            });
                            var stylesInCat = inCat;
                            if (exactPath) {
                                stylesInCat = inCat.filter(function (s) {
                                    var sf = String(s.source_file || "").replace(/\\/g, "/");
                                    return sf === exactPath || sf.toLowerCase() === exactPath.toLowerCase();
                                });
                            } else if (activeKey) {
                                stylesInCat = inCat.filter(function (s) {
                                    return sourceMatchKey(s.source || s.source_file) === activeKey;
                                });
                            }
                            startBatchThumbnails(tab, catName, stylesInCat);
                        })
                        .catch(function () {
                            showStatusMessage(tab, "Could not load styles for batch generation", true);
                        });
                }
            }
            if (msg.type === "SG_GENERATE_PREVIEW") {
                generateThumbnail(tab, msg.styleId, function () {}, function (status, progressValue) {
                    if (frame.contentWindow) {
                        frame.contentWindow.postMessage({
                            type: "SG_THUMB_PROGRESS",
                            status: status,
                            styleId: msg.styleId,
                            progress: progressValue,
                        }, "*");
                        if (status === "done") {
                            frame.contentWindow.postMessage({
                                type: "SG_THUMB_PROGRESS",
                                status: "done",
                                styleId: msg.styleId,
                                progress: 100,
                            }, "*");
                            setTimeout(function () {
                                if (frame && frame.contentWindow) {
                                    frame.contentWindow.postMessage({
                                        type: "SG_THUMB_DONE",
                                        styleId: msg.styleId,
                                        version: Date.now(),
                                    }, "*");
                                }
                            }, 300);
                        }
                        if (status === "error") {
                            frame.contentWindow.postMessage({
                                type: "SG_THUMB_PROGRESS",
                                status: "error",
                                styleId: msg.styleId,
                            }, "*");
                        }
                    }
                });
            }
            if (msg.type === "SG_UPLOAD_PREVIEW") {
                uploadThumbnail(tab, msg.styleId, msg.preset === true);
            }
            if (msg.type === "SG_DELETE_STYLE") {
                var styleToDelete = findStyleByName(msg.styleId);
                if (styleToDelete) {
                    deleteStyle(tab, styleToDelete.name, styleToDelete.source || styleToDelete.source_file, refreshAndNotifyFrame);
                }
            }
        });

        var promptSyncTimer = null;
        function schedulePromptStateSync(event) {
            var promptEl = qs("#" + tab + "_prompt textarea");
            var negEl = qs("#" + tab + "_neg_prompt textarea");
            if (event.target !== promptEl && event.target !== negEl) return;
            clearTimeout(promptSyncTimer);
            promptSyncTimer = setTimeout(function () {
                postPromptStateToFrame(tab, frame);
            }, 60);
        }
        document.addEventListener("input", schedulePromptStateSync, true);
        document.addEventListener("change", schedulePromptStateSync, true);

        return frame;
    }

    function ensureSGFramesOnce() {
        if (!state.txt2img.sgFrame) state.txt2img.sgFrame = initSGFrame("txt2img");
        if (!state.img2img.sgFrame) state.img2img.sgFrame = initSGFrame("img2img");
        installForgeMainTabSyncForV2();
    }

    function init() {
        let observer = null;

        function stopObserver() {
            if (observer) { observer.disconnect(); observer = null; }
        }

        function tryInject() {
            const t1 = !!qs("#sg_trigger_txt2img") || injectButton("txt2img");
            const t2 = !!qs("#sg_trigger_img2img") || injectButton("img2img");
            if (t1 && t2) {
                stopObserver(); // ← kill observer once both buttons are alive
                startPolling();
                return true;
            }
            return false;
        }

        function startObserver() {
            if (observer) return; // already watching
            observer = new MutationObserver(function() {
                // Only act if our buttons actually vanished
                if (!qs("#sg_trigger_txt2img") || !qs("#sg_trigger_img2img")) {
                    clearTimeout(observer._timer);
                    observer._timer = setTimeout(tryInject, 400);
                }
            });
            const root = qs("#gradio-app") || qs(".gradio-container") || document.body;
            observer.observe(root, { childList: true, subtree: true });
        }

        // Progressive delays for initial inject
        [800, 1500, 3000, 6000].forEach(function(d) {
            setTimeout(function() {
                if (!qs("#sg_trigger_txt2img") || !qs("#sg_trigger_img2img")) tryInject();
            }, d);
        });

        // Observer as safety net, not primary mechanism
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", function() {
                setTimeout(startObserver, 500);
            });
        } else {
            setTimeout(startObserver, 500);
        }
    }

    init();

    if (typeof onUiLoaded === "function") {
        onUiLoaded(function () {
            state.txt2img.sgFrame = state.txt2img.sgFrame || initSGFrame("txt2img");
            state.img2img.sgFrame = state.img2img.sgFrame || initSGFrame("img2img");
            installForgeMainTabSyncForV2();
        });
    } else if (document.body) {
        ensureSGFramesOnce();
    } else {
        document.addEventListener("DOMContentLoaded", ensureSGFramesOnce);
    }
})();
