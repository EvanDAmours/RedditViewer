#!/usr/bin/env python3
"""Bundle index.html, style.css and app.js into one self-contained quiet-tv.html for use as a local file."""
import pathlib, re
d = pathlib.Path(__file__).parent
import time
stamp = str(int(time.time()))
src = (d / 'index.html').read_text()
src = re.sub(r'href="style\.css(\?v=\d+)?"', f'href="style.css?v={stamp}"', src)
src = re.sub(r'src="app\.js(\?v=\d+)?"', f'src="app.js?v={stamp}"', src)
(d / 'index.html').write_text(src)   # the hosted page always points at the current app.js/style.css
html = src
html = re.sub(r'<link rel="stylesheet" href="style\.css[^"]*">', lambda m: '<style>\n' + (d / 'style.css').read_text() + '</style>', html)
html = re.sub(r'<script src="app\.js[^"]*"></script>', lambda m: '<script>\n' + (d / 'app.js').read_text().replace('</script', '<\\/script') + '</script>', html)
html = re.sub(r'<p class="hint offline">.*?</p>\n', '', html, flags=re.S)  # no download link inside the offline copy
(d / 'quiet-tv.html').write_text(html)
print('wrote quiet-tv.html', len(html), 'bytes')
