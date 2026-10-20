# Draws the app icon: a film strip cut into clips by black frames.
import sys
from PIL import Image, ImageDraw
def draw(n):
    s = 4 * n
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    r = s * 0.2
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=r, fill=(0, 95, 184, 255))
    # film strip
    top, bot = s * 0.26, s * 0.74
    d.rectangle([s * 0.08, top, s * 0.92, bot], fill=(250, 250, 250, 255))
    # sprocket holes
    for i in range(7):
        x = s * (0.13 + i * 0.12)
        for y in (top + s * 0.035, bot - s * 0.075):
            d.rectangle([x, y, x + s * 0.05, y + s * 0.04], fill=(0, 95, 184, 255))
    # frames, separated by black gaps
    fy0, fy1 = top + s * 0.11, bot - s * 0.11
    frames = [(0.11, 0.33, (255, 179, 0)), (0.39, 0.61, (229, 57, 53)), (0.67, 0.89, (67, 160, 71))]
    for x0, x1, c in frames:
        d.rectangle([s * x0, fy0, s * x1, fy1], fill=c + (255,))
    for x in (0.355, 0.635):
        d.rectangle([s * (x - 0.02), top, s * (x + 0.02), bot], fill=(20, 20, 20, 255))
    return im.resize((n, n), Image.LANCZOS)
sizes = [16, 24, 32, 48, 64, 128, 256]
big = draw(256)
big.save(sys.argv[1], sizes=[(z, z) for z in sizes], append_images=[draw(z) for z in sizes[:-1]])
big.save(sys.argv[2])
