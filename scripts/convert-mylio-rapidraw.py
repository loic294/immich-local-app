#!/usr/bin/env python3
"""Export Mylio audit candidates through RapidRAW without activating app watchers."""

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import sqlite3
import struct
import subprocess
import sys
import uuid
import xml.etree.ElementTree as ET

MAPPING_VERSION = "rapidraw-1.6.7-review-v1"
MYLO = "{http://ns.mylollc.com/MyloEdit/}"
CRS = "{http://ns.adobe.com/camera-raw-settings/1.0/}"
TIFF = "{http://ns.adobe.com/tiff/1.0/}"
METADATA = {
    "Undated", "flag", "processVersion", "MetadataDate", "DateRangeStart",
    "DateRangeEnd", "DateRangeScope", "Season", "Year",
}
CROP_FIELDS = {
    "cropTop", "cropLeft", "cropHeight", "cropAspect", "cropAngle",
    "cropEnabled", "cropConstraint", "cropConstraintWidth", "cropConstraintHeight",
}
LEVELS = {
    "red": ("lvlRLo", "lvlRHi", None),
    "green": ("lvlGLow", "lvlGHi", None),
    "blue": ("lvlBLow", "lvlBHi", None),
    "luma": ("lvlLLow", "lvlLHi", "lvlLMid"),
}
EXPERIMENTAL = {
    "contrast", "highlights", "shadows", "whites", "blacks", "saturation",
    "vibrance", "localContrast", "sharpening", "wbTemp", "wbTint", "lvlEnabled",
    *(key for channel in LEVELS.values() for key in channel if key),
}


def number(value, name):
    try:
        result = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"Missing or nonnumeric {name}; check XMP and cached image metadata") from error
    if not math.isfinite(result):
        raise ValueError(f"{name} must be finite")
    return result


def boolean(value, name):
    if str(value).lower() not in ("true", "false"):
        raise ValueError(f"{name} must be true or false")
    return str(value).lower() == "true"


def bounded(value, low, high, name):
    result = number(value, name)
    if not low <= result <= high:
        raise ValueError(f"{name} must be between {low} and {high}, got {result}")
    return result


def read_xmp(path):
    fields = {}
    adobe = False
    for element in ET.parse(path).iter():
        adobe = adobe or element.tag.startswith(CRS) or any(key.startswith(CRS) for key in element.attrib)
        fields.update(element.attrib)
        if not len(element) and element.text and element.text.strip():
            fields[element.tag] = element.text.strip()
    edits = {key[len(MYLO):]: value for key, value in fields.items()
             if key.startswith(MYLO) and key[len(MYLO):] not in METADATA}
    return edits, fields.get(TIFF + "Orientation"), adobe


def level_curve(black, white, midpoint=0.5):
    if not 0 <= black < white <= 1 or not 0 < midpoint < 1:
        raise ValueError("Invalid levels: require 0 <= black < white <= 1 and 0 < midpoint < 1")
    gamma = math.log(0.5) / math.log(midpoint)
    points = {0.0: 0.0, 255.0: 255.0}
    for step in range(17):
        position = step / 16
        points[(black + (white - black) * position) * 255] = position ** gamma * 255
    return [{"x": x, "y": y} for x, y in sorted(points.items())]


