"""
Tests for stylegrid.csv_io parse/save/delete behavior.

Duplicate names (save): save_style_to_csv updates the first matching row by name and stops;
remaining duplicate rows are left unchanged (see test_save_updates_first_duplicate_only).
"""
from stylegrid import csv_io


def test_parse_returns_expected_fields(tmp_csv):
    styles = csv_io.parse_styles_csv(str(tmp_csv))
    assert len(styles) == 3
    by_name = {s["name"]: s for s in styles}
    assert set(by_name["Test Style A"].keys()) >= {
        "name",
        "prompt",
        "negative_prompt",
        "description",
        "category_explicit",
        "organizer_tags",
        "source",
        "_source",
        "source_file",
    }
    assert by_name["Test Style A"]["source"] == by_name["Test Style A"]["_source"] == "styles.csv"
    # CSV column "category" is stored as category_explicit; "category" is added by categorize_styles().
    assert "category" not in by_name["Test Style A"]
    assert by_name["Test Style A"]["category_explicit"] == "BASE"
    assert by_name["Test Style B"]["category_explicit"] == "BODY"
    assert by_name["Style With Spaces"]["category_explicit"] == ""
    assert by_name["Test Style A"]["organizer_tags"] == []


def test_parse_normalizes_organizer_tags(tmp_path):
    path = tmp_path / "Tagged - Natural Language.csv"
    path.write_text(
        "name,prompt,negative_prompt,description,category,organizer_tags\n"
        'Tagged,p,,,Clothing,"Casual; Denim; casual"\n',
        encoding="utf-8",
    )

    style = csv_io.parse_styles_csv(str(path))[0]

    assert style["organizer_tags"] == ["Casual", "Denim"]


def test_parse_empty_prompt_and_negative_are_empty_strings(tmp_csv):
    styles = csv_io.parse_styles_csv(str(tmp_csv))
    spaces = next(s for s in styles if s["name"] == "Style With Spaces")
    b = next(s for s in styles if s["name"] == "Test Style B")
    assert spaces["prompt"] == "tag_c"
    assert spaces["negative_prompt"] == "bad_c"
    assert spaces["description"] == ""
    assert spaces["category_explicit"] == ""
    assert b["negative_prompt"] == ""
    assert isinstance(b["negative_prompt"], str)
    assert isinstance(spaces["description"], str)


def test_load_all_keeps_same_basename_in_different_dirs(tmp_path, monkeypatch):
    """Two styles.csv in different scanned dirs must not collapse by name."""
    d1 = tmp_path / "ext"
    d2 = tmp_path / "root"
    d1.mkdir()
    d2.mkdir()
    (d1 / "styles.csv").write_text(
        "name,prompt,negative_prompt,description,category\n"
        "SharedName,from_ext,,,\n",
        encoding="utf-8",
    )
    (d2 / "styles.csv").write_text(
        "name,prompt,negative_prompt,description,category\n"
        "SharedName,from_root,,,\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(
        csv_io,
        "get_all_styles_file_paths",
        lambda: [str(d1 / "styles.csv"), str(d2 / "styles.csv")],
    )
    styles = csv_io.load_all_styles()
    prompts = {s["prompt"] for s in styles if s["name"] == "SharedName"}
    assert prompts == {"from_ext", "from_root"}
    assert all(s.get("_source") == "styles.csv" for s in styles)


def test_parse_row_count_matches_data_rows(tmp_path):
    p = tmp_path / "x.csv"
    p.write_text(
        "name,prompt,negative_prompt,description,category\n"
        "One,a,,,\n"
        "Two,b,,,\n",
        encoding="utf-8",
    )
    assert len(csv_io.parse_styles_csv(str(p))) == 2


def test_parse_strips_name_whitespace(tmp_path):
    p = tmp_path / "w.csv"
    p.write_text(
        "name,prompt,negative_prompt,description,category\n"
        '  Trimmed Name  ,p,,,\n',
        encoding="utf-8",
    )
    styles = csv_io.parse_styles_csv(str(p))
    assert len(styles) == 1
    assert styles[0]["name"] == "Trimmed Name"


