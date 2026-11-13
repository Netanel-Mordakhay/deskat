"""Matting methods for process_clip.py. Each returns an RGBA PIL image the size of the input.

key    - color-distance key against the flat beige background (fast, numpy only)
hybrid - key, with BiRefNet-lite (512px) replacing alpha only in a band around the edge
ai     - BiRefNet (lite by default) on the whole frame, CoreML provider when available
"""

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

# ------------------------------------------------------------------ key


def sample_bg(img: Image.Image, patch: int = 32) -> np.ndarray:
    """Median color of the four corner patches (the background is flat beige)."""
    a = np.asarray(img.convert("RGB"), dtype=np.float32)
    h, w = a.shape[:2]
    corners = [a[:patch, :patch], a[:patch, w - patch:], a[h - patch:, :patch], a[h - patch:, w - patch:]]
    return np.median(np.concatenate([c.reshape(-1, 3) for c in corners]), axis=0)


def _ycc(rgb: np.ndarray):
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    y = 0.299 * r + 0.587 * g + 0.114 * b
    cb = -0.168736 * r - 0.331264 * g + 0.5 * b
    cr = 0.5 * r - 0.418688 * g - 0.081312 * b
    return y, cb, cr


def _ramp(x, lo, hi):
    return np.clip((x - lo) / (hi - lo), 0.0, 1.0)


# Thresholds (tuned on Grace on #E9D7BF-ish beige):
#  chroma distance: the gray cat is ~18 away from beige, compression noise ~2, shadow ~4
#  luminance drop: the soft contact shadow is < ~45 darker than the background, the cat > 80
CHROMA = (7.0, 14.0)
DARKER = (55.0, 85.0)
BRIGHTER = (30.0, 60.0)


def key_alpha(rgb: np.ndarray, bg: np.ndarray) -> np.ndarray:
    y, cb, cr = _ycc(rgb)
    by, bcb, bcr = _ycc(bg.reshape(1, 1, 3))
    cd = np.hypot(cb - bcb, cr - bcr)
    a = np.maximum.reduce([
        _ramp(cd, *CHROMA),
        _ramp(by - y, *DARKER),
        _ramp(y - by, *BRIGHTER),
    ])
    return a


def _fill_holes(a: np.ndarray, max_frac: float = 0.002, keep_clear: np.ndarray | None = None) -> np.ndarray:
    """Small background-colored areas fully enclosed by the cat (ear insides, eye glints) become
    opaque. Large enclosed areas (the gap between legs closed off by the tail) stay transparent."""
    from scipy import ndimage
    holes = ndimage.binary_fill_holes(a > 0.5) & ~(a > 0.5)
    lab, n = ndimage.label(holes)
    if n == 0:
        return a
    sizes = ndimage.sum(holes, lab, index=np.arange(1, n + 1))
    small = np.isin(lab, np.nonzero(sizes <= max_frac * a.size)[0] + 1)
    if keep_clear is not None:
        small &= ~keep_clear  # real background seen through a gap (between arm and body) stays clear
    out = a.copy()
    out[small] = 1.0
    return out


def definite_bg(rgb: np.ndarray, bg: np.ndarray) -> np.ndarray:
    """Pixels that match the flat background so closely they can't be fur (shadow included)."""
    y, cb, cr = _ycc(rgb)
    by, bcb, bcr = _ycc(bg.reshape(1, 1, 3))
    return (np.hypot(cb - bcb, cr - bcr) < 4.5) & (np.abs(y - by) < 40)


def _clean(a: np.ndarray, erode: int = 3, feather: float = 0.8, keep_clear: np.ndarray | None = None) -> np.ndarray:
    a = _fill_holes(a, keep_clear=keep_clear)
    img = Image.fromarray((a * 255).astype(np.uint8))
    if erode:
        img = img.filter(ImageFilter.MinFilter(erode))
    if feather:
        img = img.filter(ImageFilter.GaussianBlur(feather))
    out = np.asarray(img, dtype=np.float32) / 255
    out[out < 0.06] = 0
    return out


