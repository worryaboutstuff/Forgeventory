"""CSV parsing, style CRUD, categorization."""

import csv
import os

from modules import shared

from stylegrid.cache import invalidate_styles_cache
from stylegrid.config import EXT_DIR, get_all_styles_file_paths

# Canonical CSV column order used when writing style rows back to disk.
FIELDNAMES = [
    "name",
    "prompt",
    "negative_prompt",
    "description",
    "category",
    "organizer_tags",
]


def normalize_style_tags(value):
    """Normalize organizer-only Style tags from a list or semicolon-separated CSV cell."""
    if value is None:
        return []
    if isinstance(value, str):
        values = value.split(";")
    elif isinstance(value, (list, tuple)):
        values = value
    else:
        raise ValueError("Style tags must be a list or semicolon-separated string")

    result = []
    seen = set()
    for item in values:
        if not isinstance(item, str):
            raise ValueError("Every Style tag must be a string")
        tag = item.strip()[:100]
        key = tag.casefold()
        if tag and key not in seen:
            result.append(tag)
            seen.add(key)
        if len(result) >= 25:
            break
    return result


def _serialize_style_tags(value):
    return "; ".join(normalize_style_tags(value))


def _sanitize_csv_cell(value):
    """Prevent CSV injection when opening in spreadsheet apps."""
    if isinstance(value, str) and value and value[0] in ('=', '+', '-', '@', '\t', '\r'):
        return "'" + value
    return value


def parse_styles_csv(filepath):
    """
    Parse one styles CSV file as UTF-8/UTF-8-BOM and return normalized style dicts.

    Returns list items with keys: name, prompt, negative_prompt, description,
    category_explicit, source (basename), and source_file (absolute path).
    """
    styles = []
    if not os.path.isfile(filepath):
        return styles
    try:
        with open(filepath, "r", encoding="utf-8-sig") as f:
            reader = csv.reader(f)
            header = None
            for row in reader:
                if not row or all(c.strip() == "" for c in row):
                    continue
                if header is None and row[0].strip().lower() == "name":
                    header = row
                    continue
                if header is None:
                    header = ["name", "prompt", "negative_prompt"]
                name = row[0].strip() if len(row) > 0 else ""
                prompt = row[1].strip() if len(row) > 1 else ""
                negative = row[2].strip() if len(row) > 2 else ""
                description = row[3].strip() if len(row) > 3 else ""
                category_explicit = row[4].strip() if len(row) > 4 else ""
                organizer_tags = normalize_style_tags(row[5] if len(row) > 5 else "")
                if name:
                    base = os.path.basename(filepath)
                    styles.append({
                        "name": name,
                        "prompt": prompt,
                        "negative_prompt": negative,
                        "description": description,
                        "category_explicit": category_explicit,
                        "organizer_tags": organizer_tags,
                        "source": base,
                        "_source": base,
                        "source_file": os.path.abspath(filepath),
                    })
    except Exception:
        return styles
    return styles


def load_all_styles():
    """Merge CSVs from all style dirs; uniqueness is (source_file abspath, name), not basename."""
    all_styles = []
    seen_keys = set()
    for filepath in get_all_styles_file_paths():
        for s in parse_styles_csv(filepath):
            key = (s.get("source_file", ""), s["name"])
            if key not in seen_keys:
                seen_keys.add(key)
                all_styles.append(s)
    return all_styles


def _category_from_filename(source):
    if not source or not isinstance(source, str):
        return ""
    base = os.path.splitext(source.strip())[0].strip()
    if not base:
        return ""
    return base[0].upper() + base[1:]


