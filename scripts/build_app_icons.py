"""Builds every app icon from the owner's logo (public/logo.png, 1254 x 1254, rounded square on black).

Writes:
  android/app/src/main/res/mipmap-*/ic_launcher_foreground.png  adaptive icon foreground (108 dp layer)
  android/app/src/main/res/mipmap-*/ic_launcher.png, ic_launcher_round.png  legacy icons (48 dp)
  android/app/src/main/res/drawable-nodpi/app_logo.png           About screen logo
  public/favicon.png, public/apple-touch-icon.png, public/app-logo.png  web simulator
  docs/screenshots/app-icon.png                                  README header

The black outside the rounded square becomes transparent; the orange glow around the gold rim is kept
as partial transparency. In the adaptive foreground the logo is 56 dp wide, so the whole rounded square
(gold corners included) stays inside the 72 dp circle that launchers show.

Run: python -X utf8 scripts/build_app_icons.py [repository root]   (needs Pillow)
"""
import os
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..')
SRC = os.path.join(ROOT, 'public', 'logo.png')
RES = os.path.join(ROOT, 'android', 'app', 'src', 'main', 'res')
DENSITIES = {'mdpi': 1.0, 'hdpi': 1.5, 'xhdpi': 2.0, 'xxhdpi': 3.0, 'xxxhdpi': 4.0}


def transparent_logo() -> Image.Image:
    """The logo cropped to its glow, with the black background made transparent."""
    im = Image.open(SRC).convert('RGB')
    w, h = im.size
    # Everything visibly brighter than the black background belongs to the logo
    lum = im.convert('L')
    bbox = lum.point(lambda v: 255 if v > 40 else 0).getbbox()
    left, top, right, bottom = bbox
    # Solid inside the rounded square (slightly inset from the gold rim's outer edge)
    side = right - left
    radius = int(side * 0.19)
    inset = int(side * 0.012)
    scale = 4
    mask = Image.new('L', (w * scale, h * scale), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [(left + inset) * scale, (top + inset) * scale, (right - inset) * scale, (bottom - inset) * scale],
        radius=radius * scale, fill=255)
    solid = mask.resize((w, h), Image.LANCZOS)
    # Outside it: the glow, its brightness as opacity
    glow = lum.point(lambda v: min(255, int(v * 2.2)))
    alpha = ImageChops.lighter(solid, glow).filter(ImageFilter.SMOOTH)
    out = im.copy()
    out.putalpha(alpha)
    pad = int(side * 0.03)
    return out.crop((max(0, left - pad), max(0, top - pad), min(w, right + pad), min(h, bottom + pad)))


def fit(logo: Image.Image, size: int, content: float, background=None, circle=False) -> Image.Image:
    """[logo] scaled to [content] of a [size] square, centred; optional background (square or circle)."""
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    if background is not None:
        big = size * 4
        bg = Image.new('RGBA', (big, big), (0, 0, 0, 0))
        d = ImageDraw.Draw(bg)
        if circle:
            d.ellipse([0, 0, big - 1, big - 1], fill=background)
        else:
            d.rectangle([0, 0, big, big], fill=background)
        canvas = bg.resize((size, size), Image.LANCZOS)
    inner = max(1, round(size * content))
    scaled = logo.resize((inner, inner), Image.LANCZOS)
    off = (size - inner) // 2
    canvas.alpha_composite(scaled, (off, off))
    return canvas


def save(img: Image.Image, path: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, optimize=True)
    print(os.path.relpath(path, ROOT), img.size)


def main() -> None:
    logo = transparent_logo()
    for name, f in DENSITIES.items():
        d = os.path.join(RES, f'mipmap-{name}')
        save(fit(logo, round(108 * f), 56 / 108), os.path.join(d, 'ic_launcher_foreground.png'))
        save(fit(logo, round(48 * f), 0.96), os.path.join(d, 'ic_launcher.png'))
        save(fit(logo, round(48 * f), 0.74, background=(10, 5, 6, 255), circle=True), os.path.join(d, 'ic_launcher_round.png'))
    save(fit(logo, 256, 1.0), os.path.join(RES, 'drawable-nodpi', 'app_logo.png'))
    save(fit(logo, 64, 1.0), os.path.join(ROOT, 'public', 'favicon.png'))
    save(fit(logo, 180, 0.9, background=(10, 5, 6, 255)), os.path.join(ROOT, 'public', 'apple-touch-icon.png'))
    save(fit(logo, 256, 1.0), os.path.join(ROOT, 'public', 'app-logo.png'))
    save(fit(logo, 256, 1.0), os.path.join(ROOT, 'docs', 'screenshots', 'app-icon.png'))


if __name__ == '__main__':
    main()