def test_parse_skips_empty_name_row(tmp_path):
    p = tmp_path / "e.csv"
    p.write_text(
        "name,prompt,negative_prompt,description,category\n"
        ",ghost,,,\n"
        "Real,x,,,\n",
        encoding="utf-8",
    )
    styles = csv_io.parse_styles_csv(str(p))
    assert [s["name"] for s in styles] == ["Real"]


def test_save_updates_existing_row_by_name(tmp_csv, patch_styles_dirs, monkeypatch):
    monkeypatch.setattr(csv_io, "invalidate_styles_cache", lambda: None)
    csv_io.save_style_to_csv(
        "Test Style A",
        "updated_prompt",
        "updated_neg",
        "updated_desc",
        source_file="styles.csv",
        category="NEWCAT",
    )
    styles = csv_io.parse_styles_csv(str(tmp_csv))
    a = next(s for s in styles if s["name"] == "Test Style A")
    assert a["prompt"] == "updated_prompt"
    assert a["negative_prompt"] == "updated_neg"
    assert a["description"] == "updated_desc"
    assert a["category_explicit"] == "NEWCAT"


def test_save_appends_new_name(tmp_csv, patch_styles_dirs, monkeypatch):
    monkeypatch.setattr(csv_io, "invalidate_styles_cache", lambda: None)
    csv_io.save_style_to_csv(
        "Brand New",
        "np",
        "nn",
        "nd",
        source_file="styles.csv",
        category="Z",
    )
    styles = csv_io.parse_styles_csv(str(tmp_csv))
    assert len(styles) == 4
    n = next(s for s in styles if s["name"] == "Brand New")
    assert n["prompt"] == "np"
    assert n["category_explicit"] == "Z"


def test_save_does_not_corrupt_other_rows(tmp_csv, patch_styles_dirs, monkeypatch):
    monkeypatch.setattr(csv_io, "invalidate_styles_cache", lambda: None)
    before = {s["name"]: dict(s) for s in csv_io.parse_styles_csv(str(tmp_csv))}
    csv_io.save_style_to_csv(
        "Test Style A",
        "only_a_changes",
        "bad_tag_a",
        "Desc A",
        source_file="styles.csv",
        category="BASE",
    )
    after = {s["name"]: dict(s) for s in csv_io.parse_styles_csv(str(tmp_csv))}
    assert after["Test Style B"] == before["Test Style B"]
    assert after["Style With Spaces"] == before["Style With Spaces"]
    assert after["Test Style A"]["prompt"] == "only_a_changes"


def test_replace_prompts_preserves_style_metadata_and_other_rows(tmp_csv, monkeypatch):
    monkeypatch.setattr(csv_io, "get_all_styles_file_paths", lambda: [str(tmp_csv)])
    monkeypatch.setattr(csv_io, "invalidate_styles_cache", lambda: None)

    before = {s["name"]: dict(s) for s in csv_io.parse_styles_csv(str(tmp_csv))}
    assert csv_io.replace_style_prompts_in_csv(
        "Test Style A",
        "replacement\nprompt",
        "replacement negative",
        source_file=str(tmp_csv),
    ) is True

    after = {s["name"]: dict(s) for s in csv_io.parse_styles_csv(str(tmp_csv))}
    assert after["Test Style A"]["prompt"] == "replacement\nprompt"
    assert after["Test Style A"]["negative_prompt"] == "replacement negative"
    assert after["Test Style A"]["description"] == before["Test Style A"]["description"]
    assert after["Test Style A"]["category_explicit"] == before["Test Style A"]["category_explicit"]
    assert after["Test Style B"] == before["Test Style B"]


def test_replace_prompts_does_not_create_missing_style(tmp_csv, monkeypatch):
    monkeypatch.setattr(csv_io, "get_all_styles_file_paths", lambda: [str(tmp_csv)])
    monkeypatch.setattr(csv_io, "invalidate_styles_cache", lambda: None)
    before = tmp_csv.read_bytes()

    assert csv_io.replace_style_prompts_in_csv(
        "Missing Style",
        "replacement",
        "negative",
        source_file=str(tmp_csv),
    ) is False
    assert tmp_csv.read_bytes() == before


