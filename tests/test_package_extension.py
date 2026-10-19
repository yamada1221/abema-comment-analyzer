"""Regression tests for the unpublished, allowlisted review ZIP builder."""
from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from zipfile import ZipFile


REPO = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location(
    "abema_extension_packager", REPO / "scripts" / "package_extension.py"
)
packager = importlib.util.module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(packager)


class ReviewZipTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "project"
        self.root.mkdir()
        for filename in packager.PACKAGE_FILES:
            (self.root / filename).write_bytes((REPO / filename).read_bytes())
        self.patch_root = patch.object(packager, "ROOT", self.root)
        self.patch_root.start()
        self.addCleanup(self.patch_root.stop)

    def test_validates_current_extension(self) -> None:
        actual = json.loads((self.root / "manifest.json").read_text("utf-8"))["version"]
        self.assertEqual(packager.validate(), actual)
        self.assertEqual(len(packager.PACKAGE_FILES), 25)

    def test_archive_contains_only_allowlisted_files_and_is_reproducible(self) -> None:
        packager.validate()
        one = self.root / "dist" / "review-one.zip"
        two = self.root / "dist" / "review-two.zip"
        packager.build(one)
        packager.build(two)
        self.assertEqual(one.read_bytes(), two.read_bytes())
        with ZipFile(one) as archive:
            self.assertEqual(set(archive.namelist()), packager.PACKAGE_FILES)
            self.assertIsNone(archive.testzip())
            self.assertEqual(archive.read("manifest.json"), (self.root / "manifest.json").read_bytes())
            for info in archive.infolist():
                self.assertEqual(info.date_time, (2020, 1, 1, 0, 0, 0))
                self.assertFalse(info.filename.startswith(("/", "../")))
            for excluded in ("package.json", ".github/workflows/test.yml", "tests/test_package_extension.py",
                             "docs/distribution-readiness.md", "node_modules/module.js"):
                self.assertNotIn(excluded, archive.namelist())

    def test_icon_pngs_have_exact_dimensions_and_no_bogus_bytes(self) -> None:
        for size in (16, 32, 48, 128):
            icon = self.root / f"icons/icon-{size}.png"
            with self.subTest(size=size):
                self.assertEqual(icon.read_bytes()[:8], bytes.fromhex("89504e470d0a1a0a"))
                broken = icon.read_bytes()
                icon.write_bytes(b"not a PNG")
                with self.assertRaisesRegex(ValueError, "Invalid RGBA PNG icon"):
                    packager.validate()
                icon.write_bytes(broken)
        self.assertEqual(packager.validate(),
                         json.loads((self.root / "manifest.json").read_text("utf-8"))["version"])

    def test_missing_package_asset_is_rejected(self) -> None:
        (self.root / "content.js").unlink()
        with self.assertRaisesRegex(ValueError, "Missing packaged files"):
            packager.validate()

    def test_unlisted_referenced_file_is_rejected(self) -> None:
        popup = self.root / "popup.html"
        popup.write_text(popup.read_text("utf-8").replace(
            "</body>", '<script src="secret.js"></script></body>'
        ), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Referenced assets not in package"):
            packager.validate()

    def test_remote_script_or_stylesheet_is_rejected(self) -> None:
        for markup in ('<script src="https://cdn.example.org/tool.js"></script>',
                       '<link rel="stylesheet" href="//cdn.example.org/style.css">'):
            with self.subTest(markup=markup):
                page = self.root / "guide.html"
                original = (REPO / "guide.html").read_text("utf-8")
                page.write_text(original.replace("</body>", markup + "</body>"), encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "External or invalid executable reference"):
                    packager.validate()
                page.write_text(original, encoding="utf-8")

    def test_unexpected_host_permission_is_rejected(self) -> None:
        file = self.root / "manifest.json"
        manifest = json.loads(file.read_text("utf-8"))
        manifest["host_permissions"] = ["<all_urls>"]
        file.write_text(json.dumps(manifest), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Unexpected host permission"):
            packager.validate()

    def test_broader_permissions_and_content_site_are_rejected(self) -> None:
        file = self.root / "manifest.json"
        baseline = json.loads(file.read_text("utf-8"))
        for field, value, error in (
            ("permissions", baseline["permissions"] + ["history"], "Unexpected extension permission"),
            ("optional_host_permissions", ["https://example.org/*"], "Unexpected extension permission"),
            ("content_scripts", [
                {**baseline["content_scripts"][0], "matches": ["<all_urls>"]},
                *baseline["content_scripts"][1:]], "Unexpected content-script"),
        ):
            with self.subTest(field=field):
                file.write_text(json.dumps({**baseline, field: value}), encoding="utf-8")
                with self.assertRaisesRegex(ValueError, error):
                    packager.validate()
        file.write_text(json.dumps(baseline), encoding="utf-8")

    def test_new_manifest_icon_must_be_explicitly_packaged(self) -> None:
        file = self.root / "manifest.json"
        manifest = json.loads(file.read_text("utf-8"))
        manifest["icons"] = {"128": "brand-icon.png"}
        file.write_text(json.dumps(manifest), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Referenced assets not in package"):
            packager.validate()

    def test_symlinked_package_asset_is_rejected(self) -> None:
        asset = self.root / "popup.js"
        target = self.root / "other.js"
        target.write_text("malicious", encoding="utf-8")
        asset.unlink()
        asset.symlink_to(target)
        with self.assertRaisesRegex(ValueError, "Unsafe packaged path"):
            packager.validate()

    def test_cannot_write_outside_dist_or_over_source_files(self) -> None:
        manifest = self.root / "manifest.json"
        untouched = manifest.read_bytes()
        with self.assertRaisesRegex(ValueError, "Review ZIP"):
            packager.build(manifest)
        self.assertEqual(manifest.read_bytes(), untouched)
        for path in (self.root / "not-dist.zip",
                     self.root / "dist" / ".." / "escape.zip",
                     self.root / "dist" / "nested" / "review.zip",
                     self.root / "dist" / "review.txt"):
            with self.subTest(path=str(path)):
                with self.assertRaises(ValueError):
                    packager.build(path)

    def test_rejects_symlinked_destination_and_dist(self) -> None:
        dist = self.root / "dist"
        dist.mkdir()
        actual = self.root / "existing.zip"
        actual.write_bytes(b"preserve")
        destination = dist / "review.zip"
        destination.symlink_to(actual)
        with self.assertRaisesRegex(ValueError, "Review ZIP"):
            packager.build(destination)
        self.assertEqual(actual.read_bytes(), b"preserve")
        destination.unlink()
        dist.rmdir()
        dist.symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "Unsafe dist directory"):
            packager.build(dist / "review.zip")


if __name__ == "__main__":
    unittest.main()
