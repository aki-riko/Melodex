"""生成与生产库同量级的基准数据库,用于「我的歌单」加载耗时改前/改后对比。

生产实测(2026-10-25,melodex-postgres):
  saved_songs 433 行,10 个歌单,其中 89 首缺 album 元数据
  歌单规模:163/99/89/43/19/9/5/3
  各歌单缺 album 数:43/15/36/8/0/0/0/0
  search_cache_rows 238 行,合计 9.7MB,单行最大 240KB
  quality_cache_rows 9656 行

这里 1:1 复刻这个形状。歌曲 id 用生产里真实出现过的形状(QQ songmid 14 位、netease 数字、kugou 32 位 hex)。
"""
import hashlib
import json
import os
import random
import sqlite3
import sys

DB = sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\Kotori\AppData\Local\Temp\melobench\data\settings.db"
if not os.path.exists(DB):
    sys.exit("先启动一次 melodex --desktop 让应用建好 schema 与本地用户,再灌数据")
os.makedirs(os.path.dirname(DB), exist_ok=True)

random.seed(20261025)

# (saved_id, 歌曲数, 缺 album 数) —— 取自生产 top_collection 与缺 album 统计
COLLECTION_SHAPE = [
    (10, 163, 43),
    (8, 99, 15),
    (9, 89, 36),
    (7, 43, 8),
    (11, 19, 0),
    (13, 9, 0),
    (6, 5, 0),
    (5, 3, 0),
]

SOURCES = ["qq", "netease", "kugou", "kuwo", "migu"]

NAMES = [
    "スパークル (movie ver.)", "triangle", "irony", "Forget-me-not", "月下で懐かしさ",
    "紅蓮華", "明日、晴れるかな", "Blue Symphony", "まなざし", "瑠璃色の地球",
    "晴天", "稻香", "夜曲", "江南", "孤勇者", "光年之外", "演员", "起风了",
    "Lemon", "打上花火", "前前前世", "なんでもないや", "糸", "手紙 ～拝啓 十五の君へ～",
]
ARTISTS = [
    "RADWIMPS", "宇多田ヒカル", "米津玄師", "周杰伦", "林俊杰", "陈奕迅", "邓紫棋",
    "Aimer", "LiSA", "BUMP OF CHICKEN", "中島みゆき", "コブクロ", "YOASOBI",
]


def make_qq_id():
    alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    return "".join(random.choice(alphabet) for _ in range(14))


def make_kugou_id():
    return "".join(random.choice("0123456789ABCDEF") for _ in range(32))


def make_song(i, source):
    if source == "qq":
        sid = make_qq_id()
    elif source == "kugou":
        sid = make_kugou_id()
    else:
        sid = str(random.randint(100000, 999999999))
    name = NAMES[i % len(NAMES)]
    artist = ARTISTS[i % len(ARTISTS)]
    return sid, name, artist


conn = sqlite3.connect(DB)
cur = conn.cursor()

# 桌面模式启动后 ensureDesktopUser 会建用户 local(id 通常为 1)。歌单必须归属该用户,
# 否则 loadOwnedCollection 按 user_id 过滤会 404 —— 这是真机踩到的第一个坑。
cur.execute("SELECT id FROM users WHERE username = 'local'")
row = cur.fetchone()
if not row:
    sys.exit("找不到桌面用户 local:先跑一次 bench 的预热请求(bootstrap)再灌数据")
OWNER_ID = row[0]
print("owner user_id =", OWNER_ID)

# 清空应用自建的空歌单/收藏歌单,换成生产同形数据
cur.execute("DELETE FROM saved_songs")
cur.execute("DELETE FROM collections")
cur.execute("DELETE FROM search_cache_rows")
cur.execute("DELETE FROM quality_cache_rows")

