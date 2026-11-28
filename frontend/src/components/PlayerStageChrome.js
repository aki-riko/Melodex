import { Moon, Sun } from 'lucide-react';
import { STAGE_TONE_LABELS, stageToneActionLabel } from '../contexts/playerStage.mjs';

// 全屏播放页顶部的可切换控件:
//   · StageToneToggle —— 沉浸暗场 / 跟随主题 两档
//
// ★ 布局切换(沉浸 / 歌词 / 封面 三档)已于 2026-11 整体移除:
//   用户圈出顶栏那两颗「歌词」「封面」并明确要求移除,选择的是「播放页只留沉浸一档」。
//   所以这里不再有 StageLayoutSwitch —— 播放页恒定是沉浸档,
//   顶栏左侧只剩「收起」,右侧只剩这一颗色板按钮。
//
// 为什么拆成独立组件而不是写在 PlayerContext 里:那里已经两千多行,
// 而这个控件是纯展示(只吃 tone + onToggle),拆出来之后
// 可访问性(aria-pressed)、文字标签的取舍都只有一份,不会走样。

export const StageToneToggle = ({ tone, onToggle, className = '' }) => {
  const immersive = tone === 'immersive';
  const action = stageToneActionLabel(tone);
  return (
    <button
      type="button"
      onClick={onToggle}
      title={action}
      aria-label={action}
      aria-pressed={immersive}
      className={`player-stage-tone ${className}`}
    >
      {immersive
        ? <Sun size={18} aria-hidden="true" />
        : <Moon size={18} aria-hidden="true" />}
      <span>{STAGE_TONE_LABELS[tone]}</span>
    </button>
  );
};

export default StageToneToggle;
