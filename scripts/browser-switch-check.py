"""Compatibility entry for the current people picker; no real model calls."""
import runpy
import sys
from pathlib import Path
if '--live' in sys.argv:
    raise SystemExit('真实对话请显式运行 browser-people-check.py --live；此入口只做零模型调用的页面检查。')
runpy.run_path(str(Path(__file__).with_name('browser-people-check.py')),run_name='__main__')