def test_replace_prompts_uses_exact_absolute_source(tmp_path, monkeypatch):
    first_dir = tmp_path / "first"
    second_dir = tmp_path / "second"
    first_dir.mkdir()
    second_dir.mkdir()
    first = first_dir / "styles.csv"
    second = second_dir / "styles.csv"
    content = "name,prompt,negative_prompt,description,category\nShared,old,,,CAT\n"
    first.write_text(content, encoding="utf-8")
    second.write_text(content, encoding="utf-8")
    monkeypatch.setattr(
        csv_io,
        "get_all_styles_file_paths",
        lambda: [str(first), str(second)],
    )
    monkeypatch.setattr(csv_io, "invalidate_styles_cache", lambda: None)

    assert csv_io.replace_style_prompts_in_csv(
        "Shared",
        "second only",
        "new negative",
        source_file=str(second),
    ) is True
    assert csv_io.parse_styles_csv(str(first))[0]["prompt"] == "old"
    assert csv_io.parse_styles_csv(str(second))[0]["prompt"] == "second only"


def test_batch_categories_use_exact_source_and_preserve_rows(tmp_path, monkeypatch):
    first_dir = tmp_path / "first"
    second_dir = tmp_path / "second"
    first_dir.mkdir()
    second_dir.mkdir()
    first = first_dir / "styles.csv"
    second = second_dir / "styles.csv"
    content = "name,prompt,negative_prompt,description,category\nShared,keep,neg,desc,OLD\n"
    first.write_text(content, encoding="utf-8")
    second.write_text(content, encoding="utf-8")
    monkeypatch.setattr(csv_io, "get_all_styles_file_paths", lambda: [str(first), str(second)])
    monkeypatch.setattr(csv_io, "invalidate_styles_cache", lambda: None)

    updated = csv_io.set_style_categories_in_csv(
        [{"name": "Shared", "source": str(second)}],
        "NEW",
    )

    assert updated == 1
    assert csv_io.parse_styles_csv(str(first))[0]["category_explicit"] == "OLD"
    second_style = csv_io.parse_styles_csv(str(second))[0]
    assert second_style["category_explicit"] == "NEW"
    assert second_style["prompt"] == "keep"
    assert second_style["negative_prompt"] == "neg"
    assert second_style["description"] == "desc"


def test_rename_style_category_exact_and_family_across_sources(tmp_path, monkeypatch):
    natural = tmp_path / "Natural Language.csv"
    tags = tmp_path / "Tags.csv"
    content = (
        "name,prompt,negative_prompt,description,category\n"
        "Top,keep top,neg,desc,Clothing - Tops\n"
        "Bottom,keep bottom,neg,desc,Clothing - Bottoms\n"
        "Hair,keep hair,neg,desc,Hair - Styles\n"
    )
    natural.write_text(content, encoding="utf-8")
    tags.write_text(content, encoding="utf-8")
    monkeypatch.setattr(csv_io, "get_all_styles_file_paths", lambda: [str(natural), str(tags)])
    monkeypatch.setattr(csv_io, "invalidate_styles_cache", lambda: None)

    assert csv_io.rename_style_categories_in_csv(
        "Clothing", "Wardrobe", match_family=True
    ) == 4
    assert csv_io.rename_style_categories_in_csv(
        "Wardrobe - Tops", "Wardrobe - Shirts"
    ) == 2

    for path in (natural, tags):
        styles = {style["name"]: style for style in csv_io.parse_styles_csv(str(path))}
        assert styles["Top"]["category_explicit"] == "Wardrobe - Shirts"
        assert styles["Bottom"]["category_explicit"] == "Wardrobe - Bottoms"
        assert styles["Hair"]["category_explicit"] == "Hair - Styles"
        assert styles["Top"]["prompt"] == "keep top"