def convert(edits, width, height, source_orientation=1, target_orientation=None,
            experimental=False):
    unknown = set(edits) - CROP_FIELDS - EXPERIMENTAL - {"exposure"}
    if unknown:
        raise ValueError("Unsupported Mylio adjustments (not omitted): " + ", ".join(sorted(unknown)))
    experimental_fields = set(edits) & EXPERIMENTAL
    if experimental_fields and not experimental:
        raise ValueError("Requires --experimental: " + ", ".join(sorted(experimental_fields)))
    source_orientation = int(source_orientation)
    target_orientation = int(target_orientation or source_orientation)
    rotations = {1: 0, 6: 1, 3: 2, 8: 3}
    if source_orientation not in range(1, 9) or target_orientation not in range(1, 9):
        raise ValueError("EXIF orientations must be integers from 1 through 8")
    if source_orientation != target_orientation and (
        source_orientation not in rotations or target_orientation not in rotations
    ):
        raise ValueError("Changed mirrored EXIF orientation requires manual review")
    steps = (rotations.get(target_orientation, 0) - rotations.get(source_orientation, 0)) % 4
    result = {
        "baselineExposure": False, "orientationSteps": steps,
        "flipHorizontal": False, "flipVertical": False,
    }
    warnings = ["Approximate conversion for review; Mylio and RapidRAW render differently."]
    if "exposure" in edits:
        # RapidRAW 1.6.7 divides the JSON slider by 0.8 to obtain renderer EV.
        result["exposure"] = bounded(edits["exposure"], -6.25, 6.25, "exposure") * 0.8
    enabled = boolean(edits.get("cropEnabled", "false"), "cropEnabled")
    if enabled:
        width = bounded(width, 1, 100000, "width")
        height = bounded(height, 1, 100000, "height")
        if target_orientation in (5, 6, 7, 8):
            width, height = height, width
        top = bounded(edits["cropTop"], -0.00001, 1, "cropTop")
        left = bounded(edits["cropLeft"], -0.00001, 1, "cropLeft")
        fraction = bounded(edits["cropHeight"], 0.00001, 1.00001, "cropHeight")
        aspect = bounded(edits["cropAspect"], 0.00001, 100, "cropAspect")
        x, y = max(0, left) * width, max(0, top) * height
        crop_height = min(1, fraction) * height
        crop_width = crop_height * aspect
        if x + crop_width > width + 1 or y + crop_height > height + 1:
            raise ValueError("Mylio crop exceeds the oriented image bounds")
        result["crop"] = {
            "x": x, "y": y, "width": min(crop_width, width - x),
            "height": min(crop_height, height - y),
        }
        result["aspectRatio"] = aspect
        result["rotation"] = -bounded(edits.get("cropAngle", 0), -45, 45, "cropAngle")
    elif any(key in edits for key in CROP_FIELDS - {"cropEnabled"}):
        raise ValueError("Crop fields are present but cropEnabled is false or missing; review manually")
    if experimental_fields:
        warnings.append("Experimental tone/color assumptions are uncalibrated; inspect every export.")
    for source, target, factor in [
        ("highlights", "highlights", 100), ("shadows", "shadows", 100),
        ("saturation", "saturation", 100), ("vibrance", "vibrance", 100),
        ("localContrast", "clarity", 100), ("blacks", "blacks", 1),
        ("wbTemp", "temperature", 1), ("wbTint", "tint", 1),
        ("sharpening", "sharpness", 100 / 6),
    ]:
        if source in edits:
            result[target] = bounded(number(edits[source], source) * factor,
                                     0 if source == "sharpening" else -100, 100, source)
    if "contrast" in edits:
        result["contrast"] = bounded((number(edits["contrast"], "contrast") - 1) * 100,
                                      -100, 100, "contrast")
    if "whites" in edits:
        result["whites"] = (bounded(edits["whites"], 0, 1, "whites") - 0.5) * 200
    level_fields = {key for channel in LEVELS.values() for key in channel if key}
    if boolean(edits.get("lvlEnabled", "false"), "lvlEnabled"):
        curves = {}
        for channel, (black, white, midpoint) in LEVELS.items():
            if (black in edits) != (white in edits):
                raise ValueError(f"Incomplete {channel} levels endpoints")
            curves[channel] = level_curve(
                number(edits.get(black, 0), black), number(edits.get(white, 1), white),
                number(edits.get(midpoint, 0.5), midpoint) if midpoint else 0.5,
            )
        result.update(curves=curves, pointCurves=curves, curveMode="point")
    elif set(edits) & level_fields:
        raise ValueError("Levels endpoints are present but levels are disabled; review manually")
    return result, warnings


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def write_json(path, value):
    with path.open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2, ensure_ascii=False, allow_nan=False)
        stream.write("\n")


def jpeg_dimensions(path):
    with path.open("rb") as stream:
        stream.seek(-2, 2)
        if stream.read(2) != b"\xff\xd9":
            raise ValueError("RapidRAW output is an incomplete JPEG")
        stream.seek(0)
        if stream.read(2) != b"\xff\xd8":
            raise ValueError("RapidRAW output is not a JPEG")
        while True:
            if stream.read(1) != b"\xff":
                raise ValueError("Invalid JPEG marker")
            marker = stream.read(1)
            while marker == b"\xff":
                marker = stream.read(1)
            if not marker or marker in (b"\xda", b"\xd9"):
                raise ValueError("JPEG has no image dimensions")
            raw_length = stream.read(2)
            if len(raw_length) != 2:
                raise ValueError("Truncated JPEG segment")
            length = struct.unpack(">H", raw_length)[0]
            if length < 2:
                raise ValueError("Invalid JPEG segment length")
            if marker in (b"\xc0", b"\xc1", b"\xc2"):
                segment = stream.read(5)
                if len(segment) != 5:
                    raise ValueError("Truncated JPEG dimensions")
                height, width = struct.unpack(">HH", segment[1:])
                if not width or not height:
                    raise ValueError("JPEG dimensions must be positive")
                return width, height
            stream.seek(length - 2, 1)


