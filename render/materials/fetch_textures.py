#!/usr/bin/env python3
"""Fetch the pinned CC0 texture sets listed in textures.lock.json.

Stdlib only (Python 3.10+) — this also has to run inside Blender's bundled
interpreter for the worker, so no third-party dependencies.

Usage:
    python3 fetch_textures.py                  # fetch everything not already present
    python3 fetch_textures.py --force           # re-fetch even if files exist
    python3 fetch_textures.py --only ambientcg:Wood051 --only ambientcg:Marble012

Downloads each set's zip to a temp file, verifies its sha256 against the lock
file when one is pinned (a mismatch is a hard error — the download is
discarded, nothing is written), extracts only the three files named in the
set's "files" block into materials/textures/<assetId>/, then deletes the zip.
Idempotent: a set whose three target files already exist is skipped unless
--force is given. When a set's sha256 is still null (first fetch), the
computed hash is printed as a block to paste into textures.lock.json so the
next run — and CI — can verify it.

All network access goes through urllib.request, which honours the standard
HTTPS_PROXY/HTTP_PROXY environment variables (and NO_PROXY) automatically —
nothing proxy-specific is hardcoded here. TLS verification is never disabled;
if the environment provides an extra CA bundle via SSL_CERT_FILE (or the
sandboxed dev environment's /root/.ccr/ca-bundle.crt), it is trusted in
addition to the interpreter's own default trust store.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import ssl
import sys
import tempfile
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
DEFAULT_LOCK = HERE / "textures.lock.json"
DEFAULT_OUT_DIR = HERE / "textures"

CHUNK_SIZE = 1024 * 1024  # 1 MiB


def _ssl_context() -> ssl.SSLContext:
    """Default trust store, plus any extra CA bundle the environment names —
    verification is always on; this only ever ADDS trusted issuers."""
    ctx = ssl.create_default_context()
    extra_candidates = [
        os.environ.get("SSL_CERT_FILE"),
        os.environ.get("REQUESTS_CA_BUNDLE"),
        "/root/.ccr/ca-bundle.crt",  # sandboxed dev environment's proxy CA
    ]
    for candidate in extra_candidates:
        if candidate and Path(candidate).is_file():
            try:
                ctx.load_verify_locations(cafile=candidate)
            except ssl.SSLError:
                pass
    return ctx


def load_lock(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def select_sets(lock: dict[str, Any], only: list[str] | None) -> list[dict[str, Any]]:
    sets = lock["sets"]
    if not only:
        return sets
    wanted = set(only)
    selected = [s for s in sets if s["ref"] in wanted or s["assetId"] in wanted]
    missing = wanted - {s["ref"] for s in selected} - {s["assetId"] for s in selected}
    if missing:
        raise SystemExit(f"--only: no such set in the lock file: {', '.join(sorted(missing))}")
    return selected


def files_present(target_dir: Path, files: dict[str, str]) -> bool:
    return all((target_dir / name).is_file() and (target_dir / name).stat().st_size > 0 for name in files.values())


def download(url: str, dest: Path) -> str:
    """Stream `url` to `dest`, returning its sha256 hex digest."""
    req = urllib.request.Request(url, headers={"User-Agent": "kitchen-planner-fetch-textures/1"})
    digest = hashlib.sha256()
    ctx = _ssl_context()
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=120) as resp, dest.open("wb") as out:
            while True:
                chunk = resp.read(CHUNK_SIZE)
                if not chunk:
                    break
                digest.update(chunk)
                out.write(chunk)
    except urllib.error.URLError as exc:
        raise SystemExit(f"fetch_textures: failed to download {url}: {exc}") from exc
    return digest.hexdigest()


def extract_files(zip_path: Path, files: dict[str, str], target_dir: Path) -> None:
    wanted = set(files.values())
    target_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as zf:
        by_basename = {Path(name).name: name for name in zf.namelist()}
        missing = [w for w in wanted if w not in by_basename]
        if missing:
            raise SystemExit(
                f"fetch_textures: {zip_path.name} is missing expected file(s): {', '.join(missing)}"
            )
        for wanted_name in wanted:
            member = by_basename[wanted_name]
            data = zf.read(member)
            (target_dir / wanted_name).write_bytes(data)


def fetch_one(entry: dict[str, Any], out_dir: Path, force: bool) -> tuple[str, str | None]:
    """Returns (status, computed_sha256_or_None). status is one of
    'skipped' | 'fetched' | 'unpinned'."""
    ref = entry["ref"]
    asset_id = entry["assetId"]
    files = entry["files"]
    target_dir = out_dir / asset_id

    if not force and files_present(target_dir, files):
        print(f"skip   {ref} (already fetched: {target_dir})")
        return "skipped", None

    print(f"fetch  {ref} <- {entry['url']}")
    tmp_fd, tmp_name = tempfile.mkstemp(suffix=".zip", prefix=f"{asset_id}-")
    os.close(tmp_fd)
    tmp_path = Path(tmp_name)
    try:
        sha256 = download(entry["url"], tmp_path)
        pinned = entry.get("sha256")
        if pinned is not None and pinned != sha256:
            raise SystemExit(
                f"fetch_textures: sha256 mismatch for {ref}\n"
                f"  expected: {pinned}\n"
                f"  got:      {sha256}\n"
                "  Refusing to extract — the pinned texture zip changed upstream "
                "or the download was corrupted."
            )
        extract_files(tmp_path, files, target_dir)
        print(f"  ok    extracted {len(files)} file(s) -> {target_dir}")
        if pinned is None:
            return "unpinned", sha256
        return "fetched", sha256
    finally:
        tmp_path.unlink(missing_ok=True)


def print_pin_blocks(unpinned: list[tuple[str, str]]) -> None:
    if not unpinned:
        return
    print("\n" + "=" * 72)
    print("New sha256 pins to paste into textures.lock.json (\"sha256\" field):")
    print("=" * 72)
    for ref, digest in unpinned:
        print(f'  "{ref}":')
        print(f'    "sha256": "{digest}"')
    print()


def print_attribution(lock: dict[str, Any], out_dir: Path) -> None:
    present = [
        s for s in lock["sets"] if files_present(out_dir / s["assetId"], s["files"])
    ]
    print("\n" + "-" * 72)
    print(f"Textures: {lock['source']} materials, licence {lock['licence']} (public domain).")
    print("No attribution is legally required, but the source is credited below:")
    for s in present:
        print(f"  - {s['assetId']}: https://ambientcg.com/view?id={s['assetId']}")
    if not present:
        print("  (none fetched yet)")
    print("-" * 72)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    parser.add_argument(
        "--lock", type=Path, default=DEFAULT_LOCK, help=f"path to textures.lock.json (default: {DEFAULT_LOCK})"
    )
    parser.add_argument(
        "--out-dir", type=Path, default=DEFAULT_OUT_DIR, help=f"extraction root (default: {DEFAULT_OUT_DIR})"
    )
    parser.add_argument(
        "--only",
        action="append",
        metavar="REF",
        help="fetch only this set (ref like ambientcg:Wood051, or bare assetId); repeatable",
    )
    parser.add_argument("--force", action="store_true", help="re-fetch even if target files already exist")
    args = parser.parse_args(argv)

    lock = load_lock(args.lock)
    sets = select_sets(lock, args.only)

    unpinned: list[tuple[str, str]] = []
    had_error = False
    for entry in sets:
        try:
            status, digest = fetch_one(entry, args.out_dir, args.force)
        except SystemExit as exc:
            print(str(exc), file=sys.stderr)
            had_error = True
            continue
        if status == "unpinned" and digest:
            unpinned.append((entry["ref"], digest))

    print_pin_blocks(unpinned)
    print_attribution(lock, args.out_dir)

    return 1 if had_error else 0


if __name__ == "__main__":
    raise SystemExit(main())
