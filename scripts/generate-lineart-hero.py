#!/usr/bin/env python3
"""一次性脚本：程序化生成「极细平行线丝带 + 紫色辉光」抽象 16:9 背景图。

不依赖任何外部图源或网络，全部由贝塞尔曲线族绘制，成图为原创内容。
默认输出 1600x900（与 themes/<name>/hero.webp 规范一致）。

用法:
    python scripts/generate-lineart-hero.py --variant 1 --out hero.webp
    python scripts/generate-lineart-hero.py --variant 2 --out hero.png --png
"""

from __future__ import annotations

import argparse
import math
import random

from PIL import Image, ImageChops, ImageDraw, ImageFilter

# ---------------------------------------------------------------- 基础数学工具


def clamp(v: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return lo if v < lo else hi if v > hi else v


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def mix_rgb(c1, c2, t: float):
    return tuple(int(round(lerp(c1[i], c2[i], t))) for i in range(3))


def smoothstep(x: float) -> float:
    x = clamp(x)
    return x * x * (3.0 - 2.0 * x)


def bezier(p, t: float):
    p0, p1, p2, p3 = p
    mt = 1.0 - t
    a, b, c, d = mt * mt * mt, 3 * mt * mt * t, 3 * mt * t * t, t * t * t
    return (a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
            a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1])


def bezier_tangent(p, t: float):
    p0, p1, p2, p3 = p
    mt = 1.0 - t
    a, b, c = 3 * mt * mt, 6 * mt * t, 3 * t * t
    return (a * (p1[0] - p0[0]) + b * (p2[0] - p1[0]) + c * (p3[0] - p2[0]),
            a * (p1[1] - p0[1]) + b * (p2[1] - p1[1]) + c * (p3[1] - p2[1]))


# ---------------------------------------------------------------- 画面构成参数

# 归一化坐标（可超出 0..1，让丝带自然延伸出画布）
# width 为丝带半宽（相对画面宽度），pinch_t 为束腰位置，pinch 为束腰处最小宽度系数
LAYOUT = [
    {   # A：左下 -> 右上 的长弧，在中偏右上收束并起辉光
        "ctrl": [(-0.55, 1.18), (0.12, 0.76), (0.86, 0.06), (1.55, -0.28)],
        "width": 0.36, "pinch_t": 0.52, "pinch": 0.18, "span": 0.60, "pow": 1.00,
        "lines": 180, "purple": 1.00,
    },
    {   # B：左上 -> 右侧，与 A 在左上交叠
        "ctrl": [(-0.55, 0.02), (0.04, 0.46), (0.62, -0.22), (1.55, 0.58)],
        "width": 0.32, "pinch_t": 0.44, "pinch": 0.16, "span": 0.58, "pow": 1.00,
        "lines": 165, "purple": 0.95,
    },
    {   # C：底部大扇面
        "ctrl": [(-0.55, 1.50), (0.24, 1.02), (0.56, 1.62), (1.55, 1.02)],
        "width": 0.38, "pinch_t": 0.50, "pinch": 0.18, "span": 0.58, "pow": 1.00,
        "lines": 175, "purple": 0.85,
    },
    {   # D：右侧竖向扭转
        "ctrl": [(1.50, -0.48), (0.94, 0.26), (1.55, 0.66), (0.94, 1.48)],
        "width": 0.32, "pinch_t": 0.50, "pinch": 0.17, "span": 0.58, "pow": 1.00,
        "lines": 155, "purple": 0.80,
    },
    {   # E：左中横穿的小束
        "ctrl": [(-0.62, 0.72), (0.16, 0.58), (0.16, 0.98), (0.86, 1.06)],
        "width": 0.24, "pinch_t": 0.48, "pinch": 0.20, "span": 0.55, "pow": 1.05,
        "lines": 120, "purple": 0.70,
    },
    {   # F：中央穿透的小束，制造第三个交汇点
        "ctrl": [(-0.34, 0.28), (0.46, 0.56), (0.54, 0.08), (1.24, 0.34)],
        "width": 0.20, "pinch_t": 0.50, "pinch": 0.20, "span": 0.55, "pow": 1.05,
        "lines": 105, "purple": 0.75,
    },
]

BG = (17, 17, 19)             # 近黑底色
BASE_LINE = (203, 199, 214)   # 线条基色：淡灰紫
ACCENT = (146, 88, 240)       # 强调色：紫罗兰


def jitter_layout(rng: random.Random, strength: float = 0.05):
    """对控制点做小幅随机扰动，让不同 variant 有差异但保持构图。"""
    out = []
    for cfg in LAYOUT:
        c = dict(cfg)
        c["ctrl"] = [(x + rng.uniform(-strength, strength),
                      y + rng.uniform(-strength, strength)) for x, y in cfg["ctrl"]]
        c["pinch_t"] = clamp(cfg["pinch_t"] + rng.uniform(-0.08, 0.08), 0.2, 0.8)
        c["lines"] = int(cfg["lines"] * rng.uniform(0.9, 1.12))
        out.append(c)
    return out