def local_original(db, asset_id):
    rows = db.execute(
        "SELECT local_path, source_kind FROM local_saved_assets WHERE asset_id = ? ORDER BY local_path",
        (asset_id,),
    )
    for path, kind in rows:
        if kind.endswith((":cached", ":transcoded")):
            continue
        candidate = Path(path).expanduser().resolve()
        if candidate.is_file():
            return candidate
    raise ValueError("Original missing: download through Immich Local Edit; cached previews are not allowed")


def plan(record, db, experimental):
    ids = record.get("candidate_ids", [])
    if len(ids) != 1:
        raise ValueError("Requires one unambiguous audited asset ID; image matching must be reviewed first")
    asset_id = str(uuid.UUID(ids[0]))
    xmp = Path(record["xmp"]).expanduser().resolve()
    edits, orientation, adobe = read_xmp(xmp)
    if adobe or record.get("lightroom_fields_present"):
        raise ValueError("Mixed Lightroom/Adobe Camera Raw sidecar; manual review required")
    if edits != record["edits"]:
        raise ValueError("Mylio edits changed since the audit; regenerate/review the manifest")
    asset = db.execute(
        "SELECT width,height,exif_info_json,asset_type FROM assets WHERE id = ?", (asset_id,)
    ).fetchone()
    if asset is None or asset[3] != "IMAGE":
        raise ValueError("Audited image is missing from the local cache")
    version = db.execute(
        "SELECT original_asset_id FROM edit_versions WHERE asset_id = ?", (asset_id,)
    ).fetchone()
    if version and version[0] != asset_id:
        raise ValueError("Candidate is an edited version, not an original")
    exif = json.loads(asset[2] or "{}")
    adjustments, warnings = convert(
        edits, asset[0], asset[1], exif.get("orientation") or 1,
        orientation, experimental,
    )
    source = local_original(db, asset_id)
    return {
        "asset_id": asset_id, "source": str(source), "xmp": str(xmp),
        "mapping_version": MAPPING_VERSION, "adjustments": adjustments,
        "source_sha256": digest(source), "xmp_sha256": digest(xmp),
        "warnings": warnings,
    }


