import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import xml.etree.ElementTree as ET

sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location(
    "mylio_converter", Path(__file__).resolve().parents[1] / "scripts/convert-mylio-rapidraw.py"
)
converter = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(converter)
ASSET = "11111111-1111-4111-8111-111111111111"
OTHER_ASSET = "22222222-2222-4222-8222-222222222222"
CROP = {
    "cropTop": "0.024882", "cropLeft": "0.025755", "cropHeight": "0.949052",
    "cropAspect": "1.332503", "cropAngle": "2.283991", "cropEnabled": "true",
}


def jpeg(width, height):
    return b"\xff\xd8\xff\xc0\x00\x07\x08" + struct.pack(">HH", height, width) + b"\xff\xd9"


class ConversionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="mylio conversion ")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.originals = self.root / "originals"
        self.originals.mkdir()
        self.source = self.originals / "photo with spaces.JPG"
        self.source.write_bytes(b"untouched full-resolution original")
        self.sidecar = self.originals / (self.source.name + ".rrdata")
        self.sidecar.write_text('{"existing":"RapidRAW edit"}', encoding="utf-8")
        self.xmp = self.root / "photo.xmp"
        self.manifest = self.root / "audit.json"
        self.output = self.root / "review"
        self.database = self.root / "cache.sqlite"
        self.edits = {"exposure": "0.16"}
        self.save_manifest()
        with sqlite3.connect(self.database) as db:
            db.executescript(
                "CREATE TABLE assets(id TEXT, width INTEGER, height INTEGER, exif_info_json TEXT, asset_type TEXT);"
                "CREATE TABLE local_saved_assets(asset_id TEXT, local_path TEXT, source_kind TEXT);"
                "CREATE TABLE edit_versions(asset_id TEXT, original_asset_id TEXT);"
            )
            db.execute("INSERT INTO assets VALUES(?,4000,3000,?, 'IMAGE')",
                       (ASSET, '{"orientation":"1"}'))
            db.execute("INSERT INTO local_saved_assets VALUES(?,?,?)",
                       (ASSET, str(self.source), "explorer_copy"))

    def save_manifest(self, adobe=False):
        root = ET.Element("root")
        ET.SubElement(root, "description", {converter.MYLO + k: v for k, v in self.edits.items()})
        if adobe:
            ET.SubElement(root, converter.CRS + "ToneCurvePV2012")
        ET.ElementTree(root).write(self.xmp)
        self.records = [{
            "xmp": str(self.xmp), "edits": self.edits, "candidate_ids": [ASSET],
            "lightroom_fields_present": False,
        }]
        self.manifest.write_text(json.dumps({"records": self.records}), encoding="utf-8")

    def run_cli(self, *args, platform=None):
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            with mock.patch.object(converter.sys, "platform", platform or (
                "win32" if sys.platform == "win32" else "darwin"
            )):
                status = converter.main([
                    "--manifest", str(self.manifest), "--db", str(self.database),
                    "--output", str(self.output), *args,
                ])
        return status, json.loads(stdout.getvalue()) if stdout.getvalue() else None, stderr.getvalue()

    def fake_export(self, command, **kwargs):
        self.assertIsInstance(command, list)
        self.assertEqual(command[2], str(self.source.resolve()))
        self.assertTrue(kwargs["check"])
        self.assertNotIn("shell", kwargs)
        destination = Path(command[command.index("--output") + 1])
        adjustments = json.loads(Path(command[command.index("--adjustments") + 1]).read_text())
        self.assertNotIn("adjustments", adjustments)
        crop = adjustments.get("crop", {"width": 4000, "height": 3000})
        destination.write_bytes(jpeg(round(crop["width"]), round(crop["height"])))
        return subprocess.CompletedProcess(command, 0)

    def test_crop_and_ev_mapping_and_orientation(self):
        result, _ = converter.convert({**CROP, "exposure": "0.16"}, 4000, 3000)
        self.assertAlmostEqual(result["crop"]["width"], 3793.843911468)
        self.assertAlmostEqual(result["crop"]["height"], 2847.156)
        self.assertEqual(result["rotation"], -2.283991)
        self.assertAlmostEqual(result["exposure"], 0.128)
        portrait = {**CROP, "cropLeft": "0", "cropTop": "0", "cropHeight": "0.5", "cropAspect": "1"}
        result, _ = converter.convert(portrait, 4000, 3000, 1, 6)
        self.assertEqual(result["orientationSteps"], 1)
        self.assertEqual(result["crop"]["height"], 2000)
        with self.assertRaisesRegex(ValueError, "mirrored"):
            converter.convert({}, 4000, 3000, 1, 2)

    def test_experimental_curves_and_tone_are_explicit_and_bounded(self):
        edits = {
            "contrast": "1.0279", "whites": "0.65", "saturation": "0.07",
            "sharpening": "6", "lvlEnabled": "true",
            "lvlRLo": "0.25", "lvlRHi": "0.75", "lvlLMid": "0.4",
        }
        with self.assertRaisesRegex(ValueError, "--experimental"):
            converter.convert(edits, 4000, 3000)
        result, warnings = converter.convert(edits, 4000, 3000, experimental=True)
        self.assertAlmostEqual(result["contrast"], 2.79)
        self.assertAlmostEqual(result["whites"], 30)
        self.assertAlmostEqual(result["saturation"], 7)
        self.assertEqual(result["sharpness"], 100)
        self.assertIn({"x": 63.75, "y": 0.0}, result["curves"]["red"])
        self.assertIn({"x": 191.25, "y": 255.0}, result["curves"]["red"])
        self.assertTrue(any("uncalibrated" in warning for warning in warnings))
        json.dumps(result, allow_nan=False)

    def test_invalid_or_unsupported_edits_are_not_silently_omitted(self):
        for edits in [
            {"brushPass_0": "opaque brush data"}, {"grainFilter": "2"},
            {"exposure": "nan"}, {"exposure": "inf"},
            {"sharpening": "-1"},
            {**CROP, "cropLeft": "0.9"},
            {"lvlEnabled": "true", "lvlRLo": "0.9", "lvlRHi": "0.1"},
            {"lvlEnabled": "true", "lvlRLo": "0.1"},
            {"cropAngle": "2"}, {"lvlRLo": "0.1", "lvlRHi": "0.9"},
        ]:
            with self.subTest(edits=edits), self.assertRaises(ValueError):
                converter.convert(edits, 4000, 3000, experimental=True)
        result, _ = converter.convert(
            {**CROP, "cropTop": "-0.000002", "cropHeight": "1.000004",
             "cropLeft": "0", "cropAspect": "1"}, 4000, 3000,
        )
        self.assertEqual(result["crop"]["y"], 0)
        self.assertEqual(result["crop"]["height"], 3000)
        with self.assertRaisesRegex(ValueError, "width.*cached image metadata"):
            converter.convert(CROP, None, None)

    def test_dry_run_never_executes_or_writes(self):
        before = self.database.read_bytes()
        with mock.patch.object(converter.subprocess, "run") as process:
            status, report, _ = self.run_cli()
        self.assertEqual(status, 0)
        self.assertEqual(report["counts"], {"planned": 1})
        process.assert_not_called()
        self.assertFalse(self.output.exists())
        self.assertEqual(self.database.read_bytes(), before)
        self.assertEqual(self.source.read_bytes(), b"untouched full-resolution original")
        self.assertEqual(self.sidecar.read_text(), '{"existing":"RapidRAW edit"}')

    def test_missing_and_cached_sources_are_blocked_without_side_effects(self):
        for kind in ("explorer_copy:cached", "explorer_copy:transcoded"):
            with sqlite3.connect(self.database) as db:
                db.execute("UPDATE local_saved_assets SET source_kind = ?", (kind,))
            status, report, _ = self.run_cli()
            self.assertEqual(status, 2)
            self.assertIn("cached previews", report["records"][0]["reason"])
        with sqlite3.connect(self.database) as db:
            db.execute("UPDATE local_saved_assets SET source_kind = 'explorer_copy'")
        self.source.unlink()
        status, _, _ = self.run_cli()
        self.assertEqual(status, 2)
        self.assertTrue(self.sidecar.is_file())
        self.assertFalse(self.output.exists())

    def test_export_is_review_only_and_resume_verifies_fingerprints(self):
        with mock.patch.object(converter.subprocess, "run", side_effect=self.fake_export) as process:
            status, report, _ = self.run_cli("--apply", "--rapidraw", sys.executable)
            self.assertEqual(status, 0)
            self.assertEqual(report["counts"], {"exported": 1})
            folder = self.output / ASSET
            project = json.loads((folder / (self.source.name + ".rrdata")).read_text())
            self.assertAlmostEqual(project["adjustments"]["exposure"], 0.128)
            status, report, _ = self.run_cli("--apply", "--rapidraw", sys.executable)
            self.assertEqual(report["counts"], {"already_exported": 1})
            self.assertEqual(process.call_count, 1)
            self.source.write_bytes(b"changed original")
            status, report, _ = self.run_cli("--apply", "--rapidraw", sys.executable)
            self.assertEqual(status, 2)
            self.assertIn("incomplete or differs", report["records"][0]["reason"])
        self.assertEqual(self.sidecar.read_text(), '{"existing":"RapidRAW edit"}')

    def test_renderer_failures_and_zero_exit_panics_cannot_be_success(self):
        for failure in ("nonzero", "panic", "invalid_jpeg", "wrong_crop", "source_changed"):
            with self.subTest(failure=failure):
                self.output = self.root / failure
                self.edits = dict(CROP)
                self.save_manifest()

                def process(command, **kwargs):
                    if failure == "nonzero":
                        raise subprocess.CalledProcessError(1, command)
                    result = self.fake_export(command, **kwargs)
                    destination = Path(command[command.index("--output") + 1])
                    if failure == "panic":
                        kwargs["stdout"].write("[ERROR] PANIC! metadata failed")
                    elif failure == "invalid_jpeg":
                        destination.write_bytes(b"not an image")
                    elif failure == "wrong_crop":
                        destination.write_bytes(jpeg(10, 10))
                    elif failure == "source_changed":
                        self.source.write_bytes(b"changed while rendering")
                    return result

                with mock.patch.object(converter.subprocess, "run", side_effect=process):
                    status, report, _ = self.run_cli("--apply", "--rapidraw", sys.executable)
                self.assertEqual(status, 2)
                self.assertIn("failed", report["records"][0]["reason"].lower())
                self.assertFalse((self.output / ASSET / "result.json").exists())

    def test_mixed_lightroom_stale_audits_and_edited_versions_are_blocked(self):
        self.save_manifest(adobe=True)
        status, report, _ = self.run_cli()
        self.assertEqual(status, 2)
        self.assertIn("Lightroom", report["records"][0]["reason"])
        self.save_manifest()
        self.xmp.write_text(self.xmp.read_text().replace("0.16", "1.2"))
        status, report, _ = self.run_cli()
        self.assertIn("changed since", report["records"][0]["reason"])
        self.save_manifest()
        with sqlite3.connect(self.database) as db:
            db.execute("INSERT INTO edit_versions VALUES(?,?)",
                       (ASSET, OTHER_ASSET))
        status, report, _ = self.run_cli()
        self.assertIn("not an original", report["records"][0]["reason"])

    def test_ambiguous_duplicate_and_unknown_asset_ids_do_not_run(self):
        self.records[0]["candidate_ids"].append(OTHER_ASSET)
        self.manifest.write_text(json.dumps({"records": self.records}))
        status, report, _ = self.run_cli()
        self.assertEqual(status, 2)
        self.assertIn("unambiguous", report["records"][0]["reason"])
        self.save_manifest()
        self.manifest.write_text(json.dumps({"records": self.records * 2}))
        status, report, _ = self.run_cli()
        self.assertTrue(all("Multiple XMP" in r["reason"] for r in report["records"]))
        status, _, _ = self.run_cli("--asset-id", OTHER_ASSET)
        self.assertEqual(status, 1)
        self.assertFalse(self.output.exists())

    def test_windows_uses_argument_array_and_no_console(self):
        with mock.patch.object(converter.shutil, "which", return_value="C:\\Program Files\\RapidRAW.exe"):
            with mock.patch.object(converter.subprocess, "CREATE_NO_WINDOW", 0x08000000, create=True):
                with mock.patch.object(converter.subprocess, "run", side_effect=self.fake_export) as process:
                    status, _, _ = self.run_cli("--apply", platform="win32")
        self.assertEqual(status, 0)
        self.assertEqual(process.call_args.args[0][0], "C:\\Program Files\\RapidRAW.exe")
        self.assertEqual(process.call_args.kwargs["creationflags"], 0x08000000)

    def test_output_cannot_be_in_the_original_tree(self):
        for path in (self.originals, self.originals / "nested", self.root):
            self.output = path
            for args in ((), ("--apply", "--rapidraw", sys.executable)):
                with mock.patch.object(converter.subprocess, "run") as process:
                    status, _, error = self.run_cli(*args)
                self.assertEqual(status, 1)
                self.assertIn("separate", error)
                process.assert_not_called()
        self.assertFalse(list(self.originals.rglob("report-*.json")))

    def test_malformed_manifest_and_unsupported_platform_fail_explicitly(self):
        for value in ([], {"records": {}}, {"records": [{}]}):
            self.manifest.write_text(json.dumps(value))
            status, _, error = self.run_cli()
            self.assertEqual(status, 1)
            self.assertIn("[mylio:convert] error:", error)
        with self.assertRaises(SystemExit) as result:
            self.run_cli(platform="linux")
        self.assertEqual(result.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
