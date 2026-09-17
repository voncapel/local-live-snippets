#!/usr/bin/env python3
"""Génère les icônes PNG de l'extension sans aucune dépendance externe.

Formes simples : carré arrondi bleu + trois "cartes" blanches évoquant
la grille de snippets de la page Nouvel Onglet.

Usage : python3 tools/make_icons.py   (depuis la racine de l'extension)
"""

import os
import struct
import zlib

BG = (37, 99, 235)       # bleu accent
BG_DARK = (29, 78, 216)  # dégradé léger vers le bas
CARD = (255, 255, 255)
CARD_DIM = (206, 224, 255)

SIZES = (16, 48, 128)


def blend(dst, src, alpha):
    """Mélange src sur dst avec un alpha 0..1."""
    return tuple(round(d + (s - d) * alpha) for d, s in zip(dst, src))


def rounded_rect_coverage(x, y, x0, y0, x1, y1, radius):
    """Couverture approximative (0..1) du pixel (x, y) par un rect arrondi.

    Échantillonnage 3x3 : suffisant pour des icônes et évite tout antialiasing
    plus savant.
    """
    hits = 0
    samples = 0
    for sy in (0.17, 0.5, 0.83):
        for sx in (0.17, 0.5, 0.83):
            px, py = x + sx, y + sy
            samples += 1
            if px < x0 or px > x1 or py < y0 or py > y1:
                continue
            # Coins : on teste la distance au centre du cercle du coin.
            cx = None
            if px < x0 + radius:
                cx = x0 + radius
            elif px > x1 - radius:
                cx = x1 - radius
            cy = None
            if py < y0 + radius:
                cy = y0 + radius
            elif py > y1 - radius:
                cy = y1 - radius
            if cx is not None and cy is not None:
                if (px - cx) ** 2 + (py - cy) ** 2 > radius ** 2:
                    continue
            hits += 1
    return hits / samples


def make_icon(size):
    """Retourne une liste de lignes RGBA (bytearray) pour l'icône."""
    s = size / 128.0  # facteur d'échelle depuis le dessin de référence 128px
    outer_radius = max(1.0, 26 * s)

    # Cartes : une large en haut, deux plus petites en bas.
    cards = [
        (22 * s, 24 * s, 106 * s, 62 * s, CARD),
        (22 * s, 72 * s, 60 * s, 104 * s, CARD_DIM),
        (68 * s, 72 * s, 106 * s, 104 * s, CARD),
    ]
    card_radius = max(0.8, 6 * s)

    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            bg_alpha = rounded_rect_coverage(x, y, 0.0, 0.0, float(size), float(size), outer_radius)
            if bg_alpha <= 0.0:
                row += bytes((0, 0, 0, 0))
                continue

            # Fond : dégradé vertical discret.
            t = y / max(1, size - 1)
            color = blend(BG, BG_DARK, t)

            for (cx0, cy0, cx1, cy1, card_color) in cards:
                cover = rounded_rect_coverage(x, y, cx0, cy0, cx1, cy1, card_radius)
                if cover > 0.0:
                    color = blend(color, card_color, cover)

            row += bytes((color[0], color[1], color[2], round(bg_alpha * 255)))
        rows.append(row)
    return rows


def write_png(path, size, rows):
    raw = b"".join(b"\x00" + bytes(row) for row in rows)

    def chunk(tag, data):
        payload = tag + data
        return struct.pack(">I", len(data)) + payload + struct.pack(">I", zlib.crc32(payload) & 0xFFFFFFFF)

    header = struct.pack(">2I5B", size, size, 8, 6, 0, 0, 0)  # RGBA 8 bits
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as fh:
        fh.write(png)


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    icons_dir = os.path.join(root, "icons")
    os.makedirs(icons_dir, exist_ok=True)
    for size in SIZES:
        path = os.path.join(icons_dir, f"icon{size}.png")
        write_png(path, size, make_icon(size))
        print(f"écrit {path} ({os.path.getsize(path)} octets)")


if __name__ == "__main__":
    main()