def categorize_styles(styles):
    categories = {}
    for s in styles:
        name = s["name"]
        source = s.get("source") or ""
        explicit_cat = s.get("category_explicit", "").strip()
        if explicit_cat:
            cat = explicit_cat
            display = name.split("_", 1)[1].replace("_", " ") if "_" in name else name
        elif "_" in name:
            before, rest = name.split("_", 1)
            cat = before.upper()
            display = rest.replace("_", " ")
        elif "-" in name:
            before, rest = name.split("-", 1)
            cat = before
            display = rest.replace("-", " ")
        else:
            cat = _category_from_filename(source)
            if not cat:
                cat = "OTHER"
            display = name.replace("_", " ")
        s["category"] = cat
        s["display_name"] = display
        s["has_placeholder"] = "{prompt}" in (s.get("prompt") or "") or "{prompt}" in (s.get("negative_prompt") or "")
        if cat not in categories:
            categories[cat] = []
        categories[cat].append(s)
    for cat in categories:
        categories[cat].sort(key=lambda x: (x.get("display_name") or x["name"] or "").lower())
    return categories


def save_style_to_csv(
    name,
    prompt,
    negative_prompt,
    description="",
    source_file=None,
    category=None,
    organizer_tags=None,
):
    """
    Upsert a style row in target CSV: replace the first matching name row, or append new row.
    """
    if source_file:
        source_file = os.path.basename(source_file)
        if not source_file.lower().endswith('.csv'):
            source_file = source_file + '.csv'
    if not source_file:
        source_file = "styles.csv"
    target_path = None
    for fp in get_all_styles_file_paths():
        if os.path.basename(fp) == source_file:
            target_path = fp
            break
    if not target_path:
        ext_styles = os.path.join(EXT_DIR, "styles")
        os.makedirs(ext_styles, exist_ok=True)
        target_path = os.path.join(ext_styles, source_file)
    rows = []
    header = None
    if os.path.isfile(target_path):
        with open(target_path, "r", encoding="utf-8-sig") as f:
            reader = csv.reader(f)
            for row in reader:
                if header is None and row and row[0].strip().lower() == "name":
                    header = row
                    continue
                rows.append(row)
    if not header:
        header = list(FIELDNAMES)
    elif len(header) < len(FIELDNAMES):
        header = header + FIELDNAMES[len(header):]

    def make_row(existing_row=None):
        existing_cat = existing_row[4].strip() if (
            existing_row and len(existing_row) > 4) else ""
        if category is None:
            cat_cell = existing_cat
        else:
            cat_cell = str(category).strip()
            cat_cell = _sanitize_csv_cell(cat_cell) if cat_cell else ""
        existing_tags = existing_row[5].strip() if (
            existing_row and len(existing_row) > 5
        ) else ""
        tags_cell = existing_tags if organizer_tags is None else _serialize_style_tags(organizer_tags)
        return [
            name,
            prompt,
            negative_prompt,
            _sanitize_csv_cell(description),
            cat_cell,
            _sanitize_csv_cell(tags_cell) if tags_cell else "",
        ]

    found = False
    for i, row in enumerate(rows):
        if row and row[0].strip() == name:
            rows[i] = make_row(rows[i])
            found = True
            break
    if not found:
        rows.append(make_row())
    with open(target_path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f, quoting=csv.QUOTE_ALL)
        writer.writerow(header)
        for row in rows:
            writer.writerow(row)
    invalidate_styles_cache()
    shared.prompt_styles.reload()
    return True


def _resolve_existing_style_path(source_file):
    """Resolve a requested source only to an already-scanned CSV file."""
    paths = get_all_styles_file_paths()
    if not source_file:
        return None

    requested = str(source_file).strip()
    if not requested:
        return None

    if os.path.isabs(requested):
        requested_abs = os.path.normcase(os.path.abspath(requested))
        for filepath in paths:
            if os.path.normcase(os.path.abspath(filepath)) == requested_abs:
                return filepath
        return None

    requested_base = os.path.basename(requested)
    if not requested_base.lower().endswith(".csv"):
        requested_base += ".csv"
    for filepath in paths:
        if os.path.basename(filepath) == requested_base:
            return filepath
    return None


