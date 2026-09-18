#!/usr/bin/env python3
"""Génère les icônes PNG et SVG de Boardmine.

Utilise le logo officiel Boardmine (bleu #73B6FA, citrus #AEEF3E, cadre #E8E7F1, fond #181140).
Tailles générées : 16, 32, 48, 128 px.

Usage : python3 tools/make_icons.py   (depuis la racine de l'extension)
"""

import os
import subprocess
from PIL import Image

SIZES = (16, 32, 48, 128)
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    icons_dir = os.path.join(root, "icons")
    os.makedirs(icons_dir, exist_ok=True)

    master_svg = os.path.join(icons_dir, "favicon.svg")
    tmp_dir = "/tmp/boardmine_icons"
    os.makedirs(tmp_dir, exist_ok=True)
    tmp_png = os.path.join(tmp_dir, "master.png")
    tmp_html = os.path.join(tmp_dir, "page.html")

    # QuickLook aplatit la transparence sur du blanc (coins arrondis blancs) :
    # on passe par Chrome headless avec un fond transparent.
    with open(tmp_html, "w") as f:
        f.write(
            "<!doctype html><html><head><style>html,body{margin:0;background:transparent}"
            "img{display:block;width:512px;height:512px}</style></head>"
            f'<body><img src="file://{master_svg}"></body></html>'
        )
    subprocess.run(
        [
            CHROME,
            "--headless=new",
            "--disable-gpu",
            "--hide-scrollbars",
            "--default-background-color=00000000",
            "--window-size=512,512",
            f"--screenshot={tmp_png}",
            f"file://{tmp_html}",
        ],
        check=True,
        capture_output=True,
    )

    master_img = Image.open(tmp_png).convert("RGBA")
    if master_img.size != (512, 512):
        master_img = master_img.resize((512, 512), Image.Resampling.LANCZOS)

    for sz in SIZES:
        out_path = os.path.join(icons_dir, f"icon{sz}.png")
        resized = master_img.resize((sz, sz), Image.Resampling.LANCZOS)
        resized.save(out_path, "PNG", optimize=True)
        print(f"Généré {out_path} ({sz}x{sz}, {os.path.getsize(out_path)} octets)")

if __name__ == "__main__":
    main()
