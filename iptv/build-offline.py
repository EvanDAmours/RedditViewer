#!/usr/bin/env python3
"""Bundle index.html, style.css and app.js into one self-contained quiet-tv.html for use as a local file."""
import pathlib, re
d = pathlib.Path(__file__).parent
html = (d / 'index.html').read_text()
html = html.replace('<link rel="stylesheet" href="style.css">', '<style>\n' + (d / 'style.css').read_text() + '</style>')
html = html.replace('<script src="app.js"></script>', '<script>\n' + (d / 'app.js').read_text().replace('</script', '<\\/script') + '</script>')
html = re.sub(r'<p class="hint offline">.*?</p>\n', '', html, flags=re.S)  # no download link inside the offline copy
(d / 'quiet-tv.html').write_text(html)
print('wrote quiet-tv.html', len(html), 'bytes')