def test_style_tags_update_both_prompt_formats_and_preserve_other_rows(tmp_path, monkeypatch):
    natural = tmp_path / "Forgeventory - Natural Language.csv"
    tags = tmp_path / "Forgeventory - Tags.csv"
    natural.write_text(
        "name,prompt,negative_prompt,description,category,organizer_tags\n"
        'Shared,natural prompt,neg,desc,Clothing,"Casual; Old"\n'
        "Untouched,keep natural,,,Hair,Existing\n",
        encoding="utf-8",
    )
    tags.write_text(
        "name,prompt,negative_prompt,description,category,organizer_tags\n"
        'Shared,tag prompt,neg,desc,Clothing,"Casual; Old"\n'
        "Untouched,keep tags,,,Hair,Existing\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(csv_io, "get_all_styles_file_paths", lambda: [str(natural), str(tags)])
    monkeypatch.setattr(csv_io, "invalidate_styles_cache", lambda: None)

    updated, updated_rows = csv_io.set_style_organizer_tags_in_csv(
        [{"name": "Shared", "source": str(natural)}],
        additions=["Favorite", "casual"],
        removals=["Old"],
    )

    assert (updated, updated_rows) == (1, 2)
    for path, expected_prompt in ((natural, "natural prompt"), (tags, "tag prompt")):
        styles = {style["name"]: style for style in csv_io.parse_styles_csv(str(path))}
        assert styles["Shared"]["organizer_tags"] == ["Casual", "Favorite"]
        assert styles["Shared"]["prompt"] == expected_prompt
        assert styles["Untouched"]["organizer_tags"] == ["Existing"]


def test_rename_style_tag_across_prompt_formats(tmp_path, monkeypatch):
    natural = tmp_path / "Forgeventory - Natural Language.csv"
    tags = tmp_path / "Forgeventory - Tags.csv"
    content = (
        "name,prompt,negative_prompt,description,category,organizer_tags\n"
        'One,p,,,Clothing,"Casual; Favorite"\n'
        "Two,p,,,Hair,Favorite\n"
    )
    natural.write_text(content, encoding="utf-8")
    tags.write_text(content, encoding="utf-8")
    monkeypatch.setattr(csv_io, "get_all_styles_file_paths", lambda: [str(natural), str(tags)])
    monkeypatch.setattr(csv_io, "invalidate_styles_cache", lambda: None)

    assert csv_io.rename_style_organizer_tag_in_csv("favorite", "Pinned") == 4

    for path in (natural, tags):
        styles = {style["name"]: style for style in csv_io.parse_styles_csv(str(path))}
        assert styles["One"]["organizer_tags"] == ["Casual", "Pinned"]
        assert styles["Two"]["organizer_tags"] == ["Pinned"]


def test_delete_removes_row_by_name(tmp_csv, patch_styles_dirs, monkeypatch):
    monkeypatch.setattr(csv_io, "invalidate_styles_cache", lambda: None)
    before = len(csv_io.parse_styles_csv(str(tmp_csv)))
    csv_io.delete_style_from_csv("Test Style B", source_file="styles.csv")
    names = [s["name"] for s in csv_io.parse_styles_csv(str(tmp_csv))]
    assert "Test Style B" not in names
    assert len(names) == before - 1


def test_delete_nonexistent_name_no_raise(tmp_csv, patch_styles_dirs, monkeypatch):
    monkeypatch.setattr(csv_io, "invalidate_styles_cache", lambda: None)
    before = csv_io.parse_styles_csv(str(tmp_csv))
    # Implementation returns True and rewrites file with the same rows.
    assert csv_io.delete_style_from_csv("No Such Style", source_file="styles.csv") is True
    after = csv_io.parse_styles_csv(str(tmp_csv))
    assert len(after) == len(before)
    assert [s["name"] for s in after] == [s["name"] for s in before]


def test_save_updates_first_duplicate_only(tmp_path, patch_styles_dirs, monkeypatch):
    monkeypatch.setattr(csv_io, "invalidate_styles_cache", lambda: None)
    p = tmp_path / "styles.csv"
    p.write_text(
        "name,prompt,negative_prompt,description,category\n"
        "Dup,old1,,,\n"
        "Dup,old2,,,\n"
        "Other,x,,,\n",
        encoding="utf-8",
    )
    csv_io.save_style_to_csv(
        "Dup",
        "first_only",
        "",
        "",
        source_file="styles.csv",
        category="",
    )
    styles = csv_io.parse_styles_csv(str(p))
    dups = [s for s in styles if s["name"] == "Dup"]
    assert len(dups) == 2
    assert dups[0]["prompt"] == "first_only"
    assert dups[1]["prompt"] == "old2"