def export(job, output, executable):
    folder = output / job["asset_id"]
    source = Path(job["source"])
    destination = folder / (source.stem + "-mylio-review.jpg")
    result_path = folder / "result.json"
    if folder.exists():
        if result_path.is_file():
            previous = json.loads(result_path.read_text(encoding="utf-8"))
            if (previous.get("job") == job and previous.get("status") == "exported"
                    and destination.is_file()
                    and digest(destination) == previous.get("output_sha256")):
                jpeg_dimensions(destination)
                return "already_exported"
        raise ValueError(f"Existing output is incomplete or differs; use a new output directory: {folder}")
    folder.mkdir(parents=True)
    adjustments_path = folder / "adjustments.json"
    write_json(adjustments_path, job["adjustments"])
    write_json(folder / (source.name + ".rrdata"), {"version": 1, "adjustments": job["adjustments"]})
    command = [
        executable, "export", str(source), "--output", str(destination),
        "--format", "jpeg", "--quality", "100", "--keep-metadata",
        "--adjustments", str(adjustments_path),
    ]
    try:
        with (folder / "export.log").open("x", encoding="utf-8") as log:
            subprocess.run(
                command, stdout=log, stderr=subprocess.STDOUT, check=True, timeout=300,
                creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
            )
        log_text = (folder / "export.log").read_text(encoding="utf-8", errors="replace")
        if "PANIC" in log_text or "[ERROR]" in log_text:
            raise ValueError("RapidRAW logged an error despite a zero exit status")
        dimensions = jpeg_dimensions(destination)
        crop = job["adjustments"].get("crop")
        if crop and any(abs(actual - crop[key]) > 1 for actual, key in zip(dimensions, ("width", "height"))):
            raise ValueError("Export dimensions do not match the requested crop")
        if digest(source) != job["source_sha256"] or digest(Path(job["xmp"])) != job["xmp_sha256"]:
            raise ValueError("Source or XMP changed during export; result must not be used")
        write_json(result_path, {
            "status": "exported", "job": job, "output": str(destination),
            "output_sha256": digest(destination), "dimensions": dimensions,
        })
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        raise RuntimeError(f"Export failed; inspect {folder / 'export.log'}: {error}") from error
    return "exported"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True, help="Reviewed mylio-audit.json")
    parser.add_argument("--db", type=Path, default=Path.home() / ".config/immich-local-app/db.sqlite")
    parser.add_argument("--output", type=Path, required=True, help="Separate review export directory")
    parser.add_argument("--rapidraw", default=None, help="RapidRAW executable path (not the .app directory)")
    parser.add_argument("--experimental", action="store_true", help="Enable uncalibrated tone/color mappings")
    parser.add_argument("--asset-id", action="append", default=[], help="Limit to an audited UUID; repeatable")
    parser.add_argument("--apply", action="store_true", help="Run exports; otherwise only print a dry-run report")
    args = parser.parse_args(argv)
    if sys.platform not in ("darwin", "win32"):
        parser.error("Supported platforms are macOS and Windows")
    report = {"dry_run": not args.apply, "mapping_version": MAPPING_VERSION, "records": []}
    try:
        selected = {str(uuid.UUID(value)) for value in args.asset_id}
        manifest = json.loads(args.manifest.expanduser().read_text(encoding="utf-8"))
        if not isinstance(manifest, dict) or not isinstance(manifest.get("records"), list):
            raise ValueError("Manifest must contain a records array")
        for record in manifest["records"]:
            if (not isinstance(record, dict) or not isinstance(record.get("edits"), dict)
                    or not isinstance(record.get("candidate_ids"), list)
                    or any(not isinstance(value, str) for value in record["candidate_ids"])
                    or not isinstance(record.get("xmp"), str)):
                raise ValueError("Each record requires xmp, edits, and candidate_ids fields")
        records = [r for r in manifest["records"] if r.get("edits")
                   and (not selected or selected.intersection(r.get("candidate_ids", [])))]
        found = {value for r in records for value in r.get("candidate_ids", [])}
        if selected - found:
            raise ValueError("Requested asset IDs are not edit candidates in this audit")
        if not records:
            raise ValueError("Manifest contains no selected Mylio edit candidates")
        duplicates = Counter(r["candidate_ids"][0] for r in records if len(r.get("candidate_ids", [])) == 1)
        output = args.output.expanduser().resolve()
        database = args.db.expanduser().resolve()
        executable = args.rapidraw or (
            "/Applications/RapidRAW.app/Contents/MacOS/RapidRAW" if sys.platform == "darwin" else "RapidRAW.exe"
        )
        if args.apply:
            executable = shutil.which(executable)
            if not executable:
                raise ValueError("RapidRAW executable not found; supply --rapidraw")
        with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as db:
            for record in records:
                entry = {"xmp": record.get("xmp"), "candidate_ids": record.get("candidate_ids", [])}
                try:
                    ids = record.get("candidate_ids", [])
                    if len(ids) == 1 and duplicates[ids[0]] > 1:
                        raise ValueError("Multiple XMP records target this asset; reconcile them first")
                    job = plan(record, db, args.experimental)
                    entry.update(job=job, status="planned")
                except (KeyError, TypeError, OSError, ValueError, ET.ParseError, RuntimeError) as error:
                    entry.update(status="blocked", reason=str(error))
                    print(f"[mylio:convert] blocked xmp={entry['xmp']}: {error}", file=sys.stderr)
                report["records"].append(entry)
        # Check the whole batch before creating exports or a report directory.
        for entry in report["records"]:
            if entry["status"] != "planned":
                continue
            parent = Path(entry["job"]["source"]).parent
            if output == parent or output in parent.parents or parent in output.parents:
                raise ValueError("Review output must be separate from the original's directory tree")
        for entry in report["records"]:
            if entry["status"] != "planned":
                continue
            job = entry["job"]
            if args.apply:
                print(f"[mylio:convert] exporting asset={job['asset_id']}", file=sys.stderr)
                try:
                    entry["status"] = export(job, output, executable)
                except (OSError, ValueError, RuntimeError) as error:
                    entry.update(status="blocked", reason=str(error))
                    print(f"[mylio:convert] blocked asset={job['asset_id']}: {error}", file=sys.stderr)
                    continue
            print(f"[mylio:convert] {entry['status']} asset={job['asset_id']}", file=sys.stderr)
        report["counts"] = dict(Counter(r["status"] for r in report["records"]))
        if args.apply:
            output.mkdir(parents=True, exist_ok=True)
            write_json(output / ("report-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + ".json"),
                       report)
        print(json.dumps(report, indent=2, ensure_ascii=False, allow_nan=False))
        return 2 if report["counts"].get("blocked") else 0
    except (KeyError, TypeError, OSError, ValueError, sqlite3.Error) as error:
        print(f"[mylio:convert] error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
