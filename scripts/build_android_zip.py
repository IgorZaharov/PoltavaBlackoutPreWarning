"""Build public/PoltavaBlackoutPreWarning.zip from the git-tracked files under android/.

Only tracked files go in, so local build outputs (android/app/build, .gradle, logs) never end up in
the downloadable archive. Paths inside the zip are relative to android/, like the archive the
upstream project shipped. Run from the repository root: python scripts/build_android_zip.py
"""
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "PoltavaBlackoutPreWarning.zip"


def main() -> int:
    files = subprocess.run(
        ["git", "ls-files", "-z", "--", "android"], cwd=ROOT, check=True, capture_output=True
    ).stdout.decode("utf-8").split("\0")
    files = [f for f in files if f and (ROOT / f).is_file()]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(OUT, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for rel in sorted(files):
            zf.write(ROOT / rel, arcname=Path(rel).relative_to("android").as_posix())
    print(f"wrote {OUT.relative_to(ROOT)} with {len(files)} files")
    return 0


if __name__ == "__main__":
    sys.exit(main())
