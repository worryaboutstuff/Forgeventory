"""
Forgeventory - Grid/Gallery style selector for Stable Diffusion WebUI Forge
Replaces the clunky dropdown with a visual grid organized by categories.

Implementation lives in the `stylegrid` package; this file is the Forge script entry point.
"""

import os


import json

import gradio as gr  # type: ignore[reportMissingImports]
from modules import script_callbacks, scripts  # type: ignore[reportMissingImports]
from modules.processing import StableDiffusionProcessing  # type: ignore[reportMissingImports]
from stylegrid.cache import get_cached_styles
from stylegrid.config import DATA_DIR
from stylegrid.csv_io import categorize_styles, load_all_styles
from stylegrid.data_files import increment_usage, load_presets, load_usage
from stylegrid.routes import register_api
from stylegrid.wildcards import resolve_sg_wildcards_with_styles

script_callbacks.on_app_started(register_api)


def _dedup_prompt(prompt_str):
    """Remove duplicate tags from a comma-separated prompt.
    First occurrence wins. Weighted (tag:1.3) and plain tag are
    treated as the same identity via normalized key. BREAK is kept
    as-is and never deduplicated.
    """
    import re as _re
    out = []
    seen = {}
    for seg in prompt_str.split(","):
        s = seg.strip()
        if not s:
            continue
        if s.upper() == "BREAK":
            out.append(s)
            continue
        m = _re.match(r'^\((.+?):\d+\.?\d*\)$', s)
        key = m.group(1).strip().lower() if m else s.lower()
        if key not in seen:
            seen[key] = True
            out.append(s)
    return ", ".join(out)


def _apply_style_field(base, styles, field):
    """Apply a style field, including legacy ``{prompt}`` wrapper templates."""
    result = base
    additions = []
    for style in styles:
        value = style.get(field, "") or ""
        if not value:
            continue
        if "{prompt}" in value:
            result = value.replace("{prompt}", result)
        else:
            additions.append(value)
    parts = [result] + additions
    return _dedup_prompt(", ".join(value for value in parts if value))


