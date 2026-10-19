#!/usr/bin/env python3
"""Prepare an *unpublished* extension review ZIP with an explicit file allowlist.

Run --check during CI. Run without --check locally to build a ZIP for manual
inspection. Neither mode uploads or publishes anything.
"""
from __future__ import annotations

import argparse
import json
import re
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


ROOT = Path(__file__).resolve().parent.parent
# All executable and UI files in the extension, never repository documentation,
# tests, CI config, dependency directories or locally generated data.
PACKAGE_FILES = frozenset({
    "manifest.json",
    "background.js",
    "background-capture.js",
    "auto-program-schedules.js",
    "auto-user-tags.js",
    "comment-tools.js",
    "content.js",
    "content.css",
    "dashboard.css",
    "dashboard.html",
    "dashboard-explorer.js",
    "dashboard.js",
    "guide.html",
    "learning-model.js",
    "moderation-store.js",
    "network-bridge.js",
    "page-bridge.js",
    "popup.html",
    "popup.js",
    "privacy.html",
    "user-tags.js",
    "icons/icon-16.png",
    "icons/icon-32.png",
    "icons/icon-48.png",
    "icons/icon-128.png",
})
HTML_FILES = frozenset({"popup.html", "dashboard.html", "guide.html", "privacy.html"})


