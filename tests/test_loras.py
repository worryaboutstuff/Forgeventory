"""LoRA browser discovery and local category behavior."""

from stylegrid import data_files
from stylegrid import loras as sg_loras


def _configure_lora_test_paths(monkeypatch, tmp_path):
    root = tmp_path / "models" / "Lora"
    root.mkdir(parents=True)
    tags_file = tmp_path / "runtime" / "lora_tags.json"
    monkeypatch.setattr(sg_loras, "get_lora_dirs", lambda: [str(root)])
    monkeypatch.setattr(sg_loras, "LORA_TAGS_FILE", str(tags_file))
    return root, tags_file


def test_scan_loras_uses_recursive_models_and_sidecar(monkeypatch, tmp_path):
    root, _ = _configure_lora_test_paths(monkeypatch, tmp_path)
    folder = root / "people"
    folder.mkdir()
    (folder / "portrait.safetensors").write_bytes(b"model")
    (folder / "portrait.preview.png").write_bytes(b"preview")

    records = sg_loras.public_lora_records()

    assert len(records) == 1
    assert records[0]["name"] == "portrait"
    assert records[0]["token"] == "<lora:portrait:1>"
    assert records[0]["relative_path"] == "people/portrait.safetensors"
    assert records[0]["has_preview"] is True
    assert not any(key.startswith("_") for key in records[0])


def test_scan_loras_uses_forge_prompt_metadata(monkeypatch, tmp_path):
    root, _ = _configure_lora_test_paths(monkeypatch, tmp_path)
    (root / "portrait.safetensors").write_bytes(b"model")
    (root / "portrait.json").write_text(
        '{"activation text": " portrait trigger ", "preferred weight": 0.72, '
        '"negative text": " blurry, artifacts "}',
        encoding="utf-8",
    )

    record = sg_loras.public_lora_records()[0]

    assert record["token"] == "<lora:portrait:0.72>"
    assert record["prompt"] == "<lora:portrait:0.72> portrait trigger"
    assert record["activation_text"] == "portrait trigger"
    assert record["negative_prompt"] == "blurry, artifacts"
    assert record["preferred_weight"] == 0.72
    assert record["effective_weight"] == 0.72


def test_zero_preferred_weight_uses_forge_default(monkeypatch, tmp_path):
    root, _ = _configure_lora_test_paths(monkeypatch, tmp_path)
    (root / "portrait.safetensors").write_bytes(b"model")
    (root / "portrait.json").write_text(
        '{"activation text": "portrait trigger", "preferred weight": 0}',
        encoding="utf-8",
    )
    monkeypatch.setattr(sg_loras, "_forge_default_lora_weight", lambda: 0.65)

    record = sg_loras.public_lora_records()[0]

    assert record["token"] == "<lora:portrait:0.65>"
    assert record["prompt"] == "<lora:portrait:0.65> portrait trigger"
    assert record["preferred_weight"] == 0.0
    assert record["effective_weight"] == 0.65


def test_malformed_forge_metadata_uses_safe_fallback(monkeypatch, tmp_path):
    root, _ = _configure_lora_test_paths(monkeypatch, tmp_path)
    (root / "portrait.safetensors").write_bytes(b"model")
    (root / "portrait.json").write_text("{not valid json", encoding="utf-8")
    monkeypatch.setattr(sg_loras, "_forge_default_lora_weight", lambda: 1.0)

    record = sg_loras.public_lora_records()[0]

    assert record["token"] == "<lora:portrait:1>"
    assert record["prompt"] == "<lora:portrait:1>"
    assert record["activation_text"] == ""
    assert record["negative_prompt"] == ""


def test_lora_categories_are_local_and_multi_value(monkeypatch, tmp_path):
    root, tags_file = _configure_lora_test_paths(monkeypatch, tmp_path)
    model = root / "subject.ckpt"
    model.write_bytes(b"model")
    model_id = sg_loras.lora_id(str(model))

    sg_loras.save_lora_tags({model_id: ["Models", "Subjects", "models", ""]})

    assert tags_file.is_file()
    assert sg_loras.load_lora_tags() == {model_id: ["Models", "Subjects"]}
    assert sg_loras.public_lora_records()[0]["categories"] == ["Models", "Subjects"]


def test_rename_lora_bundle_moves_sidecars_and_preserves_tags(monkeypatch, tmp_path):
    root, _ = _configure_lora_test_paths(monkeypatch, tmp_path)
    model = root / "old-name.safetensors"
    model.write_bytes(b"model")
    for suffix in (".png", ".preview.webp", ".json", ".description.txt"):
        (root / ("old-name" + suffix)).write_bytes(suffix.encode("utf-8"))
    unrelated = root / "old-name-extra.png"
    unrelated.write_bytes(b"unrelated")
    model_id = sg_loras.lora_id(str(model))
    sg_loras.save_lora_tags({model_id: ["Character", "Favorite"]})

    result = sg_loras.rename_lora_bundle(model_id, "new-name")

    expected = {
        "new-name.safetensors",
        "new-name.png",
        "new-name.preview.webp",
        "new-name.json",
        "new-name.description.txt",
    }
    assert set(result["renamed"]) == expected
    assert all((root / filename).is_file() for filename in expected)
    assert not any((root / ("old-name" + suffix)).exists() for suffix in (
        ".safetensors", ".png", ".preview.webp", ".json", ".description.txt"
    ))
    assert unrelated.is_file()
    assert sg_loras.load_lora_tags() == {result["id"]: ["Character", "Favorite"]}
    records = sg_loras.public_lora_records()
    assert records[0]["name"] == "new-name"
    assert records[0]["categories"] == ["Character", "Favorite"]


def test_rename_lora_bundle_rejects_collision_without_moving_files(monkeypatch, tmp_path):
    root, _ = _configure_lora_test_paths(monkeypatch, tmp_path)
    model = root / "old.safetensors"
    preview = root / "old.png"
    collision = root / "new.png"
    model.write_bytes(b"model")
    preview.write_bytes(b"preview")
    collision.write_bytes(b"existing")

    try:
        sg_loras.rename_lora_bundle(sg_loras.lora_id(str(model)), "new")
    except FileExistsError as error:
        assert "new.png" in str(error)
    else:
        raise AssertionError("Expected a sidecar collision")

    assert model.read_bytes() == b"model"
    assert preview.read_bytes() == b"preview"
    assert collision.read_bytes() == b"existing"


def test_validate_lora_stem_rejects_paths_and_reserved_names():
    for name in ("", "folder/name", "folder\\name", "CON", "bad:name", "trailing."):
        try:
            sg_loras.validate_lora_stem(name)
        except ValueError:
            pass
        else:
            raise AssertionError(f"Expected invalid LoRA name: {name!r}")


def test_starter_template_exists_without_local_presets(monkeypatch, tmp_path):
    monkeypatch.setattr(data_files, "PRESETS_FILE", str(tmp_path / "missing-presets.json"))

    presets = data_files.load_presets()

    assert list(presets) == ["Starter Template"]
    assert presets["Starter Template"]["pinned"] is True
    assert "**Subject**" in presets["Starter Template"]["prompt"]
