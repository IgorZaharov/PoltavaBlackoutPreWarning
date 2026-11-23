"""Builds every app icon from the owner's logo (public/logo.png, 1254 x 1254, rounded square on black).

Writes:
  android/app/src/main/res/mipmap-*/ic_launcher_foreground.png  adaptive icon foreground (108 dp layer)
  android/app/src/main/res/mipmap-*/ic_launcher.png, ic_launcher_round.png  legacy icons (48 dp)
  android/app/src/main/res/drawable-nodpi/app_logo.png           About screen logo
  public/favicon.png, public/apple-touch-icon.png, public/app-logo.png  web simulator
  docs/screenshots/app-icon.png                                  README header
  ios/Resources/Assets.xcassets/AppLogo.imageset/app_logo.png    iPhone About screen logo
  ios/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png  iPhone app icon (opaque: App Store Connect
                                                                 rejects transparency; iOS applies its own mask)

The logo is the house under power lines (owner, 2026-11-23). It replaced the shield with the Poltava coat of arms,
because App Review rejected 1.0.0 (35) under guideline 4.1 for the reference to Poltava oblast in the icon.

The black outside the rounded square becomes transparent (a flood fill from the image edge, so any corner shape
works); the glow around the rim is kept as partial transparency. In the adaptive foreground the rounded square is
about 62 dp wide: launchers show only the middle 72 dp and then cut it with their own mask (rounded square,
squircle), so at 72 dp (owner, 2026-11-17) the rim was clipped (owner, 2026-11-18); 62 dp keeps about 5 dp to the
edge and clears squircle corners. The adaptive background is the logo's own maroon (`ic_launcher_background`),
so no dark ring shows around it.

The iPhone icon is full bleed: the inside of the rounded square, cropped so that the logo's own corners and rim
fall outside the rounded mask that iOS draws (no frame inside a frame).

Run: python -X utf8 scripts/build_app_icons.py [repository root]   (needs Pillow)
"""
import os
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..')
SRC = os.path.join(ROOT, 'public', 'logo.png')
RES = os.path.join(ROOT, 'android', 'app', 'src', 'main', 'res')
MAROON = (48, 0, 11, 255)  # the logo's inner edge colour, also values/colors.xml ic_launcher_background
DENSITIES = {'mdpi': 1.0, 'hdpi': 1.5, 'xhdpi': 2.0, 'xxhdpi': 3.0, 'xxxhdpi': 4.0}
BLACK_MAX = 12  # luminance of the black background around the logo, at most


def logo_shape(im: Image.Image) -> Image.Image:
    """255 inside the rounded square (rim included), 0 on the black around it."""
    binary = im.convert('L').point(lambda v: 255 if v > BLACK_MAX else 0)
    w, h = binary.size
    # One black pixel of padding keeps the black around the logo connected where the logo touches an image edge
    padded = Image.new('L', (w + 2, h + 2), 0)
    padded.paste(binary, (1, 1))
    ImageDraw.floodfill(padded, (0, 0), 128)
    return padded.crop((1, 1, w + 1, h + 1)).point(lambda v: 0 if v == 128 else 255)


def transparent_logo() -> Image.Image:
    """The logo cropped to a square around its glow, with the black background made transparent."""
    im = Image.open(SRC).convert('RGB')
    shape = logo_shape(im)
    # Soft edge on the rounded square; outside it, the glow's brightness as opacity
    solid = shape.filter(ImageFilter.GaussianBlur(1.2))
    glow = im.convert('L').point(lambda v: min(255, int(v * 2.2)))
    alpha = ImageChops.lighter(solid, glow).filter(ImageFilter.SMOOTH)
    out = im.copy()
    out.putalpha(alpha)
    left, top, right, bottom = shape.getbbox()
    half = round(max(right - left, bottom - top) * 1.06) // 2  # 3 % of room on each side for the glow
    cx, cy = (left + right) // 2, (top + bottom) // 2
    # A crop past the image edge is filled with transparent pixels, so the result is always square
    return out.crop((cx - half, cy - half, cx + half, cy + half))


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
        save(fit(logo, round(108 * f), 66 / 108), os.path.join(d, 'ic_launcher_foreground.png'))
        save(fit(logo, round(48 * f), 0.96), os.path.join(d, 'ic_launcher.png'))
        save(fit(logo, round(48 * f), 0.74, background=MAROON, circle=True), os.path.join(d, 'ic_launcher_round.png'))
    save(fit(logo, 256, 1.0), os.path.join(RES, 'drawable-nodpi', 'app_logo.png'))
    save(fit(logo, 64, 1.0), os.path.join(ROOT, 'public', 'favicon.png'))
    save(fit(logo, 180, 0.9, background=(10, 5, 6, 255)), os.path.join(ROOT, 'public', 'apple-touch-icon.png'))
    save(fit(logo, 256, 1.0), os.path.join(ROOT, 'public', 'app-logo.png'))
    save(fit(logo, 256, 1.0), os.path.join(ROOT, 'docs', 'screenshots', 'app-icon.png'))
    save(ios_icon(), IOS_ICON)
    # About screen logo: 72 pt at @3x
    save(fit(logo, 216, 1.0), IOS_LOGO)


IOS_LOGO = os.path.join(ROOT, 'ios', 'Resources', 'Assets.xcassets', 'AppLogo.imageset', 'app_logo.png')
IOS_ICON = os.path.join(ROOT, 'ios', 'Resources', 'Assets.xcassets', 'AppIcon.appiconset', 'AppIcon-1024.png')
IOS_MASK_RADIUS = 0.2237  # corner radius of the iOS icon mask, as a share of the icon side
RIM = 0.03  # the logo's rim and its glow, as a share of the logo side: kept outside the iOS mask


def ios_crop(shape: Image.Image) -> tuple:
    """The largest centred square whose iOS-masked area lies wholly inside the logo's rim."""
    left, top, right, bottom = shape.getbbox()
    side = min(right - left, bottom - top)
    cx, cy = (left + right) / 2, (top + bottom) / 2
    inside = shape
    for _ in range(max(1, round(side * RIM))):  # shrink the shape by the rim width
        inside = inside.filter(ImageFilter.MinFilter(3))
    for inset in range(0, side // 4):
        half = side / 2 - inset
        box = (round(cx - half), round(cy - half), round(cx + half), round(cy + half))
        n = box[2] - box[0]
        mask = Image.new('L', (n, n), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, n - 1, n - 1], radius=n * IOS_MASK_RADIUS, fill=255)
        if ImageChops.subtract(mask, inside.crop(box)).getbbox() is None:
            return box
    raise ValueError('no crop of the logo fits the iOS mask')


def ios_icon() -> Image.Image:
    """1024 px, no alpha, full bleed: the inside of the logo, its own corners and rim outside the iOS mask."""
    im = Image.open(SRC).convert('RGB')
    box = ios_crop(logo_shape(im))
    print('iPhone icon crop', box)
    return im.crop(box).resize((1024, 1024), Image.LANCZOS)


if __name__ == '__main__':
    main()
