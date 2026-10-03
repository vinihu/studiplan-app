"""
Builds the Windows icon from the logo.

    python scripts/make-icon.py            writes build/icon.ico
    python scripts/make-icon.py --preview  also writes artifacts/icon-preview.png, the icon at
                                           16, 32, 48 and 256 px on a light and a dark background

Needs Pillow (`pip install pillow`). The result is committed, so this only has to be run again
when resources/logo.png changes.

The logo's source is the vector file resources/logo.svg; resources/logo.png is that file rendered
at 1024 px on a transparent background, and is what this script reads. The book's own white (the
ring inside the outline, the right-hand page) is part of the drawing and stays white; everything
around the book is transparent. That way the book reads on a light background by its black
outline and on a dark taskbar by its white pages.

build/ is electron-builder's resources folder: build/icon.ico becomes the icon of the app's
executable (and so of its window, taskbar button and shortcuts), the installer and the
uninstaller.
"""

import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "resources" / "logo.png"
# Below about 40 px the logo's double outline is too fine to draw cleanly, so the small frames
# use resources/logo-small.svg (rendered to logo-small.png): the same logo with a heavier ring
# and edge.
SMALL_SOURCE = ROOT / "resources" / "logo-small.png"
SMALL_UP_TO = 48
ICON = ROOT / "build" / "icon.ico"
PREVIEW = ROOT / "artifacts" / "icon-preview.png"

# The sizes Windows asks for: title bar and lists (16-24), taskbar (24-48 with display scaling),
# Start menu and large views (64-256).
SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
# How much of the canvas the logo fills: all of it, edge to edge across its width.
FILL = 1.0


def square(image: Image.Image) -> Image.Image:
    """The book cropped to its bounds and centred on a transparent square."""
    box = image.getchannel("A").getbbox()
    book = image.crop(box)
    side = round(max(book.size) / FILL)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(book, ((side - book.width) // 2, (side - book.height) // 2))
    return canvas


def at_size(master: Image.Image, size: int) -> Image.Image:
    # Premultiplied resampling, so transparent pixels do not bleed their colour into the edge.
    premultiplied = master.convert("RGBa").resize((size, size), Image.LANCZOS)
    return premultiplied.convert("RGBA")


def preview(frames: dict[int, Image.Image]) -> None:
    shown = [16, 32, 48, 256]
    pad = 24
    width = pad + sum(size + pad for size in shown)
    height = 256 + 2 * pad
    sheet = Image.new("RGB", (width, height * 2))
    # A light window surface and the dark Windows 11 taskbar.
    for row, background in enumerate([(243, 243, 243), (32, 32, 32)]):
        band = Image.new("RGBA", (width, height), background + (255,))
        x = pad
        for size in shown:
            band.alpha_composite(frames[size], (x, pad + 256 - size))
            x += size + pad
        sheet.paste(band.convert("RGB"), (0, row * height))
    PREVIEW.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(PREVIEW)
    print(f"wrote {PREVIEW.relative_to(ROOT)}")


def main() -> None:
    master = square(Image.open(SOURCE).convert("RGBA"))
    small = square(Image.open(SMALL_SOURCE).convert("RGBA"))
    frames = {size: at_size(small if size <= SMALL_UP_TO else master, size) for size in SIZES}
    ICON.parent.mkdir(parents=True, exist_ok=True)
    # Pillow writes each frame as given when they are passed explicitly, largest first.
    largest = frames[max(SIZES)]
    largest.save(
        ICON,
        format="ICO",
        sizes=[(size, size) for size in SIZES],
        append_images=[frames[size] for size in SIZES if size != max(SIZES)],
    )
    print(f"wrote {ICON.relative_to(ROOT)} ({', '.join(str(size) for size in SIZES)} px)")
    if "--preview" in sys.argv:
        preview(frames)


if __name__ == "__main__":
    main()
