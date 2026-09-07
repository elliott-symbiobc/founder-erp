#!/usr/bin/env python3
"""Compute the version AT EACH COMMIT, and record why it moved.

WHAT WAS WRONG

The first version of this script read a baseline file out of each commit. That
file did not exist before the versioning system was written, so ten of twelve
commits reported no version at all and the panel showed a git log with a dead
column. Worse, it made the version look declared rather than computed — exactly
the opacity the whole exercise was meant to remove.

WHAT IT DOES NOW

For every commit that touched the pipeline, in order from oldest to newest:

  1. check the package out to a temporary directory
  2. extract its public API surface
  3. run the reference pack through it and hash the answers
  4. compare against the previous commit and apply the rule
  5. record the version, the level, and the specific reasons

So each row carries the decision AND its evidence: "major - Cocoa husk / Pectin
/ P1 margin 933.0 -> 871.2" rather than a bare number a reader has to trust.

WHY REPLAY RATHER THAN A STORED FILE

A stored version can only say what someone wrote down. A replayed one says what
the code did. If the two disagree, the replay is right — and disagreement is
itself worth seeing, which is why the manual override below is recorded
alongside the computed value rather than replacing it.

HUMAN OVERRIDE

version_overrides.json, committed in the repo, maps a commit to a version and a
reason. An override is shown next to the computed value, never instead of it: a
human who decides a change is more significant than the rule saw should be able
to say so without erasing what the rule found. The reason is required, because
an override without one is indistinguishable from a mistake.
"""
from __future__ import annotations

import datetime as dt
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path("/opt/openerp")
PKG = "api/app/vendor_sidestream"
#: Every path whose behaviour can reach a result. The history sat ten commits
#: behind because only PKG was watched, and the router and kernel manager - both
#: of which execute the pipeline - were invisible to it.
#: Data written by the pipeline itself. Excluded from the working-tree
#: comparison: a run that produces output is not an unreviewed code change.
DATA_PATHS = ("vendor_sidestream_registers", "version_history.json")

TRACKED = (
    "api/app/vendor_sidestream",
    "api/app/routers/sidestream.py",
    "api/app/notebook_kernel.py",
)
REF_PACK = REPO / "api/app/examples/cocoa_husk_worked.json"
OVERRIDES = REPO / "api/app/version_overrides.json"
OUT = REPO / "api/app/version_history.json"
SEP = "\x1f"


def git(*args: str, timeout: int = 60, text: bool = True):
    """Run git in the repo. Pass text=False for binary output (archives)."""
    return subprocess.run(("git", "-C", str(REPO)) + args,
                          capture_output=True, text=text, timeout=timeout)


def checkout(commit: str, dest: Path) -> Path | None:
    """Materialise the package as it stood at `commit`."""
    r = git("archive", commit, PKG, timeout=90, text=False)
    if r.returncode != 0:
        return None
    tar = dest / "pkg.tar"
    tar.write_bytes(r.stdout)
    subprocess.run(["tar", "xf", str(tar), "-C", str(dest)], check=False)
    root = dest / PKG
    return root if root.exists() else None


def surface_and_answers(root: Path) -> tuple[dict, str | None, dict | None]:
    """Extract the surface with TODAY's reader; run the reference pack on OLD code.

    The measuring instrument must be constant across the history, so extraction
    uses today's AST reader against old source — it parses text and imports
    nothing, so this is safe.

    The reference RUN is the opposite: it must execute the old code, because the
    question is what answers THAT code produced. It runs in a SUBPROCESS. A
    package imported from one checkout stays in sys.modules, and deleting the
    top-level names does not help because submodules hold live references to
    each other — the second checkout silently re-used the first one's code, and
    every row reported "surface only" as a result. A subprocess shares no state
    by construction, so isolation is a property of the mechanism rather than of
    my bookkeeping.
    """
    surface, fp, answers = {}, None, None

    sys.path.insert(0, str(REPO / "api/app"))
    try:
        from vendor_sidestream import version as V  # type: ignore
        surface = V.extract(root).to_json()
    except Exception as exc:
        print(f"    surface extraction failed: {exc}")
    finally:
        sys.path.remove(str(REPO / "api/app"))

    # Today's fingerprint module, overlaid onto the old checkout. The
    # measurement must be constant while the code measured is the commit's own;
    # results_fingerprint.py exists only in the newest commit, so without this
    # every historical row falls back to the weaker surface test.
    live_fp = REPO / "api/app/vendor_sidestream/results_fingerprint.py"
    target = root / "results_fingerprint.py"
    if live_fp.exists() and not target.exists():
        target.write_text(live_fp.read_text(encoding="utf-8"), encoding="utf-8")

    probe = (
        "import json, sys\n"
        f"sys.path.insert(0, {str(root.parent)!r})\n"
        "try:\n"
        "    from vendor_sidestream import results_fingerprint as F\n"
        f"    fp, ans = F.fingerprint({str(REF_PACK)!r})\n"
        "    print(json.dumps({'fp': fp, 'answers': ans}))\n"
        "except Exception as exc:\n"
        "    print(json.dumps({'error': type(exc).__name__ + ': ' + str(exc)[:140]}))\n"
    )
    r = subprocess.run([sys.executable, "-c", probe],
                       capture_output=True, text=True, timeout=120)
    if r.returncode == 0 and r.stdout.strip():
        try:
            payload = json.loads(r.stdout.strip().split("\n")[-1])
            fp, answers = payload.get("fp"), payload.get("answers")
            if payload.get("error"):
                print(f"    reference run unavailable: {payload['error']}")
        except ValueError:
            pass
    return surface, fp, answers


