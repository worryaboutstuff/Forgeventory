"""{sg:...} wildcard resolution in prompts."""

import random
import re


def resolve_sg_wildcards_with_styles(
    prompt,
    styles_by_category,
    styles_by_name=None,
    field="prompt",
    temporary_pools=None,
):
    """Resolve Forgeventory tokens and return ``(text, exact_styles)``.

    Temporary pools take priority over exact style and category names. Exact
    style names take priority over category names. Category tokens retain their
    original random-choice behavior. ``field`` selects which style value is
    inserted, allowing the same token syntax in positive and negative prompts.
    """
    styles_by_name = {
        str(key).strip().lower(): value
        for key, value in (styles_by_name or {}).items()
    }
    temporary_pools = {
        str(key).strip().lower(): [
            str(name).strip().lower()
            for name in names
            if str(name).strip()
        ]
        for key, names in (temporary_pools or {}).items()
        if isinstance(names, (list, tuple))
    }
    exact_styles = []
    wrappers = []

    def replacer(m):
        token = m.group(1).strip().lower()
        is_temporary_pool = token in temporary_pools
        if is_temporary_pool:
            pool_candidates = [
                styles_by_name[name]
                for name in temporary_pools[token]
                if name in styles_by_name
            ]
            if not pool_candidates:
                return m.group(0)
            style = random.choice(pool_candidates)
            should_track_style = True
        else:
            style = styles_by_name.get(token)
            should_track_style = style is not None
        if style is None:
            candidates = styles_by_category.get(token)
            if not candidates:
                child_prefix = f"{token} - "
                candidates = [
                    candidate
                    for category, category_styles in styles_by_category.items()
                    if str(category).strip().lower().startswith(child_prefix)
                    for candidate in category_styles
                ]
            if candidates:
                style = random.choice(candidates)
        if style is None:
            return m.group(0)
        replacement = style.get(field, "") or ""
        if not replacement:
            if should_track_style:
                exact_styles.append(style)
                return ""
            return m.group(0)
        if should_track_style:
            exact_styles.append(style)
        if "{prompt}" in replacement:
            wrappers.append(replacement)
            return ""
        return replacement

    resolved = re.sub(r"\{sg:([^}]+)\}", replacer, prompt)
    for template in wrappers:
        resolved = template.replace("{prompt}", resolved)
    return resolved, exact_styles


def resolve_sg_wildcards(
    prompt,
    styles_by_category,
    styles_by_name=None,
    field="prompt",
    temporary_pools=None,
):
    """Resolve Forgeventory tokens and return only the expanded prompt text."""
    resolved, _ = resolve_sg_wildcards_with_styles(
        prompt,
        styles_by_category,
        styles_by_name=styles_by_name,
        field=field,
        temporary_pools=temporary_pools,
    )
    return resolved
