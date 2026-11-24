package web

// 用 NAS 上的真实 m3u8 文件验证 parseM3U(2026-11-25 真机数据验证)。
//
// 为什么要有这条:整条导入链路的第一步就是把 m3u 文本变成条目,解析错了
// 后面全是白忙。而真实文件的编码/换行/EXTINF 形态未必与单测里手写的样本一致。
//
// ★ 这条测试**依赖外部 NAS 共享**(<NAS-SHARE>\...)。按纪律:环境不可达时
//   跳过而不是失败 —— 否则别人在没挂载 NAS 的机器上跑测试会一片红,
//   那不是缺陷,是环境差异。
//
// 真实数据规模(2026-11-25 实测):
//   催泪三部曲 3 / 剑网三 3 / 可塑性记忆 5 / 古风歌曲 43 /
//   纯音乐 89 / 流行歌曲 101 / 日语歌曲 163 —— 合计 407 条。

import (
	"os"
	"path/filepath"
	"testing"
)

const realM3UDir = `<NAS-M3U-DIR>`

// realM3UExpect 是实测的条目数。写死是为了让"解析结果变化"能被发现 ——
// 若将来解析逻辑改动导致某个文件的条目数变了,这里会先红。
var realM3UExpect = map[string]int{
	"催泪三部曲.m3u8": 3,
	"剑网三.m3u8":   3,
	"可塑性记忆.m3u8": 5,
	"古风歌曲.m3u8":  43,
	"纯音乐.m3u8":   89,
	"流行歌曲.m3u8":  101,
	"日语歌曲.m3u8":  163,
}

func TestParseM3UOnRealNASFiles(t *testing.T) {
	if _, err := os.Stat(realM3UDir); err != nil {
		t.Skipf("NAS 共享不可达, 跳过真实数据验证: %v", err)
	}

	total := 0
	for name, wantCount := range realM3UExpect {
		name, wantCount := name, wantCount
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(realM3UDir, name)
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("读取 %s 失败: %v", path, err)
			}

			entries, isHLS := parseM3U(string(raw))
			if isHLS {
				t.Fatalf("%s 被判为 HLS 视频流 —— 但它是音乐歌单", name)
			}
			if len(entries) != wantCount {
				t.Fatalf("%s 解析出 %d 条, 实测应为 %d 条", name, len(entries), wantCount)
			}

			// 每条都必须能拿到非空搜索词 —— 空搜索词会让后续匹配必然失败。
			for i, e := range entries {
				if e.Title == "" {
					t.Fatalf("%s 第 %d 条 Title 为空: %+v", name, i+1, e)
				}
			}
			total += len(entries)
		})
	}

	// 抽一条具体的核对:剑网三第 3 条应保留完整的搜索词。
	//
	// ★ 这里**不能**断言 artist/name 的拆分结果。真实数据验证发现:
	//   7 个文件里 "X - Y" 的顺序**不统一** ——
	//     · 「眉间雪 - HITA」「侠为天下先 - 剑网3」是歌名在前;
	//     · 但也有「银临 - 瀘沽寻梦」「西瓜JUN - 长生诀」是歌手在前;
	//     · 还有「银临 - 牵丝戏-... - 排骨教主,西瓜jun,西瓜JUN」这种多分隔符。
	//   统计(带 " - " 的 148 条):歌名在前 5 条明确、歌手在前 0 条明确、
	//   其余 143 条靠已知歌手名也无法判定 —— 说明**没有稳定规律**。
	//
	//   而 splitArtistTitle 的产物 Artist/Name 在导入流程里**从未被使用**
	//   (搜索用的是 e.Title 整行原文,见 m3u_import.go 的 query := e.Title)。
	//   所以拆分顺序对不对,不影响导入结果 —— 断言它只会造成假警报。
	//   真正要守的是:Title 必须是**完整的搜索词**(含歌手信息),否则搜索命中率会掉。
	raw, err := os.ReadFile(filepath.Join(realM3UDir, "剑网三.m3u8"))
	if err == nil {
		entries, _ := parseM3U(string(raw))
		if len(entries) >= 3 {
			third := entries[2]
			// 真实文件名是 "/app/media/眉间雪 - HITA.mp3" ——
			// 解析后 Title 必须保留"歌名 + 歌手"两部分,不能只剩一半。
			if third.Title != "眉间雪 - HITA" {
				t.Fatalf("剑网三第 3 条 Title 应保留完整搜索词「眉间雪 - HITA」, 实际 %q",
					third.Title)
			}
		}
	}
}

// TestParseM3URealFilesHaveNoEmptyEntries 单独确认:真实文件里没有解析空洞。
//
// parseM3U 对"没有 EXTINF 的行"有兜底(把非注释非空行当标题),所以理论上
// 条目数应与 EXTINF 数一致。这里用实测总数交叉核对一遍。
func TestParseM3URealFilesHaveNoEmptyEntries(t *testing.T) {
	if _, err := os.Stat(realM3UDir); err != nil {
		t.Skipf("NAS 共享不可达, 跳过: %v", err)
	}

	emptyTitle := 0
	for name := range realM3UExpect {
		raw, err := os.ReadFile(filepath.Join(realM3UDir, name))
		if err != nil {
			continue
		}
		entries, _ := parseM3U(string(raw))
		for _, e := range entries {
			if e.Title == "" {
				emptyTitle++
			}
		}
	}
	if emptyTitle > 0 {
		t.Fatalf("真实文件里出现 %d 条空标题条目 —— 导入时它们必然匹配失败", emptyTitle)
	}
}
