"""Remove the background from a cat clip and export a transparent, looping WebM.

Usage:
  .venv/bin/python remove_bg.py <input.mp4> <output.webm> [--size 480] [--model birefnet-general]

Pipeline: ffmpeg extracts frames -> rembg (BiRefNet) cuts out the cat per frame ->
ffmpeg encodes VP9 with alpha (plays transparent in Chromium/Electron).
"""

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image
from rembg import new_session, remove


def run(cmd):
    subprocess.run(cmd, check=True)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("input")
    p.add_argument("output")
    p.add_argument("--size", type=int, default=480, help="output width/height in px")
    p.add_argument("--work-size", type=int, default=1024, help="resolution matting runs at")
    p.add_argument("--model", default="birefnet-general")
    p.add_argument("--keep-frames", help="also save the RGBA PNG frames to this folder")
    args = p.parse_args()

    tmp = Path(tempfile.mkdtemp(prefix="deskat_"))
    src, out = tmp / "src", tmp / "out"
    src.mkdir()
    out.mkdir()
    try:
        run(["ffmpeg", "-v", "error", "-i", args.input,
             "-vf", f"scale={args.work_size}:-2:flags=lanczos", str(src / "f%04d.png")])
        frames = sorted(src.glob("*.png"))
        session = new_session(args.model)
        for i, f in enumerate(frames, 1):
            img = Image.open(f).convert("RGB")
            cut = remove(img, session=session, post_process_mask=True)
            cut = cut.resize((args.size, args.size), Image.LANCZOS)
            cut.save(out / f.name)
            print(f"\r{i}/{len(frames)}", end="", file=sys.stderr, flush=True)
        print(file=sys.stderr)

        fps = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v", "-show_entries",
             "stream=r_frame_rate", "-of", "csv=p=0", args.input],
            capture_output=True, text=True, check=True).stdout.strip()

        Path(args.output).parent.mkdir(parents=True, exist_ok=True)
        run(["ffmpeg", "-v", "error", "-y", "-framerate", fps, "-i", str(out / "f%04d.png"),
             "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "30",
             "-row-mt", "1", "-auto-alt-ref", "0", "-an", args.output])

        if args.keep_frames:
            dst = Path(args.keep_frames)
            dst.mkdir(parents=True, exist_ok=True)
            for f in out.glob("*.png"):
                shutil.copy(f, dst / f.name)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
