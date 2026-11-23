import argparse
import base64
import io
import json
from pathlib import Path
import subprocess

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
SIZE = (640, 360)
PALETTES = {
    "推荐与排行": ("#6853df", "#a361d6", "#4e68cd", "#905ddd"),
    "传媒与专题": ("#c3537f", "#b76876", "#ba6255", "#a4559e"),
    "地区与主题": ("#2d8eb0", "#2d9d91", "#4178c5", "#557eb4"),
}


def categories():
    source = "import { categories } from './jobs/categories.js'; console.log(JSON.stringify(categories));"
    return json.loads(subprocess.check_output(
        ["node", "--input-type=module", "-e", source], cwd=ROOT, text=True,
    ))


def cover(category, font_path, regular_index, bold_index, index):
    palette = PALETTES[category["group"]]
    accent = palette[index % len(palette)]
    image = Image.new("RGB", SIZE, "#141529")
    glow = Image.radial_gradient("L").point(lambda value: round(max(0, 1 - value / 178) ** 1.45 * 218))
    glow = glow.resize((820, 700), Image.Resampling.BICUBIC)
    image.paste(accent, (95, -222, 915, 478), glow)

    draw = ImageDraw.Draw(image, "RGBA")
    for x, y, opacity in [(499, 60, 33), (472, 83, 51), (444, 106, 75)]:
        draw.rounded_rectangle((x, y, x + 134, y + 148), 30,
                               fill=(215, 229, 255, opacity // 3),
                               outline=(238, 240, 255, opacity), width=2)
    draw.rounded_rectangle((475, 151, 548, 206), 15, fill=(252, 251, 255, 23),
                           outline=(248, 245, 255, 100), width=2)
    draw.polygon([(504, 165), (504, 192), (526, 178)], fill=(255, 255, 255, 188))

    label = ImageFont.truetype(font_path, 20, index=regular_index)
    name = category["name"]
    for font_size in range(53, 30, -1):
        title = ImageFont.truetype(font_path, font_size, index=bold_index)
        if draw.textlength(name, font=title) <= 330:
            break
    draw.text((146, 134), category["group"], font=label, fill="#dad8ed", anchor="lt")
    draw.text((142, 173), name, font=title, fill="#ffffff", anchor="lt")
    return image


def main():
    arguments = argparse.ArgumentParser(description="Render the Emby media-library artwork from the plugin's category list.")
    arguments.add_argument("--font", default="/System/Library/Fonts/Hiragino Sans GB.ttc")
    arguments.add_argument("--regular-index", type=int, default=0)
    arguments.add_argument("--bold-index", type=int, default=2)
    options = arguments.parse_args()
    target = ROOT / "jobs" / "library-covers"
    target.mkdir(exist_ok=True)
    for index, category in enumerate(categories()):
        image = cover(category, options.font, options.regular_index, options.bold_index, index)
        output = io.BytesIO()
        image.save(output, "JPEG", quality=83, optimize=True)
        artwork = base64.b64encode(output.getvalue()).decode("ascii")
        (target / (category["id"] + ".js")).write_text(
            "export default '" + artwork + "'\n",
            encoding="utf8",
        )


if __name__ == "__main__":
    main()
