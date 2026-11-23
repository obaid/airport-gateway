"""Refresh the signed-in catalog's bundled logos with Python 3, Pillow, curl and rsvg-convert.

Run this file when updating dist/toolkits.json. Composio's public logo service
requires no account key. Rendering SVGs here keeps remote documents and asset
requests out of the browser. No build tools are needed on the production host.
"""

import io
import json
import re
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image


DIST = Path(__file__).resolve().parent.parent / "dist"
ICON_DIR = DIST / "integrations"
SIZE = 96
# These toolkit entries share Zoho's company mark. The individual product icons
# are published by Zoho at https://www.zoho.com/branding-kit.html.
ZOHO_PRODUCTS = {"zoho_books", "zoho_desk", "zoho_inventory", "zoho_invoice", "zoho_mail"}


def download_icon(slug, staging):
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,255}", slug):
        raise ValueError(f"Invalid catalog slug: {slug!r}")
    url = f"https://logos.composio.dev/api/{slug}"
    if slug in ZOHO_PRODUCTS:
        url = f"https://www.zoho.com/sites/zweb/images/producticon/{slug.removeprefix('zoho_')}.svg"
    svg = subprocess.run(
        ["curl", "--fail", "--silent", "--show-error", "--retry", "2",
         "--max-time", "20", "--max-filesize", "4194304", url],
        check=True, capture_output=True,
    ).stdout
    if b"composio-fallback-grid" in svg:
        return slug
    png = subprocess.run(
        ["rsvg-convert", "--width", str(SIZE * 3), "--height", str(SIZE * 3), "--keep-aspect-ratio"],
        input=svg, check=True, capture_output=True, timeout=12,
    ).stdout
    with Image.open(io.BytesIO(png)) as source:
        icon = source.convert("RGBA")
        bounds = icon.getchannel("A").getbbox()
        if not bounds:
            raise ValueError(f"{slug} rendered fully transparent")
        icon = icon.crop(bounds)
        if all(low == high for low, high in icon.getextrema()):
            raise ValueError(f"{slug} rendered a single solid color")
        icon.thumbnail((SIZE, SIZE), Image.Resampling.LANCZOS)
        icon.save(staging / f"{slug}.webp", lossless=True, method=6)
    return None


def main():
    slugs = [row[0] for row in json.loads((DIST / "toolkits.json").read_text())]
    if not slugs or len(slugs) != len(set(slugs)):
        raise ValueError("Expected a non-empty catalog of unique toolkit slugs")
    ICON_DIR.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(dir=ICON_DIR) as directory:
        staging = Path(directory)
        with ThreadPoolExecutor(max_workers=8) as pool:
            missing = [slug for slug in pool.map(lambda slug: download_icon(slug, staging), slugs) if slug]
        for icon in staging.glob("*.webp"):
            icon.replace(ICON_DIR / icon.name)
    if missing:
        print("No new provider artwork for " + ", ".join(missing))
    count = sum((ICON_DIR / f"{slug}.webp").is_file() for slug in slugs)
    print(f"{count}/{len(slugs)} published integrations have a bundled logo.")


if __name__ == "__main__":
    main()