class StyleGridScript(scripts.Script):
    def title(self):
        return "Forgeventory"

    def show(self, is_img2img):
        return scripts.AlwaysVisible

    def ui(self, is_img2img):
        tab_prefix = "img2img" if is_img2img else "txt2img"
        styles = load_all_styles()
        categories = categorize_styles(styles)
        styles_json = json.dumps({
            "categories": categories,
            "usage": load_usage(),
            "presets": load_presets(),
        }, ensure_ascii=False)
        order_file = os.path.join(DATA_DIR, "category_order.json")
        if os.path.isfile(order_file):
            try:
                with open(order_file, "r", encoding="utf-8") as f:
                    category_order = json.load(f)
            except Exception:
                category_order = sorted(categories.keys())
        else:
            category_order = sorted(categories.keys())
        with gr.Group(elem_id=f"style_grid_wrapper_{tab_prefix}", visible=False):
            styles_data = gr.Textbox(value=styles_json, visible=False, elem_id=f"style_grid_data_{tab_prefix}")
            selected_styles = gr.Textbox(value="[]", visible=False, elem_id=f"style_grid_selected_{tab_prefix}")
            silent_styles = gr.Textbox(value="[]", visible=False, elem_id=f"style_grid_silent_{tab_prefix}")
            source_filter = gr.Textbox(value="", visible=False, elem_id=f"style_grid_source_{tab_prefix}")
            temporary_wildcards = gr.Textbox(value="{}", visible=False, elem_id=f"style_grid_temp_wildcards_{tab_prefix}")
            gr.Button(visible=False, elem_id=f"style_grid_apply_trigger_{tab_prefix}")
        with gr.Group(visible=False):
            gr.Textbox(value=json.dumps(category_order), visible=False, elem_id=f"style_grid_cat_order_{tab_prefix}")
        return [silent_styles, source_filter, temporary_wildcards]

    def process(self, p: StableDiffusionProcessing, *args):
        """Silent mode: inject styles into prompt at generation time."""
        all_styles = list(get_cached_styles())
        categorize_styles(all_styles)

        # args[1] = active source filter passed from UI ("" means All Sources)
        active_source = (args[1] if len(args) >= 2 else "") or ""
        if active_source:
            active_source_key = os.path.normcase(os.path.normpath(active_source))
            wildcard_pool = [
                s for s in all_styles
                if os.path.normcase(os.path.normpath(s.get("source_file") or ""))
                == active_source_key
            ]
            if not wildcard_pool:           # unknown source — fall back to all
                wildcard_pool = all_styles
        else:
            wildcard_pool = all_styles      # All Sources selected

        styles_by_cat = {}
        styles_by_name = {}
        for s in wildcard_pool:
            key = (s.get("category") or "").lower()
            styles_by_cat.setdefault(key, []).append(s)
            name_key = (s.get("name") or "").strip().lower()
            if name_key and name_key not in styles_by_name:
                styles_by_name[name_key] = s

        temporary_pools = {}
        if len(args) >= 3 and args[2]:
            try:
                raw_pools = json.loads(args[2])
                if isinstance(raw_pools, dict):
                    temporary_pools = {
                        str(pool_id): names
                        for pool_id, names in raw_pools.items()
                        if isinstance(names, list)
                    }
            except (TypeError, ValueError):
                pass

        for i in range(len(p.all_prompts)):
            resolved, chosen_styles = resolve_sg_wildcards_with_styles(
                p.all_prompts[i],
                styles_by_cat,
                styles_by_name,
                temporary_pools=temporary_pools,
            )
            p.all_prompts[i] = _dedup_prompt(resolved)
            if i < len(p.all_negative_prompts):
                p.all_negative_prompts[i] = _apply_style_field(
                    p.all_negative_prompts[i],
                    chosen_styles,
                    "negative_prompt",
                )
        for i in range(len(p.all_negative_prompts)):
            resolved, _ = resolve_sg_wildcards_with_styles(
                p.all_negative_prompts[i],
                styles_by_cat,
                styles_by_name,
                field="negative_prompt",
                temporary_pools=temporary_pools,
            )
            p.all_negative_prompts[i] = _dedup_prompt(resolved)

        if len(args) < 1:
            return
        silent_json = args[0]
        if not silent_json or silent_json == "[]":
            return
        try:
            style_names = json.loads(silent_json)
        except Exception:
            return
        if not style_names or not isinstance(style_names, list):
            return
        style_map = {s["name"]: s for s in wildcard_pool}
        prompts_add = []
        neg_add = []
        for name in style_names:
            s = style_map.get(name)
            if not s:
                continue
            if s["prompt"]:
                if "{prompt}" in s["prompt"]:
                    for i in range(len(p.all_prompts)):
                        p.all_prompts[i] = s["prompt"].replace("{prompt}", p.all_prompts[i])
                else:
                    prompts_add.append(s["prompt"])
            if s["negative_prompt"]:
                if "{prompt}" in s["negative_prompt"]:
                    for i in range(len(p.all_negative_prompts)):
                        p.all_negative_prompts[i] = s["negative_prompt"].replace("{prompt}", p.all_negative_prompts[i])
                else:
                    neg_add.append(s["negative_prompt"])
        if prompts_add:
            style_tags = [t.strip() for s in prompts_add for t in s.split(",") if t.strip()]
            for i in range(len(p.all_prompts)):
                current_tags = [t.strip() for t in p.all_prompts[i].split(",") if t.strip()]
                seen = {t.lower() for t in current_tags}
                result = list(current_tags)
                for t in style_tags:
                    if t.lower() not in seen:
                        result.append(t)
                        seen.add(t.lower())
                p.all_prompts[i] = ", ".join(result)
        if neg_add:
            style_neg_tags = [t.strip() for s in neg_add for t in s.split(",") if t.strip()]
            for i in range(len(p.all_negative_prompts)):
                current_tags = [t.strip() for t in p.all_negative_prompts[i].split(",") if t.strip()]
                seen = {t.lower() for t in current_tags}
                result = list(current_tags)
                for t in style_neg_tags:
                    if t.lower() not in seen:
                        result.append(t)
                        seen.add(t.lower())
                p.all_negative_prompts[i] = ", ".join(result)
        p.extra_generation_params["Forgeventory"] = ", ".join(style_names)
        increment_usage(style_names)
