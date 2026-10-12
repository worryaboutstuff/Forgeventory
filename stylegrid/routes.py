"""FastAPI routes for Forgeventory."""

import base64
import csv
import hashlib
import io
import json
import logging
import mimetypes
import os
import re
import subprocess
import sys
import time
import zipfile
from pathlib import Path

from fastapi import HTTPException, Request  # type: ignore[reportMissingImports]
from fastapi.responses import (  # type: ignore[reportMissingImports]
    FileResponse,
    HTMLResponse,
    JSONResponse,
    Response,
)

from stylegrid.cache import (
    check_files_changed,
    get_cached_styles,
    invalidate_styles_cache,
    styles_cache_hashes,
)
from stylegrid.config import (
    DATA_DIR,
    EXT_DIR,
    PRESET_THUMBNAILS_DIR,
    THUMBNAILS_DIR,
    get_lora_dir,
)
from stylegrid.csv_io import (
    categorize_styles,
    delete_style_from_csv,
    load_all_styles,
    normalize_style_tags,
    rename_style_categories_in_csv,
    rename_style_organizer_tag_in_csv,
    replace_style_prompts_in_csv,
    save_style_to_csv,
    set_style_categories_in_csv,
    set_style_organizer_tags_in_csv,
)
from stylegrid.data_files import (
    backup_csv_files,
    increment_usage,
    load_presets,
    load_ui_preferences_with_status,
    load_usage,
    save_presets,
    update_ui_preferences,
)
from stylegrid.loras import (
    load_lora_tags,
    normalize_categories,
    public_lora_records,
    rename_lora_bundle,
    resolve_lora,
    save_lora_tags,
    validate_lora_stem,
)
from stylegrid.thumbnails import (
    _thumbnail_hash_input,
    get_thumbnail_path,
    list_thumbnails,
    thumbnail_generation_manager,
)

LOGGER = logging.getLogger(__name__)


def _parse_category_patch(data: dict):
    """Return explicit batch additions/removals, or None for legacy replacement calls."""
    if "add_categories" not in data and "remove_categories" not in data:
        return None
    additions = normalize_categories(data.get("add_categories", []))
    removals = normalize_categories(data.get("remove_categories", []))
    add_keys = {category.casefold() for category in additions}
    if any(category.casefold() in add_keys for category in removals):
        raise ValueError("A category cannot be added and removed in the same update")
    return additions, removals


def _apply_category_patch(current, additions, removals):
    """Preserve untouched categories while applying explicit batch changes."""
    categories = normalize_categories(current)
    remove_keys = {category.casefold() for category in removals}
    categories = [category for category in categories if category.casefold() not in remove_keys]
    existing = {category.casefold() for category in categories}
    for category in additions:
        key = category.casefold()
        if key not in existing:
            categories.append(category)
            existing.add(key)
    return normalize_categories(categories)


def detect_conflicts(style_names):
    styles_map = {s["name"]: s for s in get_cached_styles()}
    conflicts = []
    style_tokens = {}
    for name in style_names:
        s = styles_map.get(name)
        if not s:
            continue
        style_tokens[name] = {"positive": set(), "negative": set()}
        for token in (s.get("prompt") or "").split(","):
            t = token.strip().lower()
            if t and t != "{prompt}":
                style_tokens[name]["positive"].add(t)
        for token in (s.get("negative_prompt") or "").split(","):
            t = token.strip().lower()
            if t and t != "{prompt}":
                style_tokens[name]["negative"].add(t)
    names = list(style_tokens.keys())
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            a, b = names[i], names[j]
            overlap1 = style_tokens[a]["positive"] & style_tokens[b]["negative"]
            if overlap1:
                conflicts.append({
                    "styles": [a, b],
                    "type": "positive_vs_negative",
                    "tokens": list(overlap1)[:5],
                    "message": f"'{a}' adds tokens that '{b}' negates: {', '.join(list(overlap1)[:3])}"
                })
            overlap2 = style_tokens[b]["positive"] & style_tokens[a]["negative"]
            if overlap2:
                conflicts.append({
                    "styles": [b, a],
                    "type": "positive_vs_negative",
                    "tokens": list(overlap2)[:5],
                    "message": f"'{b}' adds tokens that '{a}' negates: {', '.join(list(overlap2)[:3])}"
                })
    return conflicts


