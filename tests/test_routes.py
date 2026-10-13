"""
HTTP tests for stylegrid.routes (FastAPI).

Patches CSV discovery so reads and writes use only the temporary test CSV.
Modules bind discovery helpers at import time, so csv_io and cache are patched
directly; thumbnail source-directory lookup is patched separately.

GET /style_grid/styles returns {"categories": {...}, "usage": {...}}; style
dicts live under each category key (not a top-level JSON array).

Dependencies: pip install pytest fastapi starlette httpx
"""
import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

from stylegrid.routes import register_api


def _flatten_styles(payload: dict) -> list:
    categories = payload.get("categories") or {}
    out = []
    for styles in categories.values():
        if isinstance(styles, list):
            out.extend(styles)
    return out


@pytest.fixture
def style_grid_client(tmp_csv, monkeypatch):
    tmp_dir = str(tmp_csv.parent)

    def fake_get_styles_dirs():
        return [tmp_dir]

    def fake_get_all_styles_file_paths():
        return [str(tmp_csv)]

    from stylegrid import cache as sg_cache
    from stylegrid import config as sg_config
    from stylegrid import csv_io as sg_csv_io
    from stylegrid import routes as sg_routes
    from stylegrid import thumbnails as sg_thumbs

    monkeypatch.setattr(
        sg_config,
        "get_all_styles_file_paths",
        fake_get_all_styles_file_paths,
    )
    monkeypatch.setattr(
        sg_csv_io,
        "get_all_styles_file_paths",
        fake_get_all_styles_file_paths,
    )
    monkeypatch.setattr(
        sg_cache,
        "get_all_styles_file_paths",
        fake_get_all_styles_file_paths,
    )
    monkeypatch.setattr(
        sg_routes,
        "get_all_styles_file_paths",
        fake_get_all_styles_file_paths,
    )
    monkeypatch.setattr(sg_thumbs, "get_styles_dirs", fake_get_styles_dirs)

    from stylegrid.cache import invalidate_styles_cache

    invalidate_styles_cache()

    app = FastAPI()
    register_api(None, app)
    with TestClient(app) as client:
        yield client


def test_get_styles_200_json_with_names(style_grid_client):
    r = style_grid_client.get("/style_grid/styles")
    assert r.status_code == 200
    data = r.json()
    styles = _flatten_styles(data)
    assert len(styles) >= 1
    for s in styles:
        assert "name" in s
        assert isinstance(s["name"], str)


def test_get_thumbnails_list_200_json(style_grid_client):
    r = style_grid_client.get("/style_grid/thumbnails/list")
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data, dict)
    assert "has_thumbnail" in data
    assert isinstance(data["has_thumbnail"], list)