class LocalReferences(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.references: set[str] = set()
        self.executable_references: set[str] = set()

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if tag == "script" and values.get("src"):
            self.references.add(values["src"])
            self.executable_references.add(values["src"])
        if tag == "link" and "stylesheet" in values.get("rel", "").lower().split():
            if values.get("href"):
                self.references.add(values["href"])
                self.executable_references.add(values["href"])
        if tag == "a" and values.get("href"):
            self.references.add(values["href"])


def required_files(manifest: dict) -> set[str]:
    result = {"manifest.json"}
    for item in manifest.get("content_scripts", []):
        result.update(item.get("js", []))
        result.update(item.get("css", []))
    # Store artwork is not yet provided, but future additions must never be
    # silently omitted from the review archive.
    icons = manifest.get("icons", {})
    if isinstance(icons, dict):
        result.update(icons.values())
    action_icons = manifest.get("action", {}).get("default_icon", {})
    if isinstance(action_icons, str):
        result.add(action_icons)
    elif isinstance(action_icons, dict):
        result.update(action_icons.values())
    if manifest.get("options_ui", {}).get("page"):
        result.add(manifest["options_ui"]["page"])
    if manifest.get("side_panel", {}).get("default_path"):
        result.add(manifest["side_panel"]["default_path"])
    if manifest.get("devtools_page"):
        result.add(manifest["devtools_page"])
    for data in manifest.get("web_accessible_resources", []):
        result.update(data.get("resources", []))
    background = manifest.get("background", {}).get("service_worker")
    if background:
        result.add(background)
    action = manifest.get("action", {}).get("default_popup")
    if action:
        result.add(action)
    if manifest.get("options_page"):
        result.add(manifest["options_page"])
    for page in HTML_FILES:
        parser = LocalReferences()
        parser.feed((ROOT / page).read_text(encoding="utf-8"))
        for reference in parser.executable_references:
            parsed = urlsplit(reference)
            if parsed.scheme or parsed.netloc or reference.startswith(("//", "#")) or not parsed.path:
                raise ValueError(f"External or invalid executable reference in {page}: {reference}")
        for reference in parser.references:
            parsed = urlsplit(reference)
            if parsed.scheme or parsed.netloc or reference.startswith(("#", "//")):
                continue
            if parsed.path:
                result.add(parsed.path)
    # The background worker loads helpers dynamically at runtime.
    worker_text = (ROOT / "background.js").read_text(encoding="utf-8")
    for match in re.finditer(r"importScripts\(([^)]*)\)", worker_text):
        result.update(re.findall(r"""['"]([^'"]+\.js)['"]""", match.group(1)))
    return result


def validate() -> str:
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("manifest_version") != 3:
        raise ValueError("Manifest V3 is required")
    version = manifest.get("version")
    if not isinstance(version, str) or not re.fullmatch(r"\d+(?:\.\d+){1,3}", version):
        raise ValueError("Invalid extension version")
    if manifest.get("host_permissions") != ["https://abema.tv/*"]:
        raise ValueError("Unexpected host permission scope")
    if set(manifest.get("permissions", [])) != {
        "storage", "tabs", "alarms", "unlimitedStorage"
    } or manifest.get("optional_permissions") or manifest.get("optional_host_permissions"):
        raise ValueError("Unexpected extension permission scope")
    for item in manifest.get("content_scripts", []):
        if item.get("matches") != ["https://abema.tv/*"]:
            raise ValueError("Unexpected content-script site scope")
    missing = sorted(name for name in PACKAGE_FILES if not (ROOT / name).is_file())
    if missing:
        raise ValueError(f"Missing packaged files: {', '.join(missing)}")
    for name in PACKAGE_FILES:
        path = ROOT / name
        if path.is_symlink() or not path.resolve().is_relative_to(ROOT.resolve()):
            raise ValueError(f"Unsafe packaged path: {name}")
    # Chrome accepts raster images declared in the manifest; SVG icons are not
    # supported. Validate the dimensions rather than trusting filenames.
    import struct
    for size in (16, 32, 48, 128):
        icon = ROOT / f"icons/icon-{size}.png"
        data = icon.read_bytes()
        if (len(data) < 33 or data[:8] != b"\x89PNG\r\n\x1a\n"
                or data[12:16] != b"IHDR"
                or struct.unpack(">II", data[16:24]) != (size, size)
                or data[24:26] != b"\x08\x06"):
            raise ValueError(f"Invalid RGBA PNG icon: {icon.name}")
    references = required_files(manifest)
    unexpected = sorted(references - PACKAGE_FILES)
    if unexpected:
        raise ValueError(f"Referenced assets not in package: {', '.join(unexpected)}")
    unused = sorted(PACKAGE_FILES - references - {"guide.html", "privacy.html"})
    if unused:
        raise ValueError(f"Allowlisted assets have no declared entry point: {', '.join(unused)}")
    return version


def checked_output(output: Path) -> Path:
    """Prevent --output from replacing source files or writing outside dist/."""
    dist = ROOT / "dist"
    root_resolved = ROOT.resolve()
    if dist.is_symlink() or dist.resolve() != root_resolved / "dist":
        raise ValueError("Unsafe dist directory")
    if output.suffix.lower() != ".zip" or output.name in (".", ".."):
        raise ValueError("Review ZIP output must have a .zip extension")
    # Require a direct child of dist, not just a matching prefix or traversal.
    if output.parent.resolve() != dist.resolve() or output.is_symlink():
        raise ValueError("Review ZIP must be a non-symlink file directly in dist/")
    if output.exists() and not output.is_file():
        raise ValueError("Review ZIP destination is not a regular file")
    return output


def build(output: Path) -> None:
    output = checked_output(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(output, "w", ZIP_DEFLATED, compresslevel=9) as archive:
        for name in sorted(PACKAGE_FILES):
            info = ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, (ROOT / name).read_bytes(), compress_type=ZIP_DEFLATED)
    print(f"Created local review ZIP: {output} ({len(PACKAGE_FILES)} files)")
    print("NOT published or uploaded. Review rights and policy requirements before any release.")


def main() -> None:
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--check", action="store_true", help="Validate assets only; never create an archive")
    cli.add_argument("--output", type=Path, help="Optional local review ZIP destination")
    args = cli.parse_args()
    version = validate()
    print(f"Package validation OK: v{version}, {len(PACKAGE_FILES)} files")
    if not args.check:
        build(args.output or ROOT / "dist" / f"abema-comment-analyzer-v{version}-review.zip")


if __name__ == "__main__":
    main()
