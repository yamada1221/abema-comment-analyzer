#!/usr/bin/env python3
"""Verify a mock Chrome Web Store screenshot produced by browser tests.

This only checks image dimensions and file format. It does NOT mean the image
has been approved for publication, or that ABEMA live streaming was tested.
"""
from __future__ import annotations

import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main() -> None:
    name = ROOT / "test-results" / "screenshots" / "comments-1280.png"
    data = name.read_bytes()
    if (len(data) < 45 or data[:8] != bytes.fromhex("89504e470d0a1a0a")
            or data[12:16] != b"IHDR"):
        raise ValueError(f"Missing or malformed PNG screenshot: {name}")
    width, height = struct.unpack(">II", data[16:24])
    if (width, height) != (1280, 800):
        raise ValueError(f"Wrong store screenshot dimensions: {width}x{height}")
    if len(data) > 5_000_000:
        raise ValueError("Screenshot unexpectedly large")
    print(f"Mock screenshot validated: {name.name}, {width}x{height}")
    print("Not a live ABEMA screenshot and not published.")


if __name__ == "__main__":
    main()
