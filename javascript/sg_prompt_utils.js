/**
 * Prompt parsing and weight scaling helpers (browser globals).
 * Duplicated inside style_grid.js — keep in sync (see comment there).
 */
(function (g) {
    "use strict";

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

    /** Remove the last unchanged standalone block and one adjoining line break. */
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

    /** Remove an untouched generated LoRA line, or only its token after edits. */
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

    g.insertPromptTokenAtSelection = insertPromptTokenAtSelection;
    g.splitTopLevelCommas = splitTopLevelCommas;
    g.stripParenLayers = stripParenLayers;
    g.parseSegmentToTagged = parseSegmentToTagged;
    g.parseStylePromptTags = parseStylePromptTags;
    g.scalePromptWeights = scalePromptWeights;
    g.promptHasLoraToken = promptHasLoraToken;
    g.removeExactPromptBlock = removeExactPromptBlock;
    g.removeLoraPromptText = removeLoraPromptText;
})(typeof window !== "undefined" ? window : globalThis);