# 1 个收藏歌单(保证桌面态 ensureFavoriteCollection 的探测有落点)+ 生产同形的 8 个手工歌单
cur.execute(
    "INSERT INTO collections (id,user_id,track_count,name,kind,content_type,source) VALUES (1,?,0,'我喜欢','favorite','playlist','local')",
    (OWNER_ID,),
)
names = ["动漫 OST", "日语流行", "华语经典", "通勤循环", "深夜", "测试歌单", "钢琴", "EP"]
for idx, (cid, count, _) in enumerate(COLLECTION_SHAPE):
    cur.execute(
        "INSERT INTO collections (id,user_id,track_count,name,kind,content_type,source) VALUES (?,?,?,?, 'manual','playlist','local')",
        (cid, OWNER_ID, count, names[idx % len(names)]),
    )

# 2 首歌:announced 缺 album 的数量与生产一致
total_songs = 0
all_songs = []  # (song_id, source) 用于建 quality cache
for cid, count, missing in COLLECTION_SHAPE:
    missing_idx = set(random.sample(range(count), missing))
    for i in range(count):
        source = SOURCES[(cid + i) % len(SOURCES)]
        sid, name, artist = make_song(cid * 7 + i, source)
        if i in missing_idx:
            # 生产里缺 album 的 extra 真实形状:只有 _rank/song_id/songmid 之类,没有 album 键
            extra = {
                "_rank": str(i % 10),
                "song_id": str(random.randint(100000, 999999999)),
                "songmid": sid if source == "qq" else sid,
                "has_lossless": "1" if i % 3 == 0 else "0",
            }
        else:
            extra = {
                "_rank": str(i % 10),
                "song_id": str(random.randint(100000, 999999999)),
                "songmid": sid,
                "album": f"专辑 {artist} {i}",
                "album_id": str(random.randint(1000, 999999)),
                "has_lossless": "1" if i % 3 == 0 else "0",
            }
        cur.execute(
            "INSERT INTO saved_songs (collection_id,duration,song_id,source,name,artist,cover,extra) VALUES (?,?,?,?,?,?,?,?)",
            (
                cid,
                210 + (i % 60),
                sid,
                source,
                name,
                artist,
                "https://y.gtimg.cn/music/photo_new/T002R300x300M000%04d.jpg" % (i % 9999),
                json.dumps(extra, ensure_ascii=False),
            ),
        )
        total_songs += 1
        all_songs.append((sid, source))

# 3 search_cache:238 行 / 合计 ~9.7MB / 单行最大 240KB。
# 关键:payload 里要含 "id":"<真实 song_id>" 形式,才会被 LIKE 命中逻辑扫到。
# 但为了复现生产"缺 album 的歌在缓存里 0 命中"的事实,这里只让**已有 album 的歌**出现在缓存里。
songs_with_album = []
cur.execute("SELECT song_id, source, extra FROM saved_songs")
for sid, source, extra in cur.fetchall():
    if extra and '"album"' in extra:
        songs_with_album.append((sid, source))