def decide(prev: dict, cur: dict) -> tuple[str, list[str]]:
    """Apply the rule between two commits, using the CURRENT implementation.

    The rule itself is deliberately not replayed per commit — a history where
    the grading standard changed between rows could not be read.
    """
    sys.path.insert(0, str(REPO / "api/app"))
    try:
        from vendor_sidestream import version as V  # type: ignore
        from vendor_sidestream import results_fingerprint as F  # type: ignore
    finally:
        sys.path.remove(str(REPO / "api/app"))

    reasons: list[str] = []
    results_changed = (prev.get("fp") is not None and cur.get("fp") is not None
                       and prev["fp"] != cur["fp"])
    if results_changed:
        reasons = F.diff_answers(prev.get("answers") or {},
                                 cur.get("answers") or {})[:6]
        return "major", reasons or ["reference answers changed"]

    old_s = V.Surface.from_json(prev.get("surface") or {})
    new_s = V.Surface.from_json(cur.get("surface") or {})
    level, surface_reasons = V.compare(old_s, new_s)
    if level in ("major", "minor") and surface_reasons:
        return "minor", surface_reasons[:6]
    return "patch", []


def _refresh_baseline(version: str) -> str:
    """Accept the current surface and answers as the baseline at `version`.

    The baseline exists so the running platform can tell whether the code it is
    executing has drifted from the last graded commit - a signature changed
    inside a committed file is invisible to git and visible here.

    It only works if something advances it. Written once on 8 August and never
    updated, it reported every module added since as uncommitted work: 68
    phantom changes against a clean tree, because the file predated closure,
    namesearch, namecache and relevance.

    Uses the package's own write_baseline rather than re-deriving the surface,
    so the file keeps the answers alongside it - that is what lets a later
    change be reported as "cocoa husk / Pectin / P1 margin 933.0 -> 871.2"
    rather than "the fingerprint differs".
    """
    sys.path.insert(0, str(REPO / "api/app"))
    try:
        from vendor_sidestream import version as V  # type: ignore
        path = V.write_baseline(REPO / "api/app/vendor_sidestream", version,
                                REPO / "api/app/api_surface.json")
    finally:
        sys.path.remove(str(REPO / "api/app"))
    return str(path)


def main() -> int:
    r = git("log", "--reverse",
            f"--format=%H{SEP}%h{SEP}%ad{SEP}%an{SEP}%s", "--date=short", "--", *TRACKED)
    if r.returncode != 0:
        print("git log failed:", r.stderr.strip()[:200])
        return 1

    overrides = {}
    if OVERRIDES.exists():
        overrides = json.loads(OVERRIDES.read_text(encoding="utf-8"))

    sys.path.insert(0, str(REPO / "api/app"))
    from vendor_sidestream import version as V  # type: ignore
    sys.path.remove(str(REPO / "api/app"))

    entries: list[dict] = []
    prev: dict = {}
    version = "0.1.0"

    for line in r.stdout.strip().split("\n"):
        if not line:
            continue
        full, short, date, author, subject = line.split(SEP, 4)

        tmp = Path(tempfile.mkdtemp(prefix="sv-"))
        try:
            root = checkout(full, tmp)
            cur: dict = {}
            if root:
                surface, fp, answers = surface_and_answers(root)
                cur = {"surface": surface, "fp": fp, "answers": answers}

            if not prev:
                level, reasons = "initial", []
            elif not cur.get("surface"):
                level, reasons = "patch", ["package not extractable at this commit"]
            else:
                level, reasons = decide(prev, cur)
                if level != "patch":
                    version = V.bump(version, level)

            stat = git("show", "--stat", "--format=", full, "--", PKG)
            changed = len([l for l in stat.stdout.strip().split("\n")
                           if l.strip() and "|" in l])

            ov = overrides.get(short) or overrides.get(full)
            if ov and not ov.get("reason"):
                # An override without a reason cannot later be told apart from a
                # mistake, so it is refused rather than silently applied.
                print(f"    IGNORED override on {short}: no reason given")
                ov = None

            files = [l.split("|")[0].strip()
                     for l in stat.stdout.strip().split("\n")
                     if l.strip() and "|" in l]

            entries.append({
                "files": files[:12],
                "tested": ("answers" if cur.get("fp") and prev.get("fp")
                           else "surface only"),
                "commit": short,
                "full": full,
                "date": date,
                "author": author,
                "subject": subject,
                "version": (ov or {}).get("version") or version,
                "computed_version": version,
                "level": level,
                "reasons": reasons,
                "files_changed": changed,
                "override": ov,
            })
            if cur.get("surface"):
                prev = cur
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    entries.reverse()  # newest first, as read
    OUT.write_text(json.dumps({
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "head": entries[0]["commit"] if entries else None,
        "entries": entries,
    }, indent=1) + "\n", encoding="utf-8")

    bumps = [e for e in entries if e["level"] in ("major", "minor")]
    print(f"wrote {OUT} — {len(entries)} commits, {len(bumps)} version changes")
    # Advance the baseline to the version just computed, so the
    # platform stops reporting committed modules as uncommitted work.
    try:
        _cur = entries[0]["version"] if entries else "0.0.0"   # entries[0] is newest
        print("refreshed baseline:", _refresh_baseline(_cur))
    except Exception as exc:  # noqa: BLE001 - reported, never fatal
        print("baseline refresh failed:", exc)
    for e in bumps[:8]:
        print(f"  {e['commit']}  {e['level']:6s} -> {e['version']}  "
              f"{(e['reasons'][0] if e['reasons'] else '')[:60]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
