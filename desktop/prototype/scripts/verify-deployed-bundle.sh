#!/bin/sh
# 验证线上部署的前端产物里包含「桌面歌词按钮」的新逻辑。
# 判断依据：新代码里有 "隐藏桌面歌词"（旧代码只有 "桌面歌词（桌面客户端内自动同步，无需配对）"）。
JS=$(docker exec melodex wget -qO- http://127.0.0.1:8329/ \
     | sed -n 's/.*\(assets\/index-[A-Za-z0-9_-]*\.js\).*/\1/p' | head -1)
echo "JS_FILE=$JS"
echo -n "NEW_TEXT_COUNT="
docker exec melodex wget -qO- "http://127.0.0.1:8329/$JS" | grep -c "隐藏桌面歌词"
echo -n "OLD_TEXT_COUNT="
docker exec melodex wget -qO- "http://127.0.0.1:8329/$JS" | grep -c "无需配对"
echo -n "ARIA_PRESSED_COUNT="
docker exec melodex wget -qO- "http://127.0.0.1:8329/$JS" | grep -c "aria-pressed"