def replace_style_prompts_in_csv(name, prompt, negative_prompt, source_file=None):
    """Replace only a style's prompt fields, preserving all other CSV cells."""
    target_path = _resolve_existing_style_path(source_file)
    if not target_path and not source_file:
        for style in load_all_styles():
            if style["name"] == name:
                target_path = _resolve_existing_style_path(style.get("source_file"))
                break
    if not target_path:
        return False

    rows = []
    header = None
    found = False
    with open(target_path, "r", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        for row in reader:
            if header is None and row and row[0].strip().lower() == "name":
                header = row
                continue
            if not found and row and row[0].strip() == name:
                while len(row) < len(FIELDNAMES):
                    row.append("")
                row[1] = "" if prompt is None else str(prompt)
                row[2] = "" if negative_prompt is None else str(negative_prompt)
                found = True
            rows.append(row)

    if not found:
        return False
    if not header:
        header = list(FIELDNAMES)
    elif len(header) < len(FIELDNAMES):
        header = header + FIELDNAMES[len(header):]

    with open(target_path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f, quoting=csv.QUOTE_ALL)
        writer.writerow(header)
        writer.writerows(rows)

    invalidate_styles_cache()
    shared.prompt_styles.reload()
    return True


def set_style_categories_in_csv(items, category):
    """Set one explicit category on selected style rows while preserving every other cell."""
    if not isinstance(items, list):
        return 0
    clean_category = str(category or "").strip()
    if not clean_category:
        return 0
    clean_category = _sanitize_csv_cell(clean_category)

    requests_by_path = {}
    seen = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        source = item.get("source")
        target_path = _resolve_existing_style_path(source)
        if not name or not target_path:
            continue
        key = (os.path.normcase(os.path.abspath(target_path)), name)
        if key in seen:
            continue
        seen.add(key)
        requests_by_path.setdefault(target_path, set()).add(name)

    updated = 0
    for target_path, requested_names in requests_by_path.items():
        rows = []
        header = None
        updated_names = set()
        with open(target_path, "r", encoding="utf-8-sig") as f:
            reader = csv.reader(f)
            for row in reader:
                if header is None and row and row[0].strip().lower() == "name":
                    header = row
                    continue
                if row and row[0].strip() in requested_names and row[0].strip() not in updated_names:
                    while len(row) < len(FIELDNAMES):
                        row.append("")
                    row[4] = clean_category
                    updated_names.add(row[0].strip())
                    updated += 1
                rows.append(row)

        if not updated_names:
            continue
        if not header:
            header = list(FIELDNAMES)
        elif len(header) < len(FIELDNAMES):
            header = header + FIELDNAMES[len(header):]
        with open(target_path, "w", encoding="utf-8-sig", newline="") as f:
            writer = csv.writer(f, quoting=csv.QUOTE_ALL)
            writer.writerow(header)
            writer.writerows(rows)

    if updated:
        invalidate_styles_cache()
        shared.prompt_styles.reload()
    return updated


def rename_style_categories_in_csv(old_name, new_name, match_family=False):
    """Rename an exact category or a top-level category family across every style CSV."""
    old_category = str(old_name or "").strip()
    new_category = str(new_name or "").strip()
    if not old_category or not new_category:
        return 0

    old_key = old_category.casefold()
    planned_writes = []
    updated = 0

    for target_path in get_all_styles_file_paths():
        rows = []
        header = None
        file_updated = False
        with open(target_path, "r", encoding="utf-8-sig") as f:
            reader = csv.reader(f)
            for row in reader:
                if header is None and row and row[0].strip().lower() == "name":
                    header = row
                    continue

                if row and row[0].strip():
                    while len(row) < len(FIELDNAMES):
                        row.append("")
                    explicit_category = row[4].strip()
                    if explicit_category:
                        current_category = explicit_category
                    elif "_" in row[0].strip():
                        current_category = row[0].strip().split("_", 1)[0].upper()
                    elif "-" in row[0].strip():
                        current_category = row[0].strip().split("-", 1)[0]
                    else:
                        current_category = _category_from_filename(os.path.basename(target_path)) or "OTHER"

                    current_key = current_category.casefold()
                    suffix = current_category[len(old_category):] if (
                        match_family and current_key.startswith(old_key + " - ")
                    ) else ""
                    matches = current_key == old_key or bool(suffix)
                    if matches:
                        replacement = new_category + suffix if match_family else new_category
                        if len(replacement) > 100:
                            raise ValueError("Renamed category must be 100 characters or fewer")
                        row[4] = _sanitize_csv_cell(replacement)
                        updated += 1
                        file_updated = True
                rows.append(row)

        if file_updated:
            if not header:
                header = list(FIELDNAMES)
            elif len(header) < len(FIELDNAMES):
                header = header + FIELDNAMES[len(header):]
            planned_writes.append((target_path, header, rows))

    for target_path, header, rows in planned_writes:
        with open(target_path, "w", encoding="utf-8-sig", newline="") as f:
            writer = csv.writer(f, quoting=csv.QUOTE_ALL)
            writer.writerow(header)
            writer.writerows(rows)

    if updated:
        invalidate_styles_cache()
        shared.prompt_styles.reload()
    return updated


def _paired_style_paths(source_file):
    """Return an existing selected CSV and its Natural Language/Tags partner, if present."""
    selected = _resolve_existing_style_path(source_file)
    if not selected:
        return []
    selected_path = os.path.normcase(os.path.abspath(selected))
    result = [selected]
    basename = os.path.basename(selected)
    lower = basename.casefold()
    if lower.endswith(" - natural language.csv"):
        partner_name = basename[:-len(" - Natural Language.csv")] + " - Tags.csv"
    elif lower.endswith(" - tags.csv"):
        partner_name = basename[:-len(" - Tags.csv")] + " - Natural Language.csv"
    elif lower == "natural language.csv":
        partner_name = "Tags.csv"
    elif lower == "tags.csv":
        partner_name = "Natural Language.csv"
    else:
        partner_name = None
    if partner_name:
        partner = _resolve_existing_style_path(partner_name)
        if partner and os.path.normcase(os.path.abspath(partner)) != selected_path:
            result.append(partner)
    return result


def set_style_organizer_tags_in_csv(items, tags=None, additions=None, removals=None):
    """Set or patch Style organizer tags on selected rows and their paired prompt format."""
    if not isinstance(items, list):
        return 0, 0
    replacement = normalize_style_tags(tags) if tags is not None else None
    add_tags = normalize_style_tags(additions or [])
    remove_tags = normalize_style_tags(removals or [])
    add_keys = {tag.casefold() for tag in add_tags}
    if any(tag.casefold() in add_keys for tag in remove_tags):
        raise ValueError("A tag cannot be added and removed in the same update")

    requests_by_path = {}
    selected_names = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if not name:
            continue
        paths = _paired_style_paths(item.get("source"))
        if not paths:
            continue
        selected_names.add(name)
        for target_path in paths:
            requests_by_path.setdefault(target_path, set()).add(name)

    updated_rows = 0
    updated_names = set()
    for target_path, requested_names in requests_by_path.items():
        rows = []
        header = None
        file_updated = False
        with open(target_path, "r", encoding="utf-8-sig") as f:
            reader = csv.reader(f)
            for row in reader:
                if header is None and row and row[0].strip().lower() == "name":
                    header = row
                    continue
                if row and row[0].strip() in requested_names:
                    while len(row) < len(FIELDNAMES):
                        row.append("")
                    if replacement is not None:
                        next_tags = replacement
                    else:
                        current = normalize_style_tags(row[5])
                        remove_keys = {tag.casefold() for tag in remove_tags}
                        next_tags = [tag for tag in current if tag.casefold() not in remove_keys]
                        existing = {tag.casefold() for tag in next_tags}
                        for tag in add_tags:
                            if tag.casefold() not in existing:
                                next_tags.append(tag)
                                existing.add(tag.casefold())
                    serialized = _serialize_style_tags(next_tags)
                    row[5] = _sanitize_csv_cell(serialized) if serialized else ""
                    updated_rows += 1
                    updated_names.add(row[0].strip())
                    file_updated = True
                rows.append(row)

        if not file_updated:
            continue
        if not header:
            header = list(FIELDNAMES)
        elif len(header) < len(FIELDNAMES):
            header = header + FIELDNAMES[len(header):]
        with open(target_path, "w", encoding="utf-8-sig", newline="") as f:
            writer = csv.writer(f, quoting=csv.QUOTE_ALL)
            writer.writerow(header)
            writer.writerows(rows)

    if updated_rows:
        invalidate_styles_cache()
        shared.prompt_styles.reload()
    return len(updated_names & selected_names), updated_rows


def rename_style_organizer_tag_in_csv(old_name, new_name):
    """Rename one organizer tag everywhere it is assigned to a Style."""
    old_tag = str(old_name or "").strip()
    normalized_new = normalize_style_tags([new_name])
    if not old_tag or not normalized_new:
        return 0
    replacement = normalized_new[0]
    old_key = old_tag.casefold()
    updated = 0

    for target_path in get_all_styles_file_paths():
        rows = []
        header = None
        file_updated = False
        with open(target_path, "r", encoding="utf-8-sig") as f:
            reader = csv.reader(f)
            for row in reader:
                if header is None and row and row[0].strip().lower() == "name":
                    header = row
                    continue
                if row and row[0].strip():
                    while len(row) < len(FIELDNAMES):
                        row.append("")
                    current = normalize_style_tags(row[5])
                    if any(tag.casefold() == old_key for tag in current):
                        renamed = [replacement if tag.casefold() == old_key else tag for tag in current]
                        serialized = _serialize_style_tags(renamed)
                        row[5] = _sanitize_csv_cell(serialized) if serialized else ""
                        updated += 1
                        file_updated = True
                rows.append(row)
        if not file_updated:
            continue
        if not header:
            header = list(FIELDNAMES)
        elif len(header) < len(FIELDNAMES):
            header = header + FIELDNAMES[len(header):]
        with open(target_path, "w", encoding="utf-8-sig", newline="") as f:
            writer = csv.writer(f, quoting=csv.QUOTE_ALL)
            writer.writerow(header)
            writer.writerows(rows)

    if updated:
        invalidate_styles_cache()
        shared.prompt_styles.reload()
    return updated


def delete_style_from_csv(name, source_file=None):
    """Delete style row by name from selected/inferred source; returns False when not found."""
    if not source_file:
        for s in load_all_styles():
            if s["name"] == name:
                source_file = s.get("source", "styles.csv")
                break
    if not source_file:
        return False
    if source_file:
        source_file = os.path.basename(source_file)
        if not source_file.lower().endswith('.csv'):
            source_file = source_file + '.csv'
    target_path = None
    for fp in get_all_styles_file_paths():
        if os.path.basename(fp) == source_file:
            target_path = fp
            break
    if not target_path:
        return False
    rows = []
    header = None
    with open(target_path, "r", encoding="utf-8-sig") as f:
        reader = csv.reader(f)
        for row in reader:
            if header is None and row and row[0].strip().lower() == "name":
                header = row
                continue
            if row and row[0].strip() != name:
                rows.append(row)
    with open(target_path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=FIELDNAMES,
            extrasaction="ignore",
            quoting=csv.QUOTE_ALL,
        )
        writer.writeheader()
        for row in rows:
            row_dict = {
                fn: (row[i].strip() if i < len(row) and row[i] is not None else "")
                for i, fn in enumerate(FIELDNAMES)
            }
            writer.writerow(row_dict)
    invalidate_styles_cache()
    shared.prompt_styles.reload()
    return True
