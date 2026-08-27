# 打包 moka-transcript-getter skill 为 zip，忽略 agents 目录
import os
import sys
import zipfile
from pathlib import Path

SKILL_DIR_NAME = "moka-transcript-getter"
IGNORE_DIRS = {"agents"}


def main() -> int:
    script_dir = Path(__file__).resolve().parent
    src_dir = script_dir / SKILL_DIR_NAME
    if not src_dir.is_dir():
        print(f"[error] 未找到目录: {src_dir}", file=sys.stderr)
        return 1

    out_zip = script_dir / f"{SKILL_DIR_NAME}.zip"
    if out_zip.exists():
        out_zip.unlink()

    file_count = 0
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, dirs, files in os.walk(src_dir):
            dirs[:] = [d for d in dirs if d not in IGNORE_DIRS]
            for name in files:
                abs_path = Path(root) / name
                arcname = abs_path.relative_to(src_dir)
                zf.write(abs_path, arcname.as_posix())
                file_count += 1

    print(f"[ok] 打包完成: {out_zip} ({file_count} files)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