CACHE_ROWS = 238
TOTAL_BYTES = 9_700_000
BIG_ROW = 240_000
# 1 行 240KB 的巨行 + 其余均分(生产单行最大 240KB,合计 9.7MB)
sizes = [BIG_ROW] + [(TOTAL_BYTES - BIG_ROW) // (CACHE_ROWS - 1)] * (CACHE_ROWS - 1)
random.shuffle(sizes)
for k in range(CACHE_ROWS):
    songs = []
    # 每行放 1~3 首"有 album 的歌",让 LIKE 有真实命中面
    for _ in range(random.randint(1, 3)):
        if not songs_with_album:
            break
        sid, source = random.choice(songs_with_album)
        songs.append(
            {
                "id": sid,
                "source": source,
                "name": random.choice(NAMES),
                "artist": random.choice(ARTISTS),
                "album": f"专辑 {source} {k}",
                "album_id": str(random.randint(1000, 999999)),
                "cover": "https://p1.music.126.net/%d.jpg" % k,
                "duration": 200,
                "extra": {"has_lossless": "1"},
            }
        )
    payload = json.dumps(
        {"songs": songs, "type": "song", "keyword": f"kw-{k}", "sources": SOURCES, "padding": "x" * max(0, sizes[k])},
        ensure_ascii=False,
    )
    cur.execute(
        "INSERT INTO search_cache_rows (key,payload,created_at) VALUES (?,?,datetime('now'))",
        ("cachekey%04d" % k, payload),
    )

# 4 quality_cache:覆盖歌单里的所有歌,key 必须与 Go 侧 qualityCacheKey 逐字节一致。
# 否则 getCachedQuality 全部 miss → warmQualityCache 在后台对每首歌打上游并写 SQLite,
# 写锁与请求路径的读竞争,把基准测成"后台回填的抖动"而不是被测的 LIKE 扫描。
# Go 侧 key = sha1(join([lower(source), id, extraHash, credentialHash, probeVersion], "\x00"))
#   extraHash = sha1({k1:v1,k2:v2,...} 按 key 排序、JSON 序列化后拼接);空 extra → ""
#   credentialHash = 无 cookie 时 ""(基准库没灌 cookie)
#   probeVersion = qq/qq_wx → "qq-vkey-ag1-refreshkey",其余 ""
# Go 的 json.Marshal 不转义非 ASCII(中文当 UTF-8 原样),但会转义 < > &;
# Python 侧用 ensure_ascii=False + 紧凑分隔符 + 手动处理 < > & 才能逐字节对齐。

PROBE_VERSION = {"qq": "qq-vkey-ag1-refreshkey", "qq_wx": "qq-vkey-ag1-refreshkey"}


def go_json_string(text):
    """模拟 Go encoding/json 的字符串序列化(不转义非 ASCII,转义 < > &)。"""
    encoded = json.dumps(text, ensure_ascii=False)
    return encoded.replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")


def quality_extra_hash(extra):
    if not extra:
        return ""
    parts = []
    for key in sorted(extra):
        parts.append(go_json_string(key) + ":" + go_json_string(extra[key]))
    raw = "{" + ",".join(parts) + "}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def quality_cache_key(song_id, source, extra):
    extra_hash = quality_extra_hash(extra)
    raw = "\x00".join(
        [
            source.lower(),
            song_id,
            extra_hash,
            "",  # credentialHash:基准库无 cookie
            PROBE_VERSION.get(source.lower(), ""),
        ]
    )
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


cur.execute("SELECT song_id, source, extra FROM saved_songs")
seeded_quality = 0
for sid, source, extra_raw in cur.fetchall():
    extra = json.loads(extra_raw) if extra_raw else {}
    key = quality_cache_key(sid, source, extra)
    cur.execute(
        "INSERT OR REPLACE INTO quality_cache_rows "
        "(key,song_id,source,extra_hash,valid,url,size_bytes,size_text,bitrate,bitrate_num,checked_at) "
        "VALUES (?,?,?,?,1,'https://example.test/a.flac',30000000,'28.6 MB','920 kbps',920,datetime('now'))",
        (key, sid, source, quality_extra_hash(extra)),
    )
    seeded_quality += 1
print("quality_cache seeded with real Go-compatible keys =", seeded_quality)

conn.commit()

cur.execute("SELECT count(*) FROM saved_songs")
print("saved_songs =", cur.fetchone()[0])
cur.execute("SELECT count(*) FROM search_cache_rows")
print("search_cache_rows =", cur.fetchone()[0])
cur.execute("SELECT count(*), sum(length(payload)), max(length(payload)) FROM search_cache_rows")
print("cache rows/bytes/max =", cur.fetchone())
cur.execute("SELECT count(*) FROM quality_cache_rows")
print("quality_cache_rows =", cur.fetchone()[0])
cur.execute(
    "SELECT collection_id, count(*), sum(case when extra not like '%\"album\"%' then 1 else 0 end) FROM saved_songs GROUP BY 1 ORDER BY 2 DESC"
)
for row in cur.fetchall():
    print("  collection", row)
conn.close()