def _register_style_routes(app):
    """Register style list/reload/conflict/export/import/category-order routes."""
    @app.get("/style_grid/styles")
    async def get_styles(request: Request):
        styles = get_cached_styles()
        categories = categorize_styles(styles)
        etag = hashlib.md5(json.dumps(styles_cache_hashes(), sort_keys=True).encode()).hexdigest()
        if_none_match = request.headers.get("If-None-Match", "").strip().strip('"')
        if if_none_match and if_none_match == etag:
            return Response(status_code=304)
        response = JSONResponse(content={"categories": categories, "usage": load_usage(), "presets": load_presets()})
        response.headers["ETag"] = etag
        return response

    @app.post("/style_grid/reload")
    async def reload_styles():
        check_files_changed()
        invalidate_styles_cache()
        styles = get_cached_styles()
        categories = categorize_styles(styles)
        return {"categories": categories, "usage": load_usage()}

    @app.get("/style_grid/check_update")
    async def api_check_update():
        return {"changed": check_files_changed()}

    @app.post("/style_grid/conflicts")
    async def api_conflicts(data: dict):
        return {"conflicts": detect_conflicts(data.get("styles", []))}

    @app.get("/style_grid/export")
    async def api_export():
        return {
            "styles": load_all_styles(),
            "presets": load_presets(),
            "usage": load_usage(),
            "exported_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }

    @app.post("/style_grid/import")
    async def api_import(request: Request):
        raw = await request.body()
        if not raw:
            return {"ok": True}
        if len(raw) >= 2 and raw[:2] == b"PK":
            try:
                with zipfile.ZipFile(io.BytesIO(raw)) as zf:
                    if "presets.json" in zf.namelist():
                        data = json.loads(zf.read("presets.json").decode("utf-8"))
                        if isinstance(data, dict):
                            save_presets(data)
            except Exception:
                pass
            return {"ok": True}
        try:
            data = json.loads(raw.decode("utf-8"))
        except Exception:
            raise HTTPException(status_code=422, detail="Invalid JSON") from None
        if not isinstance(data, dict):
            return {"ok": True}
        if "presets" in data:
            p = load_presets()
            p.update(data["presets"])
            save_presets(p)
        if "styles" in data and data["styles"]:
            ext_styles = os.path.join(EXT_DIR, "styles")
            os.makedirs(ext_styles, exist_ok=True)
            target = os.path.join(ext_styles, f"imported_{time.strftime('%Y%m%d_%H%M%S')}.csv")
            with open(target, "w", encoding="utf-8", newline="") as f:
                w = csv.writer(f)
                w.writerow(["name", "prompt", "negative_prompt", "description", "category"])
                for s in data["styles"]:
                    w.writerow([
                        s.get("name", ""),
                        s.get("prompt", ""),
                        s.get("negative_prompt", ""),
                        s.get("description", ""),
                        s.get("category", "") or s.get("category_explicit", ""),
                    ])
            invalidate_styles_cache()
        return {"ok": True}

    @app.post("/style_grid/category_order/save")
    async def api_save_category_order(data: dict):
        order = data.get("order", [])
        if not isinstance(order, list):
            return {"error": "order must be a list"}
        order_file = os.path.join(DATA_DIR, "category_order.json")
        with open(order_file, "w", encoding="utf-8") as f:
            json.dump(order, f, indent=2, ensure_ascii=False)
        return {"ok": True}


def _register_preset_routes(app):
    """Register preset CRUD routes."""
    def normalize_categories(value) -> list[str]:
        if value is None:
            return []
        if isinstance(value, str):
            values = value.split(",")
        elif isinstance(value, list):
            values = value
        else:
            raise ValueError("Categories must be a list or comma-separated string")

        categories = []
        seen = set()
        for item in values:
            if not isinstance(item, str):
                raise ValueError("Every category must be a string")
            category = item.strip()[:100]
            category_key = category.casefold()
            if category and category_key not in seen:
                categories.append(category)
                seen.add(category_key)
        return categories[:25]

    def preset_thumbnail_path(name: str) -> str:
        safe = hashlib.md5(name.encode("utf-8")).hexdigest()
        return os.path.join(PRESET_THUMBNAILS_DIR, safe + ".webp")

    @app.get("/style_grid/presets")
    async def get_presets():
        return load_presets()

    @app.post("/style_grid/presets/save")
    async def api_save_preset(data: dict):
        presets = load_presets()
        name = data.get("name", "").strip()
        styles = data.get("styles", [])
        if not name:
            return {"error": "Name required"}
        existing_preset = presets.get(name, {})
        existing_categories = existing_preset.get(
            "categories", existing_preset.get("category", "")
        )
        raw_categories = data.get(
            "categories", data.get("category", existing_categories)
        )
        try:
            categories = normalize_categories(raw_categories)
        except ValueError as error:
            return {"error": str(error)}
        created = time.strftime("%Y-%m-%dT%H:%M:%S")
        if data.get("mode") == "scene":
            prompt = data.get("prompt", "")
            negative_prompt = data.get("negative_prompt", "")
            if not isinstance(prompt, str) or not isinstance(negative_prompt, str):
                return {"error": "Scene prompts must be strings"}
            presets[name] = {
                "styles": [],
                "created": created,
                "mode": "scene",
                "prompt": prompt,
                "negative_prompt": negative_prompt,
            }
            if categories:
                presets[name]["categories"] = categories
        else:
            presets[name] = {"styles": styles, "created": created}
            if categories:
                presets[name]["categories"] = categories
        save_presets(presets)
        return {"ok": True, "presets": presets}

    @app.post("/style_grid/presets/replace")
    async def api_replace_preset_prompts(data: dict):
        presets = load_presets()
        name = data.get("name", "")
        prompt = data.get("prompt", "")
        negative_prompt = data.get("negative_prompt", "")
        if not isinstance(name, str) or not name.strip():
            return {"error": "Name required"}
        name = name.strip()
        if name not in presets:
            return {"error": "Preset not found"}
        if not isinstance(prompt, str) or not isinstance(negative_prompt, str):
            return {"error": "Scene prompts must be strings"}

        existing = presets[name]
        preset = dict(existing) if isinstance(existing, dict) else {}
        preset.update({
            "styles": [],
            "mode": "scene",
            "prompt": prompt,
            "negative_prompt": negative_prompt,
        })
        if not preset.get("created"):
            preset["created"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        presets[name] = preset
        save_presets(presets)
        return {"ok": True, "presets": presets}

    @app.post("/style_grid/presets/duplicate")
    async def api_duplicate_preset(data: dict):
        presets = load_presets()
        name = data.get("name", "")
        if not isinstance(name, str) or not name.strip():
            return {"error": "Name required"}
        name = name.strip()
        if name not in presets:
            return {"error": "Preset not found"}

        base_name = f"{name} Copy"
        new_name = base_name
        copy_number = 2
        while new_name in presets:
            new_name = f"{base_name} {copy_number}"
            copy_number += 1

        existing = presets[name]
        duplicate = dict(existing) if isinstance(existing, dict) else {}
        duplicate["created"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        if duplicate.get("name") == name:
            duplicate["name"] = new_name
        presets[new_name] = duplicate
        save_presets(presets)
        return {"ok": True, "name": new_name, "presets": presets}

    @app.post("/style_grid/presets/category")
    async def api_set_preset_category(data: dict):
        presets = load_presets()
        name = data.get("name", "").strip()
        if not name or name not in presets:
            return {"error": "Preset not found"}
        raw_categories = data.get("categories", data.get("category", []))
        try:
            categories = normalize_categories(raw_categories)
        except ValueError as error:
            return {"error": str(error)}
        if categories:
            presets[name]["categories"] = categories
        else:
            presets[name].pop("categories", None)
        presets[name].pop("category", None)
        save_presets(presets)
        return {"ok": True, "presets": presets}

    @app.post("/style_grid/presets/categories/batch")
    async def api_set_preset_categories_batch(data: dict):
        presets = load_presets()
        raw_names = data.get("names", [])
        if not isinstance(raw_names, list):
            return {"error": "Preset names must be a list"}
        names = list(dict.fromkeys(
            name.strip() for name in raw_names
            if isinstance(name, str) and name.strip()
        ))
        if not names:
            return {"error": "Select at least one preset"}
        missing = [name for name in names if name not in presets]
        if missing:
            return {"error": f"Preset not found: {missing[0]}"}
        try:
            patch = _parse_category_patch(data)
            categories = None if patch is not None else normalize_categories(data.get("categories", []))
        except ValueError as error:
            return {"error": str(error)}

        for name in names:
            preset = presets[name] if isinstance(presets[name], dict) else {}
            if patch is not None:
                additions, removals = patch
                current = preset.get("categories", preset.get("category", []))
                updated_categories = _apply_category_patch(current, additions, removals)
            else:
                updated_categories = categories
            if updated_categories:
                preset["categories"] = updated_categories
            else:
                preset.pop("categories", None)
            preset.pop("category", None)
            presets[name] = preset
        save_presets(presets)
        result = {"ok": True, "updated": len(names), "presets": presets}
        if patch is not None:
            result.update({"added": patch[0], "removed": patch[1]})
        return result

    @app.post("/style_grid/presets/categories/rename")
    async def api_rename_preset_category(data: dict):
        old_name = data.get("category", "")
        new_name = data.get("new_name", "")
        if not isinstance(old_name, str) or not isinstance(new_name, str):
            return {"error": "Category names must be strings"}
        old_name = old_name.strip()
        new_name = new_name.strip()
        if not old_name or old_name.casefold() == "uncategorized":
            return {"error": "A category name is required"}
        try:
            normalized_new = normalize_categories([new_name])
        except ValueError as error:
            return {"error": str(error)}
        if not normalized_new:
            return {"error": "New category name required"}
        replacement = normalized_new[0]
        old_key = old_name.casefold()
        presets = load_presets()
        updated = 0
        for name, raw_preset in presets.items():
            if not isinstance(raw_preset, dict):
                continue
            current = normalize_categories(raw_preset.get("categories", raw_preset.get("category", [])))
            if not any(category.casefold() == old_key for category in current):
                continue
            renamed = [replacement if category.casefold() == old_key else category for category in current]
            raw_preset["categories"] = normalize_categories(renamed)
            raw_preset.pop("category", None)
            presets[name] = raw_preset
            updated += 1
        if not updated:
            return {"error": "Category not found"}
        save_presets(presets)
        return {"ok": True, "updated": updated, "presets": presets}

    @app.post("/style_grid/presets/rename")
    async def api_rename_preset(data: dict):
        presets = load_presets()
        old_name = data.get("name", "")
        new_name = data.get("new_name", "")
        if not isinstance(old_name, str) or not isinstance(new_name, str):
            return {"error": "Preset names must be strings"}
        old_name = old_name.strip()
        new_name = new_name.strip()
        if not old_name or old_name not in presets:
            return {"error": "Preset not found"}
        if not new_name:
            return {"error": "New name required"}
        if len(new_name) > 200:
            return {"error": "Preset name must be 200 characters or fewer"}
        if new_name != old_name and new_name in presets:
            return {"error": "A preset with that name already exists"}
        if new_name == old_name:
            return {"ok": True, "presets": presets}

        renamed_presets = {}
        for preset_name, preset in presets.items():
            if preset_name == old_name:
                if isinstance(preset, dict) and preset.get("name") == old_name:
                    preset = {**preset, "name": new_name}
                renamed_presets[new_name] = preset
            else:
                renamed_presets[preset_name] = preset
        save_presets(renamed_presets)

        old_thumbnail = preset_thumbnail_path(old_name)
        new_thumbnail = preset_thumbnail_path(new_name)
        if os.path.isfile(old_thumbnail):
            try:
                os.replace(old_thumbnail, new_thumbnail)
            except OSError:
                pass
        return {"ok": True, "presets": renamed_presets}

    @app.post("/style_grid/presets/delete")
    async def api_delete_preset(data: dict):
        presets = load_presets()
        name = data.get("name", "")
        if name in presets:
            del presets[name]
            save_presets(presets)
            thumbnail_path = preset_thumbnail_path(name)
            if os.path.isfile(thumbnail_path):
                os.remove(thumbnail_path)
        return {"ok": True, "presets": presets}

    @app.get("/style_grid/presets/list")
    async def api_list_presets():
        return load_presets()

    @app.get("/style_grid/preset-thumbnail")
    async def api_get_preset_thumbnail(name: str = ""):
        path = preset_thumbnail_path(name)
        if os.path.isfile(path):
            return FileResponse(
                path,
                media_type="image/webp",
                headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"},
            )
        return Response(status_code=404)

    @app.post("/style_grid/preset-thumbnail/upload")
    async def api_upload_preset_thumbnail(data: dict):
        preset_name = data.get("name", "").strip()
        image_data = data.get("image", "")
        if not preset_name or not image_data:
            return {"error": "name and image required"}
        try:
            if "," in image_data:
                image_data = image_data.split(",", 1)[1]
            raw = base64.b64decode(image_data)
            if len(raw) > 2 * 1024 * 1024:
                return {"error": "Image too large (max 2MB)"}
            allowed_magic = [
                b"\xff\xd8\xff",
                b"\x89PNG\r\n\x1a\n",
                b"RIFF",
                b"GIF87a",
                b"GIF89a",
            ]
            is_valid_image = any(raw.startswith(magic) for magic in allowed_magic)
            if raw.startswith(b"RIFF") and raw[8:12] != b"WEBP":
                is_valid_image = False
            if not is_valid_image:
                return {"error": "Invalid image format. Allowed: JPEG, PNG, WEBP, GIF"}
            with open(preset_thumbnail_path(preset_name), "wb") as image_file:
                image_file.write(raw)
            return {"ok": True}
        except Exception as exc:
            return {"error": str(exc)}


def _register_usage_routes(app):
    """Register usage stats routes."""
    @app.get("/style_grid/usage")
    async def get_usage_route():
        return load_usage()

    @app.post("/style_grid/usage/increment")
    async def api_increment(data: dict):
        increment_usage(data.get("styles", []))
        return {"ok": True}


def _register_preferences_routes(app):
    """Register private server-backed UI preference routes."""
    @app.get("/style_grid/preferences")
    async def get_preferences_route():
        preferences, initialized = load_ui_preferences_with_status()
        return {"initialized": initialized, "preferences": preferences}

    @app.post("/style_grid/preferences")
    async def update_preferences_route(data: dict):
        try:
            preferences = update_ui_preferences(data)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return {"ok": True, "preferences": preferences}


def _register_lora_routes(app):
    """Register local-only LoRA discovery, preview, and category routes."""

    @app.get("/style_grid/loras")
    async def api_list_loras():
        loras = public_lora_records()
        categories = sorted(
            {category for lora in loras for category in lora.get("categories", [])},
            key=str.casefold,
        )
        return {"loras": loras, "categories": categories}

    @app.post("/style_grid/loras/refresh")
    async def api_refresh_loras():
        try:
            _refresh_forge_lora_registry(raise_on_error=True)
            loras = public_lora_records()
            return {"ok": True, "count": len(loras)}
        except Exception:
            LOGGER.exception("Could not refresh the LoRA registry")
            return {"error": "Could not reload the LoRA library. Check Forge's console for details."}

    @app.post("/style_grid/loras/categories")
    async def api_set_lora_categories(data: dict):
        model_id = str(data.get("id", "")).strip()
        if not model_id or resolve_lora(model_id) is None:
            return {"error": "LoRA not found"}
        try:
            categories = normalize_categories(data.get("categories", []))
        except ValueError as error:
            return {"error": str(error)}

        tags = load_lora_tags()
        if categories:
            tags[model_id] = categories
        else:
            tags.pop(model_id, None)
        save_lora_tags(tags)
        return {"ok": True, "categories": categories}

    @app.post("/style_grid/loras/categories/batch")
    async def api_set_lora_categories_batch(data: dict):
        raw_ids = data.get("ids", [])
        if not isinstance(raw_ids, list):
            return {"error": "LoRA ids must be a list"}
        model_ids = list(dict.fromkeys(
            model_id.strip() for model_id in raw_ids
            if isinstance(model_id, str) and model_id.strip()
        ))
        if not model_ids:
            return {"error": "Select at least one LoRA"}
        valid_ids = {record["id"] for record in public_lora_records()}
        missing = [model_id for model_id in model_ids if model_id not in valid_ids]
        if missing:
            return {"error": "LoRA not found"}
        try:
            patch = _parse_category_patch(data)
            categories = None if patch is not None else normalize_categories(data.get("categories", []))
        except ValueError as error:
            return {"error": str(error)}

        tags = load_lora_tags()
        for model_id in model_ids:
            if patch is not None:
                additions, removals = patch
                updated_categories = _apply_category_patch(tags.get(model_id, []), additions, removals)
            else:
                updated_categories = categories
            if updated_categories:
                tags[model_id] = updated_categories
            else:
                tags.pop(model_id, None)
        save_lora_tags(tags)
        result = {"ok": True, "updated": len(model_ids)}
        if patch is not None:
            result.update({"added": patch[0], "removed": patch[1]})
        else:
            result["categories"] = categories
        return result

    @app.post("/style_grid/loras/categories/rename")
    async def api_rename_lora_category(data: dict):
        old_name = data.get("category", "")
        new_name = data.get("new_name", "")
        if not isinstance(old_name, str) or not isinstance(new_name, str):
            return {"error": "Tag names must be strings"}
        old_name = old_name.strip()
        new_name = new_name.strip()
        if not old_name or old_name.casefold() == "uncategorized":
            return {"error": "A tag name is required"}
        try:
            normalized_new = normalize_categories([new_name])
        except ValueError as error:
            return {"error": str(error)}
        if not normalized_new:
            return {"error": "New tag name required"}
        replacement = normalized_new[0]
        old_key = old_name.casefold()
        tags = load_lora_tags()
        updated = 0
        for model_id, current in list(tags.items()):
            if not any(category.casefold() == old_key for category in current):
                continue
            renamed = [replacement if category.casefold() == old_key else category for category in current]
            tags[model_id] = normalize_categories(renamed)
            updated += 1
        if not updated:
            return {"error": "Tag not found"}
        save_lora_tags(tags)
        return {"ok": True, "updated": updated}

    @app.post("/style_grid/loras/rename")
    async def api_rename_lora(data: dict):
        model_id = str(data.get("id", "")).strip()
        new_name = data.get("new_name", "")
        if not model_id:
            return {"error": "LoRA not found"}
        if not isinstance(new_name, str):
            return {"error": "LoRA name must be a string"}

        unload_before_rename = data.get("unload_before_rename") is True
        try:
            record = resolve_lora(model_id)
            if record is None:
                raise FileNotFoundError("LoRA not found")
            validated_name = validate_lora_stem(new_name)
            if validated_name == record["name"]:
                return {
                    "ok": True,
                    "old_name": record["name"],
                    "new_name": record["name"],
                    "id": model_id,
                    "renamed": [],
                }
            if unload_before_rename:
                _unload_forge_models_for_lora_rename()
            result = rename_lora_bundle(model_id, validated_name)
            _refresh_forge_lora_registry()
            return {"ok": True, **result}
        except (ValueError, FileNotFoundError, FileExistsError, RuntimeError) as error:
            return {"error": str(error)}
        except PermissionError:
            return {
                "error": (
                    "Windows is using one or more LoRA files. "
                    "Try again with 'Unload Forge model memory before renaming' enabled."
                ),
                "retry_with_unload": not unload_before_rename,
            }
        except OSError as error:
            message = getattr(error, "strerror", None) or "The LoRA files could not be renamed"
            if getattr(error, "winerror", None) in {5, 32, 33}:
                message = (
                    "Windows is using one or more LoRA files. "
                    "Try again with 'Unload Forge model memory before renaming' enabled."
                )
            return {"error": message, "retry_with_unload": not unload_before_rename}
        except Exception:
            LOGGER.exception("Unexpected LoRA rename failure")
            return {"error": "The LoRA could not be renamed. Check Forge's console for details."}

    @app.get("/style_grid/lora-preview")
    async def api_get_lora_preview(id: str = ""):
        record = resolve_lora(id)
        preview = record.get("_preview") if record else None
        if not preview or not os.path.isfile(preview):
            return Response(status_code=404)
        media_type = mimetypes.guess_type(preview)[0] or "application/octet-stream"
        return FileResponse(
            preview,
            media_type=media_type,
            headers={"Cache-Control": "private, no-cache, must-revalidate"},
        )


def _unload_forge_models_for_lora_rename():
    """Release Forge model and LoRA references before a Windows file rename."""
    from modules import sd_models, shared

    if str(getattr(getattr(shared, "state", None), "job", "")).strip():
        raise RuntimeError("Wait for the current generation to finish before unloading models")
    try:
        import networks

        networks.loaded_networks.clear()
    except Exception:
        pass
    sd_models.unload_model_weights()


def _refresh_forge_lora_registry(raise_on_error=False):
    """Refresh Forge's LoRA registry after filenames change when Forge is available."""
    try:
        import networks

        networks.list_available_networks()
    except Exception:
        if raise_on_error:
            raise


def _register_crud_routes(app):
    """Register style save/delete and backup routes."""
    @app.post("/style_grid/style/save")
    async def api_save_style(data: dict):
        name = data.get("name", "").strip()
        if not name:
            return {"error": "Name required"}
        save_style_to_csv(
            name,
            data.get("prompt", ""),
            data.get("negative_prompt", ""),
            data.get("description", ""),
            data.get("source"),
            category=data.get("category"),
            organizer_tags=data.get("organizer_tags"),
        )
        return {"ok": True}

    @app.post("/style_grid/style/delete")
    async def api_del_style(data: dict):
        name = data.get("name", "").strip()
        if not name:
            return {"error": "Name required"}
        delete_style_from_csv(name, data.get("source"))
        return {"ok": True}

    @app.post("/style_grid/style/replace")
    async def api_replace_style_prompts(data: dict):
        name = data.get("name", "").strip()
        if not name:
            return {"error": "Name required"}
        replaced = replace_style_prompts_in_csv(
            name,
            data.get("prompt", ""),
            data.get("negative_prompt", ""),
            data.get("source"),
        )
        if not replaced:
            return {"error": "Style not found in the selected source"}
        return {"ok": True}

    @app.post("/style_grid/styles/categories/batch")
    async def api_set_style_categories_batch(data: dict):
        items = data.get("styles")
        category = data.get("category")
        if not isinstance(items, list) or not items:
            return {"error": "Select at least one style"}
        if len(items) > 5000:
            return {"error": "Too many styles selected"}
        if not isinstance(category, str) or not category.strip():
            return {"error": "Category required"}
        category = category.strip()
        if len(category) > 100:
            return {"error": "Category must be 100 characters or fewer"}
        updated = set_style_categories_in_csv(items, category)
        if not updated:
            return {"error": "Selected styles were not found"}
        return {"ok": True, "updated": updated, "category": category}

    @app.post("/style_grid/styles/categories/rename")
    async def api_rename_style_category(data: dict):
        old_name = data.get("category", "")
        new_name = data.get("new_name", "")
        scope = data.get("scope", "exact")
        if not isinstance(old_name, str) or not isinstance(new_name, str):
            return {"error": "Category names must be strings"}
        old_name = old_name.strip()
        new_name = new_name.strip()
        if not old_name or old_name.casefold() == "uncategorized":
            return {"error": "Category required"}
        if not new_name:
            return {"error": "New category name required"}
        if len(new_name) > 100:
            return {"error": "Category must be 100 characters or fewer"}
        if scope not in ("exact", "family"):
            return {"error": "Invalid category rename scope"}
        try:
            updated = rename_style_categories_in_csv(
                old_name,
                new_name,
                match_family=scope == "family",
            )
        except ValueError as error:
            return {"error": str(error)}
        if not updated:
            return {"error": "Category was not found"}
        return {
            "ok": True,
            "updated": updated,
            "category": old_name,
            "new_name": new_name,
            "scope": scope,
        }

    @app.post("/style_grid/styles/tags/batch")
    async def api_set_style_tags_batch(data: dict):
        items = data.get("styles")
        if not isinstance(items, list) or not items:
            return {"error": "Select at least one Style"}
        if len(items) > 5000:
            return {"error": "Too many Styles selected"}
        try:
            patch = _parse_category_patch(data)
            tags = None if patch is not None else normalize_style_tags(
                data.get("organizer_tags", [])
            )
            updated, updated_rows = set_style_organizer_tags_in_csv(
                items,
                tags=tags,
                additions=patch[0] if patch is not None else None,
                removals=patch[1] if patch is not None else None,
            )
        except ValueError as error:
            return {"error": str(error)}
        if not updated:
            return {"error": "Selected Styles were not found"}
        result = {"ok": True, "updated": updated, "updated_rows": updated_rows}
        if patch is not None:
            result.update({"added": patch[0], "removed": patch[1]})
        else:
            result["organizer_tags"] = tags
        return result

    @app.post("/style_grid/styles/tags/rename")
    async def api_rename_style_tag(data: dict):
        old_name = data.get("tag", "")
        new_name = data.get("new_name", "")
        if not isinstance(old_name, str) or not isinstance(new_name, str):
            return {"error": "Style tag names must be strings"}
        old_name = old_name.strip()
        if not old_name:
            return {"error": "Style tag required"}
        try:
            normalized_new = normalize_style_tags([new_name])
        except ValueError as error:
            return {"error": str(error)}
        if not normalized_new:
            return {"error": "New Style tag required"}
        updated = rename_style_organizer_tag_in_csv(old_name, normalized_new[0])
        if not updated:
            return {"error": "Style tag was not found"}
        return {"ok": True, "updated": updated, "tag": normalized_new[0]}

    @app.post("/style_grid/backup")
    async def api_backup():
        try:
            return {"ok": backup_csv_files()}
        except Exception as e:
            return {"error": str(e)}

    @app.post("/style_grid/open-lora-folder")
    async def api_open_lora_folder():
        lora_dir = get_lora_dir()
        try:
            os.makedirs(lora_dir, exist_ok=True)
            if os.name == "nt":
                os.startfile(lora_dir)  # type: ignore[attr-defined]
            elif sys.platform == "darwin":
                subprocess.Popen(["open", lora_dir])
            else:
                subprocess.Popen(["xdg-open", lora_dir])
            return {"ok": True}
        except Exception as error:
            return {"error": str(error)}


def _register_thumbnail_routes(app):
    """Register thumbnail list/get/upload/generate/delete/cleanup routes."""
    mgr = thumbnail_generation_manager

    @app.get("/style_grid/thumbnails/list")
    async def api_list_thumbnails():
        return {"has_thumbnail": list(list_thumbnails())}

    @app.get("/style_grid/thumbnail")
    async def api_get_thumbnail(name: str = ""):
        path = get_thumbnail_path(name)
        if os.path.isfile(path):
            return FileResponse(
                path,
                media_type="image/webp",
                headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"}
            )

        all_styles = get_cached_styles()
        matches = [s for s in all_styles if s.get("name") == name]
        seen = set()
        for style in reversed(matches):
            sf = style.get("source_file") or ""
            candidate = get_thumbnail_path(name, sf)
            if candidate not in seen:
                seen.add(candidate)
                if os.path.isfile(candidate):
                    return FileResponse(
                        candidate,
                        media_type="image/webp",
                        headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"}
                    )

        return Response(status_code=404)

    @app.post("/style_grid/thumbnail/upload")
    async def api_upload_thumbnail(data: dict):
        style_name = data.get("name", "").strip()
        image_data = data.get("image", "")
        if not style_name or not image_data:
            return {"error": "name and image required"}
        try:
            if "," in image_data:
                image_data = image_data.split(",", 1)[1]
            raw = base64.b64decode(image_data)
            if len(raw) > 2 * 1024 * 1024:
                return {"error": "Image too large (max 2MB)"}
            ALLOWED_MAGIC = [
                b'\xff\xd8\xff',
                b'\x89PNG\r\n\x1a\n',
                b'RIFF',
                b'GIF87a',
                b'GIF89a',
            ]
            is_valid_image = any(raw.startswith(m) for m in ALLOWED_MAGIC)
            if raw.startswith(b'RIFF') and raw[8:12] != b'WEBP':
                is_valid_image = False
            if not is_valid_image:
                return {"error": "Invalid image format. Allowed: JPEG, PNG, WEBP, GIF"}
            path = get_thumbnail_path(style_name)
            with open(path, "wb") as f:
                f.write(raw)
            return {"ok": True}
        except Exception as e:
            return {"error": str(e)}

    @app.get("/style_grid/thumbnail/gen_status")
    async def api_gen_status(name: str = ""):
        style_name = name
        return mgr.get_status(style_name)

    @app.post("/style_grid/thumbnail/generate")
    async def api_generate_thumbnail(data: dict):
        style_name = data.get("name", "").strip()
        requested_source = data.get("source", "").strip()
        if not style_name:
            return {"error": "name required"}

        try:
            from modules.shared import state as forge_state  # type: ignore[reportMissingImports]
            if getattr(forge_state, 'job', None):
                return {"error": "SD is busy, try again after current generation finishes"}
        except Exception:
            pass

        if not mgr.try_begin(style_name):
            return {"error": "already generating"}

        mgr.spawn_generate(style_name, requested_source)
        return {"ok": True, "status": "running"}

    @app.delete("/style_grid/thumbnail")
    async def api_delete_thumbnail(name: str = ""):
        path = get_thumbnail_path(name)
        if os.path.isfile(path):
            os.remove(path)
        return {"ok": True}

    @app.post("/style_grid/thumbnails/cleanup")
    async def api_cleanup_thumbnails():
        """Remove thumbnails for styles that no longer exist in any CSV."""
        if not os.path.isdir(THUMBNAILS_DIR):
            return {"removed": 0}
        valid_hashes = set()
        for s in get_cached_styles():
            h = hashlib.md5(
                _thumbnail_hash_input(s["name"], s.get("source_file") or "").encode("utf-8")
            ).hexdigest()
            valid_hashes.add(h)
        removed = 0
        for fname in os.listdir(THUMBNAILS_DIR):
            if not fname.endswith(".webp"):
                continue
            h = os.path.splitext(fname)[0]
            if h not in valid_hashes:
                try:
                    os.remove(os.path.join(THUMBNAILS_DIR, fname))
                    removed += 1
                except Exception:
                    pass
        return {"removed": removed}


def _get_ui_html() -> str:
    """
    Load built UI index.html and rewrite every relative asset URL (src/href="./...")
    to the Gradio file URL with a fresh ?v= cache buster on each call.
    """
    html_path = Path(__file__).parent.parent / "ui" / "dist" / "index.html"
    html = html_path.read_text(encoding="utf-8")
    v = str(int(time.time()))
    base = "/file=extensions/sd-webui-style-organizer/ui/dist"
    pattern = re.compile(
        r'(?P<attr>\b(?:src|href))=(?P<q>["\'])(?P<path>\./[^"\']+)(?P=q)',
        re.IGNORECASE,
    )
    def _sub(m: re.Match) -> str:
        rel = m.group("path")[2:]
        q = m.group("q")
        return f'{m.group("attr")}={q}{base}/{rel}?v={v}{q}'

    return pattern.sub(_sub, html)


def _register_ui_routes(app):
    """Serve V2 React iframe HTML with cache-busted asset URLs."""

    @app.get("/style_grid/ui")
    async def serve_ui():
        return HTMLResponse(content=_get_ui_html())


def register_api(demo, app):
    """
    Register all Forgeventory API groups on FastAPI app.

    Most handlers return HTTP 200 with `{ "error": ... }` payloads on logical failures;
    notable exceptions include `/styles` ETag 304 and `/thumbnail` 404.
    """
    _register_style_routes(app)
    _register_preset_routes(app)
    _register_usage_routes(app)
    _register_preferences_routes(app)
    _register_lora_routes(app)
    _register_crud_routes(app)
    _register_thumbnail_routes(app)
    _register_ui_routes(app)