def build_background(w: int, h: int) -> Image.Image:
    """近黑底 + 极淡的径向层次，避免大面积死黑。"""
    bg = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(bg)
    cx, cy = 0.42 * w, 0.40 * h
    steps = 90
    r_max = 0.95 * math.hypot(w, h) / 2
    for i in range(steps, 0, -1):
        t = i / steps
        r = r_max * t
        lift = (1.0 - t) ** 2.0
        col = mix_rgb(BG, (34, 30, 46), lift * 0.55)
        d.ellipse([cx - r, cy - r * 0.68, cx + r, cy + r * 0.68], fill=col)
    return bg.filter(ImageFilter.GaussianBlur(radius=w * 0.012))


def draw_ribbon(main_d, glow_d, cfg, scale_x, scale_y, steps: int):
    """绘制一条丝带：一族沿同一贝塞尔曲线、按法线方向偏移的平行细线。"""
    ctrl = [(x * scale_x, y * scale_y) for x, y in cfg["ctrl"]]
    n = cfg["lines"]
    half_w = cfg["width"] * scale_x
    glow_span = 0.30

    for i in range(n):
        s = (i / (n - 1)) * 2.0 - 1.0                     # 横向位置 -1..1
        pts = []
        for j in range(steps + 1):
            t = j / steps
            cx, cy = bezier(ctrl, t)
            tx, ty = bezier_tangent(ctrl, t)
            ln = math.hypot(tx, ty) or 1.0
            nx, ny = -ty / ln, tx / ln
            u = clamp(abs(t - cfg["pinch_t"]) / cfg["span"])
            # 端部收尖：避免丝带终止边在画布内形成一条硬直边
            taper = smoothstep(t / 0.09) * smoothstep((1.0 - t) / 0.09)
            width = half_w * (cfg["pinch"] + (1.0 - cfg["pinch"]) * (u ** cfg["pow"])) * taper
            pts.append((cx + nx * s * width, cy + ny * s * width))

        seg = 4
        for j in range(0, steps, seg):
            t = (j + seg * 0.5) / steps
            waist = smoothstep(1.0 - clamp(abs(t - cfg["pinch_t"]) / glow_span)) ** 1.3
            inner = (1.0 - abs(s)) ** 1.4
            purple = clamp(cfg["purple"] * waist * (0.22 + 0.78 * inner))
            chunk = pts[j:j + seg + 1]
            main_d.line(chunk, fill=mix_rgb(BASE_LINE, ACCENT, purple),
                        width=1, joint="curve")
            if purple > 0.28:
                g = (purple - 0.28) / 0.72
                glow_d.line(chunk, fill=mix_rgb((0, 0, 0), ACCENT, g),
                            width=2, joint="curve")


def render(width: int, height: int, ss: int, seed: int) -> Image.Image:
    w, h = width * ss, height * ss
    rng = random.Random(seed)

    bg = build_background(w, h)
    main = bg.copy()
    glow = Image.new("RGB", (w, h), (0, 0, 0))

    main_d = ImageDraw.Draw(main)
    glow_d = ImageDraw.Draw(glow)

    steps = 220
    for cfg in jitter_layout(rng):
        draw_ribbon(main_d, glow_d, cfg, w, h, steps)

    del main_d, glow_d

    # 双层辉光：宽晕 + 紧晕，用 screen 混合叠加
    wide = glow.filter(ImageFilter.GaussianBlur(radius=max(2.0, w * 0.020)))
    tight = glow.filter(ImageFilter.GaussianBlur(radius=max(1.0, w * 0.0055))).point(
        lambda v: int(v * 0.85)
    )
    main = ImageChops.screen(main, wide)
    main = ImageChops.screen(main, tight)

    return main.resize((width, height), Image.LANCZOS)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--variant", type=int, default=1)
    ap.add_argument("--out", required=True)
    ap.add_argument("--width", type=int, default=1600)
    ap.add_argument("--height", type=int, default=900)
    ap.add_argument("--ss", type=int, default=3, help="超采样倍率")
    args = ap.parse_args()

    img = render(args.width, args.height, args.ss, 20261007 + args.variant * 977)

    ext = args.out.lower().rsplit(".", 1)[-1]
    if ext == "webp":
        img.save(args.out, quality=92, method=6)
    elif ext in ("jpg", "jpeg"):
        img.save(args.out, quality=92, subsampling=0)
    else:
        img.save(args.out)
    print(f"生成 {args.out}: {img.size[0]}x{img.size[1]}")


if __name__ == "__main__":
    main()