def test_post_save_valid_200_no_error_key(style_grid_client):
    r = style_grid_client.post(
        "/style_grid/style/save",
        json={
            "name": "Route Save OK",
            "prompt": "p1",
            "negative_prompt": "n1",
            "description": "d1",
            "source": "styles.csv",
            "category": "CAT",
            "organizer_tags": ["Favorite", "Casual"],
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert "error" not in body
    assert body.get("ok") is True


def test_batch_style_tags_route_preserves_style_fields(style_grid_client, tmp_csv):
    response = style_grid_client.post(
        "/style_grid/styles/tags/batch",
        json={
            "styles": [{"name": "Test Style A", "source": str(tmp_csv)}],
            "add_categories": ["Favorite", "Casual"],
            "remove_categories": [],
        },
    )

    assert response.status_code == 200
    assert response.json()["updated"] == 1

    from stylegrid import csv_io

    style = next(
        item for item in csv_io.parse_styles_csv(str(tmp_csv))
        if item["name"] == "Test Style A"
    )
    assert style["organizer_tags"] == ["Favorite", "Casual"]
    assert style["prompt"] == "(tag_a:1.2)"
    assert style["description"] == "Desc A"

    renamed = style_grid_client.post(
        "/style_grid/styles/tags/rename",
        json={"tag": "favorite", "new_name": "Pinned"},
    )
    assert renamed.status_code == 200
    assert renamed.json()["updated"] == 1
    style = next(
        item for item in csv_io.parse_styles_csv(str(tmp_csv))
        if item["name"] == "Test Style A"
    )
    assert style["organizer_tags"] == ["Pinned", "Casual"]


def test_post_save_missing_name_error_or_422(style_grid_client):
    r = style_grid_client.post(
        "/style_grid/style/save",
        json={"prompt": "only prompt"},
    )
    assert r.status_code in (200, 422)
    if r.status_code == 200:
        assert "error" in r.json()
    # Current handler returns 200 + {"error": "Name required"} for empty name.


def test_post_save_duplicate_name_second_updates(style_grid_client, tmp_csv):
    n = "Dup Route Style"
    style_grid_client.post(
        "/style_grid/style/save",
        json={
            "name": n,
            "prompt": "first",
            "negative_prompt": "",
            "description": "",
            "source": "styles.csv",
        },
    )
    style_grid_client.post(
        "/style_grid/style/save",
        json={
            "name": n,
            "prompt": "second",
            "negative_prompt": "",
            "description": "",
            "source": "styles.csv",
        },
    )
    from stylegrid import csv_io

    rows = [s for s in csv_io.parse_styles_csv(str(tmp_csv)) if s["name"] == n]
    assert len(rows) == 1
    assert rows[0]["prompt"] == "second"


def test_post_delete_existing_removes_from_styles(style_grid_client):
    r = style_grid_client.post(
        "/style_grid/style/delete",
        json={"name": "Test Style B", "source": "styles.csv"},
    )
    assert r.status_code == 200
    assert r.json().get("ok") is True
    r2 = style_grid_client.get("/style_grid/styles")
    assert r2.status_code == 200
    names = {s["name"] for s in _flatten_styles(r2.json())}
    assert "Test Style B" not in names


def test_post_delete_nonexistent_graceful(style_grid_client):
    r = style_grid_client.post(
        "/style_grid/style/delete",
        json={"name": "Absolutely No Such Style 404", "source": "styles.csv"},
    )
    assert r.status_code == 200
    assert r.json().get("ok") is True


def test_batch_style_category_update_preserves_other_fields(style_grid_client, tmp_csv):
    response = style_grid_client.post(
        "/style_grid/styles/categories/batch",
        json={
            "styles": [
                {"name": "Test Style A", "source": str(tmp_csv)},
                {"name": "Test Style B", "source": str(tmp_csv)},
            ],
            "category": "Shared Category",
        },
    )
    assert response.status_code == 200
    assert response.json()["updated"] == 2

    from stylegrid import csv_io

    by_name = {style["name"]: style for style in csv_io.parse_styles_csv(str(tmp_csv))}
    assert by_name["Test Style A"]["category_explicit"] == "Shared Category"
    assert by_name["Test Style A"]["prompt"] == "(tag_a:1.2)"
    assert by_name["Test Style A"]["description"] == "Desc A"
    assert by_name["Test Style B"]["category_explicit"] == "Shared Category"
    assert by_name["Style With Spaces"]["category_explicit"] == ""


def test_rename_style_category_route(style_grid_client, tmp_csv):
    response = style_grid_client.post(
        "/style_grid/styles/categories/rename",
        json={"category": "BASE", "new_name": "Primary", "scope": "exact"},
    )
    assert response.status_code == 200
    assert response.json()["updated"] == 1

    from stylegrid import csv_io

    styles = {style["name"]: style for style in csv_io.parse_styles_csv(str(tmp_csv))}
    assert styles["Test Style A"]["category_explicit"] == "Primary"
    assert styles["Test Style B"]["category_explicit"] == "BODY"


def test_ui_preferences_migrate_validate_and_persist(style_grid_client, monkeypatch, tmp_path):
    from stylegrid import data_files

    preferences_file = tmp_path / "data" / "ui_preferences.json"
    monkeypatch.setattr(data_files, "UI_PREFERENCES_FILE", str(preferences_file))

    initial = style_grid_client.get("/style_grid/preferences")
    assert initial.status_code == 200
    assert initial.json()["initialized"] is False
    assert initial.json()["preferences"]["compact_mode"] is False

    saved = style_grid_client.post(
        "/style_grid/preferences",
        json={
            "compact_mode": True,
            "group_by_category": True,
            "favorites": ["Portrait", "portrait", "", 42],
            "recent_names": [f"Style {index}" for index in range(12)],
            "active_source": "C:/private/styles.csv",
            "category_order": ["Hair", "Clothing", "hair"],
            "style_multi_select": True,
            "style_tag_multi_select": True,
            "preset_multi_select": True,
            "lora_multi_select": True,
            "unsupported": "not persisted",
        },
    )

    assert saved.status_code == 200
    preferences = saved.json()["preferences"]
    assert preferences["compact_mode"] is True
    assert preferences["group_by_category"] is True
    assert preferences["favorites"] == ["Portrait"]
    assert len(preferences["recent_names"]) == 10
    assert preferences["category_order"] == ["Hair", "Clothing"]
    assert preferences["style_multi_select"] is True
    assert preferences["style_tag_multi_select"] is True
    assert "unsupported" not in preferences
    assert preferences_file.is_file()
    assert not (tmp_path / "data" / "ui_preferences.json.tmp").exists()

    reloaded = style_grid_client.get("/style_grid/preferences")
    assert reloaded.json() == {"initialized": True, "preferences": preferences}


def test_lora_routes_list_preview_and_save_categories(style_grid_client, monkeypatch, tmp_path):
    from stylegrid import loras as sg_loras
    from stylegrid import routes

    root = tmp_path / "loras"
    root.mkdir()
    model = root / "example.safetensors"
    preview = root / "example.png"
    model.write_bytes(b"model")
    preview.write_bytes(b"preview image bytes")
    monkeypatch.setattr(sg_loras, "get_lora_dirs", lambda: [str(root)])
    monkeypatch.setattr(sg_loras, "LORA_TAGS_FILE", str(tmp_path / "lora_tags.json"))

    listed = style_grid_client.get("/style_grid/loras")
    assert listed.status_code == 200
    loras = listed.json()["loras"]
    assert len(loras) == 1
    assert loras[0]["token"] == "<lora:example:1>"
    assert str(tmp_path) not in str(loras[0])

    model_id = loras[0]["id"]
    tagged = style_grid_client.post(
        "/style_grid/loras/categories",
        json={"id": model_id, "categories": ["Models", "Subjects"]},
    )
    assert tagged.status_code == 200
    assert tagged.json() == {"ok": True, "categories": ["Models", "Subjects"]}

    refreshed = style_grid_client.get("/style_grid/loras").json()
    assert refreshed["loras"][0]["categories"] == ["Models", "Subjects"]
    assert refreshed["categories"] == ["Models", "Subjects"]

    preview_response = style_grid_client.get(f"/style_grid/lora-preview?id={model_id}")
    assert preview_response.status_code == 200
    assert preview_response.content == b"preview image bytes"

    refresh_calls = []
    monkeypatch.setattr(
        routes,
        "_refresh_forge_lora_registry",
        lambda raise_on_error=False: refresh_calls.append(raise_on_error),
    )
    refreshed_library = style_grid_client.post("/style_grid/loras/refresh", json={})
    assert refreshed_library.status_code == 200
    assert refreshed_library.json() == {"ok": True, "count": 1}
    assert refresh_calls == [True]


def test_preset_batch_categories_and_category_rename(style_grid_client, monkeypatch):
    from stylegrid import routes

    saved = {
        "Alpha": {"styles": [], "categories": ["Character", "Old Tag"]},
        "Beta": {"styles": [], "categories": ["Celebrity"]},
        "Gamma": {"styles": [], "categories": ["Old Tag", "Keep"]},
    }

    monkeypatch.setattr(routes, "load_presets", lambda: {
        name: {**preset, "categories": list(preset.get("categories", []))}
        for name, preset in saved.items()
    })

    def save_presets(presets):
        saved.clear()
        saved.update(presets)

    monkeypatch.setattr(routes, "save_presets", save_presets)

    batch = style_grid_client.post(
        "/style_grid/presets/categories/batch",
        json={"names": ["Alpha", "Beta"], "categories": ["Character", "Celebrity"]},
    )
    assert batch.status_code == 200
    assert batch.json()["updated"] == 2
    assert saved["Alpha"]["categories"] == ["Character", "Celebrity"]
    assert saved["Beta"]["categories"] == ["Character", "Celebrity"]
    assert saved["Gamma"]["categories"] == ["Old Tag", "Keep"]

    renamed = style_grid_client.post(
        "/style_grid/presets/categories/rename",
        json={"category": "Old Tag", "new_name": "Archived"},
    )
    assert renamed.status_code == 200
    assert renamed.json()["updated"] == 1
    assert saved["Gamma"]["categories"] == ["Archived", "Keep"]

    saved["Alpha"]["categories"] = ["Character", "Krea"]
    saved["Beta"]["categories"] = ["Character", "Z-Image"]
    patched = style_grid_client.post(
        "/style_grid/presets/categories/batch",
        json={
            "names": ["Alpha", "Beta"],
            "add_categories": ["Blonde"],
            "remove_categories": ["Character"],
        },
    )
    assert patched.status_code == 200
    assert saved["Alpha"]["categories"] == ["Krea", "Blonde"]
    assert saved["Beta"]["categories"] == ["Z-Image", "Blonde"]
    assert saved["Gamma"]["categories"] == ["Archived", "Keep"]


def test_lora_batch_categories_and_tag_rename(style_grid_client, monkeypatch, tmp_path):
    from stylegrid import loras as sg_loras

    root = tmp_path / "loras"
    root.mkdir()
    first = root / "first.safetensors"
    second = root / "second.safetensors"
    first.write_bytes(b"first")
    second.write_bytes(b"second")
    tags_file = tmp_path / "lora_tags.json"
    monkeypatch.setattr(sg_loras, "get_lora_dirs", lambda: [str(root)])
    monkeypatch.setattr(sg_loras, "LORA_TAGS_FILE", str(tags_file))

    records = style_grid_client.get("/style_grid/loras").json()["loras"]
    model_ids = [record["id"] for record in records]
    batch = style_grid_client.post(
        "/style_grid/loras/categories/batch",
        json={"ids": model_ids, "categories": ["Character", "Celebrity"]},
    )
    assert batch.status_code == 200
    assert batch.json()["updated"] == 2
    assert all(
        record["categories"] == ["Character", "Celebrity"]
        for record in style_grid_client.get("/style_grid/loras").json()["loras"]
    )

    renamed = style_grid_client.post(
        "/style_grid/loras/categories/rename",
        json={"category": "Celebrity", "new_name": "Public Figure"},
    )
    assert renamed.status_code == 200
    assert renamed.json()["updated"] == 2
    assert all(
        record["categories"] == ["Character", "Public Figure"]
        for record in style_grid_client.get("/style_grid/loras").json()["loras"]
    )

    sg_loras.save_lora_tags({
        model_ids[0]: ["Celebrity", "Krea"],
        model_ids[1]: ["Character", "Z-Image"],
    })
    patched = style_grid_client.post(
        "/style_grid/loras/categories/batch",
        json={
            "ids": model_ids,
            "add_categories": ["Blonde"],
            "remove_categories": ["Celebrity"],
        },
    )
    assert patched.status_code == 200
    by_id = {
        record["id"]: record["categories"]
        for record in style_grid_client.get("/style_grid/loras").json()["loras"]
    }
    assert by_id[model_ids[0]] == ["Krea", "Blonde"]
    assert by_id[model_ids[1]] == ["Character", "Z-Image", "Blonde"]


def test_lora_rename_route_can_unload_and_refresh(style_grid_client, monkeypatch, tmp_path):
    from stylegrid import loras as sg_loras
    from stylegrid import routes

    root = tmp_path / "loras"
    root.mkdir()
    model = root / "before.safetensors"
    preview = root / "before.preview.png"
    model.write_bytes(b"model")
    preview.write_bytes(b"preview")
    monkeypatch.setattr(sg_loras, "get_lora_dirs", lambda: [str(root)])
    monkeypatch.setattr(sg_loras, "LORA_TAGS_FILE", str(tmp_path / "lora_tags.json"))

    calls = []
    monkeypatch.setattr(routes, "_unload_forge_models_for_lora_rename", lambda: calls.append("unload"))
    monkeypatch.setattr(routes, "_refresh_forge_lora_registry", lambda: calls.append("refresh"))
    model_id = style_grid_client.get("/style_grid/loras").json()["loras"][0]["id"]

    renamed = style_grid_client.post(
        "/style_grid/loras/rename",
        json={"id": model_id, "new_name": "after", "unload_before_rename": True},
    )

    assert renamed.status_code == 200
    assert renamed.json()["ok"] is True
    assert renamed.json()["new_name"] == "after"
    assert calls == ["unload", "refresh"]
    assert (root / "after.safetensors").is_file()
    assert (root / "after.preview.png").is_file()
    assert style_grid_client.get("/style_grid/loras").json()["loras"][0]["name"] == "after"


def test_ui_html_uses_installed_extension_folder(monkeypatch, tmp_path):
    from stylegrid import routes

    extension_root = tmp_path / "Forgeventory"
    dist_dir = extension_root / "ui" / "dist"
    dist_dir.mkdir(parents=True)
    (dist_dir / "index.html").write_text(
        '<script src="./assets/index.js"></script>'
        '<link rel="stylesheet" href="./assets/index.css">',
        encoding="utf-8",
    )
    monkeypatch.setattr(routes, "EXT_DIR", str(extension_root))

    html = routes._get_ui_html()

    assert "/file=extensions/Forgeventory/ui/dist/assets/index.js?v=" in html
    assert "/file=extensions/Forgeventory/ui/dist/assets/index.css?v=" in html
    assert "sd-webui-style-organizer/ui/dist" not in html


def test_shared_style_export_and_import_assigns_local_metadata(
    style_grid_client,
    monkeypatch,
    tmp_csv,
    tmp_path,
):
    import base64

    from stylegrid import csv_io, routes
    from stylegrid.sharing import create_share_package, read_share_package

    exported = style_grid_client.get(
        "/style_grid/share/style",
        params={"name": "Test Style A", "source": "styles.csv"},
    )
    assert exported.status_code == 200
    assert exported.headers["content-type"].startswith("application/vnd.forgeventory.item+zip")
    exported_manifest, exported_preview = read_share_package(exported.content)
    assert exported_manifest["kind"] == "style"
    assert exported_manifest["item"]["variants"][0]["prompt"] == "(tag_a:1.2)"
    assert exported_preview is None

    preview = b"RIFF\x08\x00\x00\x00WEBPVP8 "
    manifest = {
        "schema": "forgeventory.shared-item",
        "version": 1,
        "kind": "style",
        "item": {
            "name": "Imported Style",
            "description": "Shared description",
            "suggested_category": "Sender Category",
            "suggested_tags": ["Sender Tag"],
            "variants": [{
                "format": "generic",
                "prompt": "portable prompt",
                "negative_prompt": "portable negative",
            }],
        },
    }
    encoded = base64.b64encode(create_share_package(manifest, preview)).decode("ascii")
    preview_path = tmp_path / "imported.webp"
    monkeypatch.setattr(routes, "backup_csv_files", lambda: True)
    monkeypatch.setattr(routes, "get_thumbnail_path", lambda _name, _source="": str(preview_path))

    inspected = style_grid_client.post(
        "/style_grid/share/inspect",
        json={"package": encoded},
    )
    assert inspected.status_code == 200
    target = inspected.json()["targets"][0]["id"]
    imported = style_grid_client.post(
        "/style_grid/share/import",
        json={
            "package": encoded,
            "name": "Imported Style",
            "target": target,
            "category": "Local Category",
            "tags": ["Local Tag", "Blue"],
            "duplicate": "copy",
        },
    )
    assert imported.status_code == 200
    assert imported.json()["name"] == "Imported Style"

    row = next(
        style for style in csv_io.parse_styles_csv(str(tmp_csv))
        if style["name"] == "Imported Style"
    )
    assert row["category_explicit"] == "Local Category"
    assert row["organizer_tags"] == ["Local Tag", "Blue"]
    assert row["prompt"] == "portable prompt"
    assert preview_path.read_bytes() == preview


def test_shared_style_export_ignores_an_invalid_optional_preview(
    style_grid_client,
    monkeypatch,
    tmp_path,
):
    from stylegrid import routes
    from stylegrid.sharing import read_share_package

    invalid_preview = tmp_path / "not-really-webp.webp"
    invalid_preview.write_bytes(b"not an image")
    monkeypatch.setattr(routes, "get_thumbnail_path", lambda _name, _source="": str(invalid_preview))

    exported = style_grid_client.get(
        "/style_grid/share/style",
        params={"name": "Test Style A", "source": "styles.csv"},
    )

    assert exported.status_code == 200
    _manifest, preview = read_share_package(exported.content)
    assert preview is None


def test_shared_preset_import_is_always_a_self_contained_scene(
    style_grid_client,
    monkeypatch,
    tmp_path,
):
    import base64

    from stylegrid import routes
    from stylegrid.sharing import create_share_package

    manifest = {
        "schema": "forgeventory.shared-item",
        "version": 1,
        "kind": "preset",
        "item": {
            "name": "Shared Scene",
            "description": "Portable scene preset",
            "prompt": "resolved positive prompt",
            "negative_prompt": "resolved negative prompt",
            "suggested_categories": ["Sender Group"],
        },
    }
    preview = b"RIFF\x08\x00\x00\x00WEBPVP8 "
    encoded = base64.b64encode(create_share_package(manifest, preview)).decode("ascii")
    stored = {}
    monkeypatch.setattr(routes, "load_presets", lambda: dict(stored))
    monkeypatch.setattr(routes, "save_presets", lambda presets: stored.update(presets))
    monkeypatch.setattr(routes, "backup_csv_files", lambda: True)
    preview_path = tmp_path / "preset.webp"
    monkeypatch.setattr(routes, "_preset_thumbnail_path", lambda _name: str(preview_path))

    imported = style_grid_client.post(
        "/style_grid/share/import",
        json={
            "package": encoded,
            "name": "Shared Scene",
            "categories": ["Local Group"],
            "duplicate": "copy",
        },
    )

    assert imported.status_code == 200
    assert stored["Shared Scene"] == {
        "styles": [],
        "created": stored["Shared Scene"]["created"],
        "mode": "scene",
        "prompt": "resolved positive prompt",
        "negative_prompt": "resolved negative prompt",
        "description": "Portable scene preset",
        "categories": ["Local Group"],
    }
    assert preview_path.read_bytes() == preview


def test_shared_generic_style_populates_both_prompt_formats(
    style_grid_client,
    monkeypatch,
    tmp_path,
):
    import base64

    from stylegrid import csv_io, routes
    from stylegrid.sharing import create_share_package

    natural_path = tmp_path / "Forgeventory - Natural Language.csv"
    tags_path = tmp_path / "Forgeventory - Tags.csv"
    header = "name,prompt,negative_prompt,description,category,organizer_tags\n"
    natural_path.write_text(header, encoding="utf-8")
    tags_path.write_text(header, encoding="utf-8")
    monkeypatch.setattr(routes, "get_all_styles_file_paths", lambda: [str(natural_path), str(tags_path)])
    monkeypatch.setattr(csv_io, "get_all_styles_file_paths", lambda: [str(natural_path), str(tags_path)])
    monkeypatch.setattr(routes, "backup_csv_files", lambda: True)

    manifest = {
        "schema": "forgeventory.shared-item",
        "version": 1,
        "kind": "style",
        "item": {
            "name": "Generic Shared Style",
            "description": "Portable generic prompt",
            "suggested_category": "Sender Category",
            "suggested_tags": [],
            "variants": [{
                "format": "generic",
                "prompt": "portable prompt",
                "negative_prompt": "portable negative",
            }],
        },
    }
    encoded = base64.b64encode(create_share_package(manifest)).decode("ascii")
    inspected = style_grid_client.post("/style_grid/share/inspect", json={"package": encoded})

    imported = style_grid_client.post(
        "/style_grid/share/import",
        json={
            "package": encoded,
            "target": inspected.json()["targets"][0]["id"],
            "category": "Local Category",
            "tags": [],
            "duplicate": "copy",
        },
    )

    assert imported.status_code == 200
    assert imported.json()["rows"] == 2
    for path in (natural_path, tags_path):
        row = csv_io.parse_styles_csv(str(path))[0]
        assert row["name"] == "Generic Shared Style"
        assert row["prompt"] == "portable prompt"
