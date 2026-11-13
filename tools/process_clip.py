"""Turn a raw Kling clip into a transparent, canvas-normalized WebM for the app.

Usage (from the deskat folder):
  tools/.venv/bin/python tools/process_clip.py <cat> <clip> [--method key|hybrid|ai] [--height 480]

Reads <cat>/clips.json to know which source image the clip was generated from, so every
clip ends up in the same canvas (the padded sit pose, 1536x1024 "canvas units") with the
cat at the same scale and position. Output: <cat>/final/<clip>.webm (VP9 + alpha).

Steps: ffmpeg frames -> matte per frame (see matte.py) -> place on canvas -> scale -> VP9 alpha.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import matte  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CANVAS = (1536, 1024)

def probe(path, entries):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v", "-show_entries",
                          f"stream={entries}", "-of", "csv=p=0", str(path)],
                         capture_output=True, text=True, check=True).stdout.strip()
    return out.split(",")


def placement(cat_dir, clip_cfg):
    """Where the clip's source image sits inside the canvas: (x, y, w, h) in canvas units."""
    src = clip_cfg.get("sourceImage", "")
    if src.startswith("master.jpg"):
        m = Image.open(cat_dir / "master.jpg")
        scale = CANVAS[1] / m.height
        w = round(m.width * scale)
        return ((CANVAS[0] - w) // 2, 0, w, CANVAS[1])
    return (0, 0, CANVAS[0], CANVAS[1])


def main():
    p = argparse.ArgumentParser()
    p.add_argument("cat")
    p.add_argument("clip")
    p.add_argument("--height", type=int, default=480, help="output canvas height in px")
    p.add_argument("--method", choices=["key", "hybrid", "ai"], default="hybrid",
                   help="key: color key vs the flat background (fast); hybrid: key + AI on edges; ai: BiRefNet")
    p.add_argument("--work-height", type=int, default=768, help="height matting runs at (key/hybrid downscale to this; ai runs the model at it)")
    p.add_argument("--model", default="birefnet-general-lite")
    p.add_argument("--coarse-model", default="u2net", help="silhouette model for hybrid (runs at 320px)")
    p.add_argument("--person", action="store_true",
                   help="human character: person-segmentation silhouette, trusted inside (clothing near bg color)")
    p.add_argument("--coreml", action="store_true", help="try the CoreML provider for AI (slow first compile)")
    args = p.parse_args()

    cat_dir = ROOT / args.cat
    cfg = json.loads((cat_dir / "clips.json").read_text())["clips"][args.clip]
    raw = cat_dir / "raw" / f"{args.clip}.mp4"
    out_webm = cat_dir / "final" / f"{args.clip}.webm"
    fps = probe(raw, "r_frame_rate")[0]

    tmp = Path(tempfile.mkdtemp(prefix=f"deskat_{args.clip}_"))
    src, cut, comp = tmp / "src", tmp / "cut", tmp / "comp"
    for d in (src, cut, comp):
        d.mkdir()
    t0 = time.time()
    try:
        subprocess.run(["ffmpeg", "-v", "error", "-i", str(raw), str(src / "f%04d.png")], check=True)
        frames = sorted(src.glob("*.png"))
        matte.USE_COREML = args.coreml
        bg = matte.sample_bg(Image.open(frames[0]))
        for i, f in enumerate(frames, 1):
            img = Image.open(f).convert("RGB")
            if args.method != "ai":
                img = matte.to_height(img, args.work_height)
            if args.method == "key":
                out = matte.key(img, bg)
            elif args.method == "hybrid":
                if args.person:
                    out = matte.hybrid(img, bg, "u2net_human_seg", trust_silhouette=True)
                else:
                    out = matte.hybrid(img, bg, args.coarse_model)
            else:
                out = matte.ai(img, args.model, args.work_height)
            out.save(cut / f.name)
            print(f"\r{args.clip}: {args.method} {i}/{len(frames)}", end="", file=sys.stderr, flush=True)
        print(file=sys.stderr)

        x, y, w, h = placement(cat_dir, cfg)
        k = args.height / CANVAS[1]
        size = (round(CANVAS[0] * k) // 2 * 2, args.height)
        box = (round(x * k), round(y * k), round(w * k), round(h * k))
        for f in sorted(cut.glob("*.png")):
            im = Image.open(f).convert("RGBA").resize(box[2:], Image.LANCZOS)
            canvas = Image.new("RGBA", size, (0, 0, 0, 0))
            canvas.alpha_composite(im, box[:2])
            canvas.save(comp / f.name)

        out_webm.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-framerate", fps, "-i", str(comp / "f%04d.png"),
                        "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "30",
                        "-row-mt", "1", "-auto-alt-ref", "0", "-an", str(out_webm)], check=True)
        # keep the first/last cut frames for seam checks and previews
        prev = cat_dir / "final" / "frames"
        prev.mkdir(exist_ok=True)
        allc = sorted(comp.glob("*.png"))
        shutil.copy(allc[0], prev / f"{args.clip}_first.png")
        shutil.copy(allc[-1], prev / f"{args.clip}_last.png")
        print(f"{args.clip}: {len(frames)} frames -> {out_webm.relative_to(ROOT)} "
              f"{size[0]}x{size[1]} [{args.method}] in {time.time() - t0:.0f}s", file=sys.stderr)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
