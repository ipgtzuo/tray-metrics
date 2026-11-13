#!/usr/bin/env python3
"""Generate a multi-resolution TrayMetrics app icon (.ico).

Design: dark rounded tile + glowing cyan activity/heartbeat line.
Renders each target size independently so stroke widths stay crisp.
"""
import math
import os
from PIL import Image, ImageDraw, ImageFilter

OUT = os.path.join(os.path.dirname(__file__), "icon.ico")
SIZES = [16, 24, 32, 48, 64, 128, 256, 512]

# palette
BG_TOP = (24, 30, 41)      # dark navy
BG_BOT = (13, 17, 24)
ACCENT = (45, 212, 191)    # teal/cyan
GLOW = (45, 212, 191)


def rounded_mask(sz, radius):
    mask = Image.new("L", (sz, sz), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, sz - 1, sz - 1], radius=radius, fill=255)
    return mask


def draw_icon(sz):
    img = Image.new("RGBA", (sz, sz), (0, 0, 0, 0))
    pad = sz * 0.14
    inner = sz - 2 * pad
    radius = int(sz * 0.22)

    # --- background gradient on a temp image, then clip to rounded mask ---
    bg = Image.new("RGBA", (sz, sz), (0, 0, 0, 0))
    px = bg.load()
    for y in range(sz):
        t = y / max(1, sz - 1)
        r = int(BG_TOP[0] * (1 - t) + BG_BOT[0] * t)
        g = int(BG_TOP[1] * (1 - t) + BG_BOT[1] * t)
        b = int(BG_TOP[2] * (1 - t) + BG_BOT[2] * t)
        for x in range(sz):
            px[x, y] = (r, g, b, 255)
    mask = rounded_mask(sz, radius)
    bg.putalpha(mask)
    img = Image.alpha_composite(img, bg)

    # --- activity line geometry (heartbeat blip) in inner box ---
    x0, x1 = pad, sz - pad
    base_y = pad + inner * 0.58
    amp = inner * 0.34
    pts = [
        (x0,                      base_y),
        (x0 + inner * 0.30,       base_y),
        (x0 + inner * 0.40,       base_y - amp),
        (x0 + inner * 0.50,       base_y + amp * 0.95),
        (x0 + inner * 0.60,       base_y - amp * 0.55),
        (x0 + inner * 0.70,       base_y),
        (x1,                      base_y),
    ]

    d = ImageDraw.Draw(img)
    lw = max(1.4, sz * 0.030)
    # glow: wider, lower alpha strokes first
    for scale, alpha in [(3.2, 38), (2.1, 70), (1.4, 120)]:
        d.line(pts, fill=(GLOW[0], GLOW[1], GLOW[2], alpha),
               width=max(1, int(lw * scale)), joint="curve")
    # crisp core line
    d.line(pts, fill=(ACCENT[0], ACCENT[1], ACCENT[2], 255),
           width=max(1, int(lw)), joint="curve")
    # peak dot for a bit of life
    peak = pts[2]
    dot_r = max(1.5, sz * 0.022)
    d.ellipse([peak[0] - dot_r, peak[1] - dot_r, peak[0] + dot_r, peak[1] + dot_r],
              fill=(255, 255, 255, 240))

    # subtle outer rim light
    rim = ImageDraw.Draw(img)
    rim.rounded_rectangle([1, 1, sz - 2, sz - 2], radius=radius - 1,
                          outline=(255, 255, 255, 22), width=max(1, int(sz * 0.006)))
    return img


def main():
    frames = {s: draw_icon(s) for s in SIZES}
    # base must be the LARGEST frame; PIL downsamples it to each requested size.
    base = frames[max(SIZES)]
    base.save(OUT, sizes=[(s, s) for s in SIZES])
    print("wrote", OUT)
    for s in SIZES:
        print(f"  {s}x{s}: included")


if __name__ == "__main__":
    main()
