#!/usr/bin/env python3
"""Compatibility launcher for the Phase 8 Store D1 lifecycle test.

Cloudflare Workers Builds ships Python without the optional _sqlite3 extension,
while both canonical CI runtimes provide Node 22+ with node:sqlite. Keep the
existing package command stable and execute the real SQLite lifecycle assertions
through the portable Node test.
"""

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TEST = ROOT / "scripts" / "test-phase8-action-lifecycle.mjs"

os.execvp("node", ["node", str(TEST)])
