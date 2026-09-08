# NPM (Nginx Proxy Manager) 超时配置

## 问题

Melodex 搜索接口 `/api/v1/search` 需要较长时间（默认后端预算 60 秒 + 网络/验活余量），但 NPM 默认代理超时只有 60 秒，导致：

- **504 Gateway Timeout** 错误
- 后端已返回部分结果但连接被 NPM 提前切断
- 前端显示"歌曲搜索失败 Request failed with status code 504"

## 解决方案

在 NPM 的 `music.9li.life` 站点配置中添加超时设置：

### 步骤

1. 登录 NPM (Nginx Proxy Manager)
2. 编辑 `music.9li.life` Proxy Host
3. 进入 **Advanced** 标签页
4. 在 **Custom Nginx Configuration** 中添加：

```nginx
# 搜索接口需要更长超时（后端 60s 预算 + 验活 + 余量）
location /api/v1/search {
    proxy_read_timeout 120s;
    proxy_connect_timeout 120s;
    proxy_send_timeout 120s;
}

# 歌词接口也需要较长超时
location /api/v1/recognize {
    proxy_read_timeout 120s;
    proxy_connect_timeout 120s;
    proxy_send_timeout 120s;
}

# 其他接口保持默认超时
location / {
    proxy_read_timeout 60s;
    proxy_connect_timeout 60s;
    proxy_send_timeout 60s;
}
```

5. 保存并应用配置

## 配置说明

- **`proxy_read_timeout`**: 等待后端响应的超时时间
- **`proxy_connect_timeout`**: 建立连接的超时时间
- **`proxy_send_timeout`**: 发送请求到后端的超时时间

## 后端超时配置

后端搜索预算可通过环境变量 `MUSIC_DL_SEARCH_SOURCE_BUDGET` 自定义：

```yaml
# docker-compose.yml
services:
  melodex:
    environment:
      # 默认 60s，可调整为 80s 以包含 netease 源（103s）
      - MUSIC_DL_SEARCH_SOURCE_BUDGET=80s
```

## 验证

配置后搜索应该：
- ✅ 不再出现 504 错误
- ✅ 搜索耗时约 60-70 秒（根据关键词和源响应速度）
- ✅ 返回完整结果列表

## 相关日志

后端日志会显示预算使用情况：

```
[search] song "海鸣你": budget 1m0s reached with 6/8 sources; returning partial results
```

这表示在 60 秒内收集了 6 个源的结果，2 个源超时未返回（通常是 qq/netease 等慢源）。
