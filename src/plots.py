"""노트북 그림의 공통 모양. 색은 색각 안전성 검사를 통과한 기본 팔레트의 앞 세 칸만 쓴다."""

from __future__ import annotations

import matplotlib as mpl
import matplotlib.pyplot as plt
from matplotlib import font_manager
from matplotlib.colors import LinearSegmentedColormap

BLUE, ORANGE, AQUA = "#2a78d6", "#eb6834", "#1baf7a"  # 계열 1·2·3 (이 순서로만 쓴다)
GRAY = "#898781"  # 기준선·참고용
INK, INK2, GRID, AXIS = "#0b0b0b", "#52514e", "#e1e0d9", "#c3c2b7"
BLUES = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"]  # 크기용 한 색상 단계
BLUE_CMAP = LinearSegmentedColormap.from_list("blues", BLUES)


def set_style() -> str:
    """한글 글꼴과 차분한 축·눈금 모양을 설정하고, 고른 글꼴 이름을 돌려준다."""
    installed = {f.name for f in font_manager.fontManager.ttflist}
    font = next(
        (f for f in ["Apple SD Gothic Neo", "AppleGothic", "Malgun Gothic", "NanumGothic", "Noto Sans CJK KR"] if f in installed),
        "sans-serif",
    )
    mpl.rcParams.update(
        {
            "font.family": font,
            "axes.unicode_minus": False,
            "figure.dpi": 110,
            "savefig.dpi": 160,
            "savefig.bbox": "tight",
            "figure.facecolor": "white",
            "axes.facecolor": "white",
            "axes.edgecolor": AXIS,
            "axes.linewidth": 0.8,
            "axes.spines.top": False,
            "axes.spines.right": False,
            "axes.grid": True,
            "axes.grid.axis": "y",
            "grid.color": GRID,
            "grid.linewidth": 0.8,
            "grid.linestyle": "-",
            "axes.axisbelow": True,
            "axes.titlesize": 11,
            "axes.titleweight": "bold",
            "axes.titlelocation": "left",
            "axes.labelsize": 9.5,
            "axes.labelcolor": INK2,
            "xtick.color": INK2,
            "ytick.color": INK2,
            "xtick.labelsize": 9,
            "ytick.labelsize": 9,
            "xtick.major.size": 3,
            "ytick.major.size": 0,
            "lines.linewidth": 2,
            "lines.solid_capstyle": "round",
            "legend.frameon": False,
            "legend.fontsize": 9,
        }
    )
    return font


def bar_labels(ax, bars, fmt: str = "{:.1f}", horizontal: bool = False) -> None:
    """막대 끝에 값을 적는다(글자는 잉크색)."""
    for bar in bars:
        if horizontal:
            ax.text(bar.get_width(), bar.get_y() + bar.get_height() / 2, " " + fmt.format(bar.get_width()), va="center", ha="left", fontsize=8.5, color=INK)
        else:
            ax.text(bar.get_x() + bar.get_width() / 2, bar.get_height(), fmt.format(bar.get_height()), va="bottom", ha="center", fontsize=8.5, color=INK)


def save(fig, path) -> None:
    fig.savefig(path)
    plt.show()
