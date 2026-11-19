"""Builds the Google Play listing graphics from phone captures of the web simulator.

Reads docs/store/raw/*.png (the phone frame of the simulator captured at 3x, 1248 x 2671, taken on 2026-11-18 from
live POE data: emergency in с. Дабинівка, «Ремонти й пошкодження поруч», queue 1.1 drum in Полтава, the 15-minute
pre-warning, the address list and the widgets) and public/logo.png.

Writes (all RGB, no alpha, as Google Play asks):
  docs/store/phone_1.png .. phone_6.png   phone screenshots 1080 x 1920 (9:16)
  docs/store/feature_graphic.png          feature graphic 1024 x 500
  docs/store/icon_512.png                 hi-res app icon 512 x 512 (Play rounds the corners itself)
  public/playstore/playstore_promo_N.png  copies of the phone screenshots for the web simulator's Play Store tab

Run: python -X utf8 scripts/build_store_assets.py [repository root]   (needs Pillow; fonts: Segoe UI from Windows)
"""
import os
import shutil
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..')
RAW = os.path.join(ROOT, 'docs', 'store', 'raw')
OUT = os.path.join(ROOT, 'docs', 'store')
PUBLIC = os.path.join(ROOT, 'public', 'playstore')
FONTS = os.environ.get('STORE_FONTS', r'C:\Windows\Fonts')

BG = (14, 8, 12)
MAROON = (48, 0, 11)
ACCENT = (255, 94, 58)
GOLD = (245, 194, 66)
TEXT = (255, 255, 255)
SUB = (196, 186, 196)

# capture, tag, headline (two lines at most), subtitle
SHOTS = [
    ('s1_emergency', 'АВАРІЙНІ ВІДКЛЮЧЕННЯ', 'Аварія за вашою\nадресою', 'Початок і орієнтовне відновлення\nз даних Полтаваобленерго'),
    ('s2_nearby', 'ПОРУЧ З ВАМИ', 'Ремонти й пошкодження\nпоруч', 'Чи є ваш будинок у реєстрі\nвідключень на вашій вулиці'),
    ('s3_drum', 'ГРАФІК НА 24 ГОДИНИ', 'Коли світло буде,\nа коли ні', 'Шкала дня, таймер до відключення\nі всі години без світла для 12 черг'),
    ('s7_warning', 'ПОПЕРЕДЖЕННЯ', 'Сповіщення\nзаздалегідь', 'За 15 хвилин до планового відключення\nі одразу про аварію'),
    ('s5_settings', 'КІЛЬКА АДРЕС', 'Дім, батьки, робота', 'До п’яти адрес, окремі сповіщення\nдля кожної'),
    ('s6_widgets', 'ВІДЖЕТИ', 'Усе видно\nз головного екрана', 'Таймер і шкала дня у віджетах\nбез відкриття застосунку'),
]


def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(os.path.join(FONTS, name), size)


def background(w: int, h: int, glow_at=(0.5, 0.62), glow_r=0.75) -> Image.Image:
    """Dark base with a maroon-to-ember radial glow, like the logo."""
    img = Image.new('RGB', (w, h), BG)
    glow = Image.new('L', (w, h), 0)
    d = ImageDraw.Draw(glow)
    cx, cy, r = w * glow_at[0], h * glow_at[1], max(w, h) * glow_r / 2
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)
    glow = glow.filter(ImageFilter.GaussianBlur(max(w, h) * 0.12))
    img.paste(Image.new('RGB', (w, h), (92, 10, 24)), (0, 0), glow.point(lambda v: int(v * 0.85)))
    top = Image.new('L', (w, h), 0)
    ImageDraw.Draw(top).ellipse([w * 0.15, -h * 0.25, w * 0.85, h * 0.2], fill=255)
    top = top.filter(ImageFilter.GaussianBlur(w * 0.1))
    img.paste(Image.new('RGB', (w, h), (120, 40, 20)), (0, 0), top.point(lambda v: int(v * 0.35)))
    return img


def pill(d: ImageDraw.ImageDraw, cx: int, y: int, text: str, f: ImageFont.FreeTypeFont) -> int:
    tw = d.textlength(text, font=f)
    pad_x, h = 30, f.size + 26
    box = [cx - tw / 2 - pad_x, y, cx + tw / 2 + pad_x, y + h]
    d.rounded_rectangle(box, radius=h / 2, fill=(70, 18, 20), outline=(150, 52, 34), width=2)
    d.text((cx, y + h / 2), text, font=f, fill=(255, 150, 112), anchor='mm')
    return y + h


def centered(d, cx, y, text, f, fill, spacing):
    for line in text.split('\n'):
        d.text((cx, y), line, font=f, fill=fill, anchor='ma')
        y += f.size + spacing
    return y


