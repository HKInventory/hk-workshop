#!/usr/bin/env python3
"""Pre-merge validation for index.html.

The whole app — HTML, CSS and every line of JS — lives in one ~13,000-line file, and both the
workshop PWA and the TV board serve it. One stray bracket takes all of it down at once, on the
shop floor, with no staging step in between. This is the gate that stops that reaching main.

Three checks, cheap and deterministic:
  1. JS parses. Scripts are concatenated and wrapped in an async function so the legitimate
     `await import()` for the QR scanner is valid, then handed to `node --check`.
  2. <script> and <style> tags balance. A missing close tag silently swallows the rest of the
     page, which does not show up as a parse error but does break the app.
  3. Exactly one build marker. The auto-update banner compares the deployed marker to the running
     one; two different markers in the file means it can't tell them apart and phones keep
     serving stale JS after a deploy.

Exit 0 = safe to merge. Exit 1 = leave main alone.
"""
import re
import subprocess
import sys

SRC = "index.html"


def main() -> int:
    html = open(SRC, encoding="utf-8").read()
    failed = False

    # 1. JS parses.
    scripts = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", html, re.S)
    bundle = "async function __all(){\n" + "\n;\n".join(scripts) + "\n}"
    with open("/tmp/app_bundle.js", "w", encoding="utf-8") as fh:
        fh.write(bundle)
    check = subprocess.run(
        ["node", "--check", "/tmp/app_bundle.js"], capture_output=True, text=True
    )
    if check.returncode != 0:
        print("::error::index.html JavaScript does not parse")
        print(check.stderr.strip())
        failed = True
    else:
        print(f"JS OK ({len(scripts)} script blocks, {len(bundle.splitlines())} lines)")

    # 2. Tag balance.
    for tag in ("script", "style"):
        opened = len(re.findall(r"<%s\b" % tag, html))
        closed = len(re.findall(r"</%s>" % tag, html))
        status = "OK" if opened == closed else "MISMATCH"
        print(f"<{tag}>: {opened} open / {closed} close  {status}")
        if opened != closed:
            print(f"::error::{tag} tags unbalanced ({opened} open, {closed} close)")
            failed = True

    # 3. Exactly one build marker.
    markers = sorted(set(re.findall(r"\d{2}[A-Z][a-z]{2}-[A-Z]{2}", html)))
    print(f"build markers: {markers}")
    if len(markers) != 1:
        print(
            "::error::expected exactly one build marker across index.html, found "
            f"{markers or 'none'} — the auto-update banner cannot compare versions"
        )
        failed = True

    print("FAILED" if failed else "All checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
