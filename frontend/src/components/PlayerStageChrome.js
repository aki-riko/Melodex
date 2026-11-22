import React from 'react';
import { AlignLeft, Columns2, Disc3, Moon, Sun } from 'lucide-react';
import {
  STAGE_LAYOUT_LABELS,
  STAGE_LAYOUTS,
  STAGE_TONE_LABELS,
  stageToneActionLabel,
} from '../contexts/playerStage.mjs';

// 全屏播放页顶部的两颗「可切换」控件:
//   · StageLayoutSwitch —— 唱片 / 歌词 / 双栏 三档
//   · StageToneToggle   —— 沉浸暗场 / 跟随主题 两档
//
// 为什么拆成独立组件而不是写在 PlayerContext 里:那里已经两千多行,
// 而这两个控件是纯展示(只吃 value + onChange),拆出来之后
// 可访问性(role=tablist / aria-selected / aria-pressed)、
// 文字标签的取舍都只有一份,不会在两套舞台里各写一套走样。
//
// ⚠ 窄屏只留图标、宽屏才显示文字 —— 由 index.css 的
//   `.player-stage-switch__item span` 媒体查询控制,组件不判断断点
//   (组件一旦按断点渲染,服务端/首帧/旋转屏幕都要重新算一次,反而更脆)。

const LAYOUT_ICONS = { disc: Disc3, lyrics: AlignLeft, split: Columns2 };

export const StageLayoutSwitch = ({ value, onChange, className = '' }) => (
  <div role="tablist" aria-label="播放页布局" className={`player-stage-switch ${className}`}>
    {STAGE_LAYOUTS.map((id) => {
      const Icon = LAYOUT_ICONS[id];
      const active = id === value;
      const label = STAGE_LAYOUT_LABELS[id];
      return (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={active}
          aria-label={`${label}布局`}
          title={`${label}布局`}
          onClick={() => onChange?.(id)}
          className={`player-stage-switch__item ${active ? 'is-active' : ''}`}
        >
          <Icon size={16} aria-hidden="true" />
          <span>{label}</span>
        </button>
      );
    })}
  </div>
);

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
        ? <Sun size={17} aria-hidden="true" />
        : <Moon size={17} aria-hidden="true" />}
      <span>{STAGE_TONE_LABELS[tone]}</span>
    </button>
  );
};

export default StageLayoutSwitch;
