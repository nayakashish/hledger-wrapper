"""Generate the iOS launch screens in public/splash/.

iOS only shows an apple-touch-startup-image whose pixel size matches the
screen exactly, so there is one PNG per iPhone screen. The layout is set in
points and scaled by each screen's pixel ratio, so it looks the same on all
of them: the h. icon centred, "nayakashish" small near the bottom.

Usage: python3 scripts/make-splash.py path/to/Montserrat.ttf
Needs Pillow and the Montserrat variable font (github.com/google/fonts,
ofl/montserrat). Prints the <link> tags for index.html.
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ICON = ROOT / "public" / "icon-512.png"
OUT = ROOT / "public" / "splash"

BG, MUTED = "#f7f6f3", "#9b9793"
ICON_PT = 128      # icon size
CREDIT_PT = 13.33  # credit font size
CREDIT_BOTTOM_PT = 87  # credit top edge, measured from the bottom

# Portrait screens: (width pt, height pt, pixel ratio)
SCREENS = [
    (440, 956, 3),  # 16 Pro Max, 17 Pro Max
    (430, 932, 3),  # 14 Pro Max, 15 Plus/Pro Max, 16 Plus
    (428, 926, 3),  # 12/13 Pro Max, 14 Plus
    (420, 912, 3),  # Air
    (414, 896, 3),  # XS Max, 11 Pro Max
    (414, 896, 2),  # XR, 11
    (414, 736, 3),  # 6/7/8 Plus
    (402, 874, 3),  # 16 Pro, 17, 17 Pro
    (393, 852, 3),  # 14 Pro, 15, 15 Pro, 16
    (390, 844, 3),  # 12, 13, 14, 16e
    (375, 812, 3),  # X, XS, 11 Pro, 12/13 mini
    (375, 667, 2),  # 6/7/8, SE 2nd/3rd gen
    (320, 568, 2),  # SE 1st gen
]


def render(font_path, w_pt, h_pt, ratio):
    W, H = w_pt * ratio, h_pt * ratio
    img = Image.new("RGB", (W, H), BG)

    size = round(ICON_PT * ratio)
    icon = Image.open(ICON).convert("RGBA").resize((size, size), Image.LANCZOS)
    img.paste(icon, ((W - size) // 2, (H - size) // 2), icon)

    font = ImageFont.truetype(str(font_path), round(CREDIT_PT * ratio))
    font.set_variation_by_axes([400])
    draw = ImageDraw.Draw(img)
    l, t, r, _ = draw.textbbox((0, 0), "nayakashish", font=font)
    draw.text(((W - (r - l)) // 2 - l, H - round(CREDIT_BOTTOM_PT * ratio) - t),
              "nayakashish", font=font, fill=MUTED)
    return img


def main():
    font_path = Path(sys.argv[1])
    OUT.mkdir(exist_ok=True)
    for w, h, ratio in SCREENS:
        name = f"{w * ratio}x{h * ratio}.png"
        render(font_path, w, h, ratio).save(OUT / name, optimize=True)
        print(f'    <link rel="apple-touch-startup-image" media="(device-width: {w}px) and '
              f'(device-height: {h}px) and (-webkit-device-pixel-ratio: {ratio}) and '
              f'(orientation: portrait)" href="/splash/{name}" />')


if __name__ == "__main__":
    main()
