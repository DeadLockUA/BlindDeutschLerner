"""Generates the app icons (four coloured quarters + "DE", matching the app's zone colours)."""
from PIL import Image, ImageDraw, ImageFont
import os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for size in (192, 512):
    img = Image.new('RGB', (size, size), '#000000')
    d = ImageDraw.Draw(img)
    g = size // 24
    h = size // 2
    cols = ['#ffd400', '#2f7bff', '#b45cff', '#f2f2f2']
    boxes = [(g, g, h - g // 2, h - g // 2), (h + g // 2, g, size - g, h - g // 2),
             (g, h + g // 2, h - g // 2, size - g), (h + g // 2, h + g // 2, size - g, size - g)]
    for c, b in zip(cols, boxes):
        d.rounded_rectangle(b, radius=size // 14, fill=c)
    font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', size // 3)
    d.ellipse((size * 0.22, size * 0.22, size * 0.78, size * 0.78), fill='#000000')
    d.text((size / 2, size / 2), 'DE', font=font, fill='#ffffff', anchor='mm')
    img.save(os.path.join(ROOT, 'public', 'icons', f'icon-{size}.png'))
