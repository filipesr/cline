"""Pixel work for the image engine: Instagram-ready JPEGs and review contact sheets.

Runs on the Python that ships with the mflux tool (it already has Pillow), so the
engine needs nothing beyond `uv tool install mflux`. Called by images.ts; not meant
to be used by hand.

  finalize <input> <output.jpg> <width> <height>
  sheet <output.jpg> <title> <columns> <label=path> ...
  verify <file.jpg>
"""

import io
import json
import sys

from PIL import Image, ImageCms, ImageDraw, ImageFont

MAX_BYTES = 8 * 1024 * 1024
SRGB = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB"))
SRGB_BYTES = SRGB.tobytes()


# Pillow's built-in font has no accents; use a system one when available.
FONTS = ("/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Helvetica.ttc", "DejaVuSans.ttf")


def font(size: int):
    for path in FONTS:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            continue
    return ImageFont.load_default(size=size)


def to_srgb(image: Image.Image) -> Image.Image:
    icc = image.info.get("icc_profile")
    image = image.convert("RGB")
    if icc:
        source = ImageCms.ImageCmsProfile(io.BytesIO(icc))
        image = ImageCms.profileToProfile(image, source, SRGB, outputMode="RGB")
    return image


def cover(image: Image.Image, width: int, height: int) -> Image.Image:
    scale = max(width / image.width, height / image.height)
    size = (round(image.width * scale), round(image.height * scale))
    image = image.resize(size, Image.Resampling.LANCZOS)
    x = (image.width - width) // 2
    y = (image.height - height) // 2
    return image.crop((x, y, x + width, y + height))


def save_jpeg(image: Image.Image, output: str) -> int:
    for quality in (92, 88, 84, 80, 75, 70):
        buffer = io.BytesIO()
        image.save(buffer, "JPEG", quality=quality, optimize=True, progressive=True, icc_profile=SRGB_BYTES)
        if buffer.tell() < MAX_BYTES:
            with open(output, "wb") as file:
                file.write(buffer.getvalue())
            return quality
    raise SystemExit(f"{output}: não ficou abaixo de 8 MB nem com qualidade 70")


def finalize(input_path: str, output: str, width: str, height: str) -> None:
    image = cover(to_srgb(Image.open(input_path)), int(width), int(height))
    quality = save_jpeg(image, output)
    print(json.dumps({"quality": quality}))


def sheet(output: str, title: str, columns: str, *items: str) -> None:
    column_count = int(columns)
    thumb_width = 360
    pairs = [item.split("=", 1) for item in items]
    thumbs = []
    for label, path in pairs:
        image = Image.open(path).convert("RGB")
        height = round(image.height * thumb_width / image.width)
        thumbs.append((label, image.resize((thumb_width, height), Image.Resampling.LANCZOS)))
    thumb_height = max(image.height for _, image in thumbs)
    margin, strip, header = 16, 34, 56
    rows = -(-len(thumbs) // column_count)
    sheet_image = Image.new(
        "RGB",
        (margin + column_count * (thumb_width + margin), header + rows * (thumb_height + strip + margin)),
        "white",
    )
    draw = ImageDraw.Draw(sheet_image)
    draw.text((margin, 16), title, fill="black", font=font(22))
    label_font = font(18)
    for index, (label, image) in enumerate(thumbs):
        row, column = divmod(index, column_count)
        x = margin + column * (thumb_width + margin)
        y = header + row * (thumb_height + strip + margin)
        draw.text((x, y + 6), label, fill="black", font=label_font)
        sheet_image.paste(image, (x, y + strip))
    save_jpeg(sheet_image, output)


def verify(path: str) -> None:
    image = Image.open(path)
    icc = image.info.get("icc_profile")
    description = ImageCms.getProfileDescription(ImageCms.ImageCmsProfile(io.BytesIO(icc))).strip() if icc else None
    with open(path, "rb") as file:
        size = len(file.read())
    print(
        json.dumps(
            {"format": image.format, "width": image.width, "height": image.height, "mode": image.mode, "icc": description, "bytes": size}
        )
    )


if __name__ == "__main__":
    commands = {"finalize": finalize, "sheet": sheet, "verify": verify}
    if len(sys.argv) < 2 or sys.argv[1] not in commands:
        raise SystemExit(__doc__)
    commands[sys.argv[1]](*sys.argv[2:])