def _despill(rgb: np.ndarray, a: np.ndarray, bg: np.ndarray) -> np.ndarray:
    """Un-mix the beige from semi-transparent edge pixels: C = a*F + (1-a)*B  ->  F."""
    a3 = a[..., None]
    edge = (a3 > 0.02) & (a3 < 0.98)
    f = (rgb - (1 - a3) * bg) / np.maximum(a3, 0.15)
    return np.where(edge, np.clip(f, 0, 255), rgb)


def _rgba(rgb: np.ndarray, a: np.ndarray) -> Image.Image:
    out = np.dstack([rgb, a * 255]).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def key(img: Image.Image, bg: np.ndarray) -> Image.Image:
    rgb = np.asarray(img.convert("RGB"), dtype=np.float32)
    a = _clean(key_alpha(rgb, bg))
    return _rgba(_despill(rgb, a, bg), a)


# ------------------------------------------------------------------ ai

_sessions = {}


USE_COREML = False  # set by --coreml; BiRefNet's Neural Engine compile took >16 min on an M4 without finishing


def ai_session(model: str):
    if model not in _sessions:
        import onnxruntime as ort
        from rembg import new_session
        avail = ort.get_available_providers()
        wanted = ("CoreMLExecutionProvider", "CPUExecutionProvider") if USE_COREML else ("CPUExecutionProvider",)
        _sessions[model] = new_session(model, providers=[p for p in wanted if p in avail])
    return _sessions[model]


def ai_mask(img: Image.Image, model: str, work_h: int) -> np.ndarray:
    from rembg import remove
    small = img.convert("RGB")
    if small.height != work_h:
        small = small.resize((round(small.width * work_h / small.height), work_h), Image.LANCZOS)
    m = remove(small, session=ai_session(model), only_mask=True, post_process_mask=True)
    m = m.resize(img.size, Image.LANCZOS)
    return np.asarray(m, dtype=np.float32) / 255


def ai(img: Image.Image, model: str, work_h: int) -> Image.Image:
    rgb = np.asarray(img.convert("RGB"), dtype=np.float32)
    return _rgba(rgb, ai_mask(img, model, work_h))


def shadow_like(rgb: np.ndarray, bg: np.ndarray) -> np.ndarray:
    """A darker copy of the background color (same hue/ratios): floor shadow, not fur."""
    y, _, _ = _ycc(rgb)
    by = _ycc(bg.reshape(1, 1, 3))[0]
    norm = rgb / np.maximum(rgb.sum(-1, keepdims=True), 1)
    bnorm = bg / bg.sum()
    return (np.abs(norm - bnorm).max(-1) < 0.015) & (y > 0.4 * by) & (y < by + 10)


def hybrid(img: Image.Image, bg: np.ndarray, model: str, work_h: int = 384, shrink: int = 7,
           band: int = 13, trust_silhouette: bool = False) -> Image.Image:
    """Key for crisp edges; a coarse AI silhouette fills the body so light fur that's close to
    the background color can't be keyed out (no notches). The key only counts within a narrow
    band around the silhouette, so floor shadows and streaks away from the cat are dropped,
    and true background inside the silhouette (gaps between legs) is never filled."""
    rgb = np.asarray(img.convert("RGB"), dtype=np.float32)
    k = key_alpha(rgb, bg)
    sil = Image.fromarray(((ai_mask(img, model, work_h) > 0.5) * 255).astype(np.uint8))
    body = np.asarray(sil.filter(ImageFilter.MinFilter(shrink)), dtype=np.float32) / 255  # stay inside the edge
    near = np.asarray(sil.filter(ImageFilter.MaxFilter(band))) > 127  # silhouette + edge band
    k[~near] = 0
    clear = definite_bg(rgb, bg)
    if trust_silhouette:
        # people: the person-segmentation silhouette separates legs well, so background-colored
        # clothing inside it (denim on blue, skin on beige) stays opaque
        inner = np.asarray(sil.filter(ImageFilter.MinFilter(9))) > 127
        body[clear & ~inner] = 0
    else:
        body[clear] = 0  # pets: the coarse silhouette bridges gaps between legs
    outside = np.asarray(sil) < 128  # the AI silhouette also says "not the character here"
    a = _clean(np.maximum(k, body), keep_clear=clear & outside)
    return _rgba(_despill(rgb, a, bg), a)


def to_height(img: Image.Image, h: int) -> Image.Image:
    return img if img.height <= h else img.resize((round(img.width * h / img.height), h), Image.LANCZOS)
