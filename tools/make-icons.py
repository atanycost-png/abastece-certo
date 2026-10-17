#!/usr/bin/env python3
"""Gera os ícones PNG do Abastece Certo (PWA) — ferramenta de desenvolvimento.

Não faz parte do app: o app é estático e não executa Python. Rode apenas quando
quiser mudar a arte do ícone:

    python tools/make_icons.py

Saída em icons/: icon-192.png, icon-512.png, maskable-512.png, apple-touch-icon.png
Requisitos: Pillow + numpy (já disponíveis no runtime do harness).
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "icons"
OUT.mkdir(exist_ok=True)

BLUE = (59, 130, 246)    # #3b82f6
GREEN = (34, 197, 94)    # #22c55e
SS = 4                   # supersampling


def gradient(size: int) -> Image.Image:
    """Diagonal azul -> verde com leve brilho no topo-esquerdo."""
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    denom = max(size - 1, 1)
    t = (x + y) / (2.0 * denom)
    t = t * t * (3.0 - 2.0 * t)  # smoothstep

    r = BLUE[0] + (GREEN[0] - BLUE[0]) * t
    g = BLUE[1] + (GREEN[1] - BLUE[1]) * t
    b = BLUE[2] + (GREEN[2] - BLUE[2]) * t

    # brilho radial suave no canto superior esquerdo
    cx, cy = size * 0.25, size * 0.18
    dist = np.sqrt((x - cx) ** 2 + (y - cy) ** 2) / size
    glow = np.clip(1.0 - dist * 2.4, 0.0, 1.0) ** 2 * 0.22

    rgb = np.dstack([r, g, b])
    rgb = np.clip(rgb + glow[..., None] * 255.0, 0, 255).astype(np.uint8)
    return Image.fromarray(rgb, "RGB")


def droplet_mask(size: int, scale: float = 1.0) -> Image.Image:
    """Máscara da gota: círculo + triângulo cujos lados são tangentes ao círculo.

    Usar os pontos de tangência exatos (em vez de um triângulo aproximado) é o
    que evita o "degrau" visível na junção entre o bico e a parte redonda.
    """
    s = size * SS
    mask = Image.new("L", (s, s), 0)
    draw = ImageDraw.Draw(mask)

    cx, cy = s * 0.5, s * 0.575
    r = s * 0.145 * scale
    h = s * 0.30 * scale            # distância do ápice até o centro do círculo
    h = max(h, r * 1.02)            # evita tangente degenerada

    ty = -(r * r) / h               # y do ponto de tangência (relativo ao centro)
    tx = r * np.sqrt(max(0.0, 1.0 - (r * r) / (h * h)))

    draw.polygon([(cx, cy - h), (cx - tx, cy + ty), (cx + tx, cy + ty)], fill=255)
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)

    return mask.resize((size, size), Image.LANCZOS)


def build(size: int, scale: float = 1.0, shadow: bool = True) -> Image.Image:
    ss = size * SS
    base = gradient(ss)

    mask = droplet_mask(size, scale).resize((ss, ss), Image.LANCZOS)

    if shadow:
        shadow_mask = Image.new("L", (ss, ss), 0)
        off = int(ss * 0.012)
        shadow_mask.paste(mask, (off, off))
        shadow_mask = shadow_mask.filter(ImageFilter.GaussianBlur(ss * 0.012))
        shadow_layer = Image.new("RGB", (ss, ss), (6, 16, 32))
        base = Image.composite(shadow_layer, base, shadow_mask.point(lambda p: int(p * 0.45)))

    white = Image.new("RGB", (ss, ss), (255, 255, 255))
    base = Image.composite(white, base, mask)

    return base.resize((size, size), Image.LANCZOS)


def main() -> None:
    targets = [
        ("icon-192.png", 192, 1.0),
        ("icon-512.png", 512, 1.0),
        ("maskable-512.png", 512, 0.82),   # conteúdo menor: cabe na zona segura
        ("apple-touch-icon.png", 180, 1.0),
    ]
    for name, size, scale in targets:
        img = build(size, scale)
        path = OUT / name
        img.save(path, "PNG", optimize=True)
        print(f"  {name:24s} {img.size[0]}x{img.size[1]}  {path.stat().st_size / 1024:.1f} KB")


if __name__ == "__main__":
    main()