def cut_frame(raw: Image.Image) -> Image.Image:
    """The capture is a rectangle: keep only the phone frame (rounded 52 of 416 px in the simulator)."""
    w, h = raw.size
    k = 4
    mask = Image.new('L', (w * k, h * k), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, w * k - 1, h * k - 1], radius=round(w * k * 52 / 416), fill=255)
    out = raw.copy()
    out.putalpha(mask.resize((w, h), Image.LANCZOS))
    return out


def phone_shot(raw: Image.Image, tag: str, title: str, sub: str) -> Image.Image:
    W, H = 1080, 1920
    img = background(W, H)
    d = ImageDraw.Draw(img)
    y = pill(d, W // 2, 70, tag, font('segoeuib.ttf', 28))
    y = centered(d, W // 2, y + 34, title, font('segoeuib.ttf', 74), TEXT, 10)
    y = centered(d, W // 2, y + 18, sub, font('segoeui.ttf', 36), SUB, 10)
    # the phone, bleeding off the bottom edge so its content stays large
    pw = 800
    ph = round(raw.height * pw / raw.width)
    phone = raw.resize((pw, ph), Image.LANCZOS)
    top = y + 44
    shadow = Image.new('L', (W, H), 0)
    ImageDraw.Draw(shadow).rounded_rectangle([(W - pw) / 2 + 10, top + 30, (W + pw) / 2 - 10, top + ph], radius=90, fill=200)
    img.paste((0, 0, 0), (0, 0), shadow.filter(ImageFilter.GaussianBlur(40)))
    img.paste(phone, ((W - pw) // 2, top), phone)
    return img


def logo_square() -> Image.Image:
    """The gold rounded square of the logo with the black around it made transparent (as build_app_icons.py)."""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import build_app_icons
    build_app_icons.SRC = os.path.join(ROOT, 'public', 'logo.png')
    return build_app_icons.transparent_logo()


def icon_512(logo: Image.Image) -> Image.Image:
    size = 512
    img = Image.new('RGBA', (size, size), MAROON + (255,))
    inner = round(size * 0.92)  # gold square about 86 % of the side: inside Play's 20 % corner mask
    img.alpha_composite(logo.resize((inner, inner), Image.LANCZOS), ((size - inner) // 2, (size - inner) // 2))
    return img.convert('RGB')


def feature_graphic(logo: Image.Image, phone: Image.Image) -> Image.Image:
    W, H = 1024, 500
    img = background(W, H, glow_at=(0.3, 0.5), glow_r=1.1)
    d = ImageDraw.Draw(img)
    ls = 210
    rgba = img.convert('RGBA')
    rgba.alpha_composite(logo.resize((ls, ls), Image.LANCZOS), (56, (H - ls) // 2 - 50))
    img = rgba.convert('RGB')
    d = ImageDraw.Draw(img)
    x = 56
    d.text((x + ls + 34, 150), 'Світло', font=font('segoeuib.ttf', 66), fill=TEXT)
    d.text((x + ls + 34, 222), 'в Полтаві', font=font('segoeuib.ttf', 66), fill=GOLD)
    d.text((x, 362), 'Графік погодинних відключень,', font=font('segoeui.ttf', 30), fill=SUB)
    d.text((x, 402), 'аварії поруч і попередження заздалегідь', font=font('segoeui.ttf', 30), fill=SUB)
    # the top of the phone with the drum, on the right
    pw = 330
    p = phone.resize((pw, round(phone.height * pw / phone.width)), Image.LANCZOS)
    img.paste(p, (W - pw - 40, 40), p)
    return img


def main() -> None:
    os.makedirs(PUBLIC, exist_ok=True)
    for i, (name, tag, title, sub) in enumerate(SHOTS, 1):
        raw = cut_frame(Image.open(os.path.join(RAW, name + '.png')).convert('RGBA'))
        out = phone_shot(raw, tag, title, sub)
        path = os.path.join(OUT, f'phone_{i}.png')
        out.save(path, optimize=True)
        shutil.copyfile(path, os.path.join(PUBLIC, f'playstore_promo_{i}.png'))
        print(os.path.relpath(path, ROOT), out.size)
    logo = logo_square()
    icon_512(logo).save(os.path.join(OUT, 'icon_512.png'), optimize=True)
    fg = feature_graphic(logo, cut_frame(Image.open(os.path.join(RAW, 's3_drum.png')).convert('RGBA')))
    fg.save(os.path.join(OUT, 'feature_graphic.png'), optimize=True)
    print('docs/store/icon_512.png (512, 512)')
    print('docs/store/feature_graphic.png', fg.size)


if __name__ == '__main__':
    main()
