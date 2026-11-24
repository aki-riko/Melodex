package web

// 内部错误与客户端可见错误的分离(2026-11 全库扫描)。
//
// 问题:全库有 20+ 处 `c.JSON(500, gin.H{"error": err.Error()})`,把内部错误
// 原文直接回给客户端。真实的内部错误会带出:
//   · SQLite/Postgres 的错误串 —— 表名、列名、约束名、甚至部分 SQL 片段;
//   · 文件系统错误 —— 容器内绝对路径(如 /data/downloads/xxx.mp3);
//   · 上游 provider 的错误 —— 内部服务地址、端口、sidecar 的 Python 栈信息;
//   · 配置错误 —— 环境变量名、依赖库名。
//
// 这些都不该出现在 HTTP 响应体里:普通用户看到没用,而攻击者能拿来
// 摸清部署结构与内部命名。
//
// 但要区分两类错误,**不能一刀切遮蔽**:
//
//  1. **用户输入错误**(参数不合法、M3U 格式错、文件名非法):
//     必须把原因告诉用户,否则他不知道怎么改。这类错误应当由调用方在
//     构造时就写成用户能懂的中文(而不是 `strconv.Atoi: parsing "abc"`),
//     然后**原样返回**。
//
//  2. **内部错误**(数据库失败、磁盘满、上游 502):
//     对外只给一句固定文案 + 一个 request id,详情只进服务端日志。
//     用户拿 request id 反馈,运维能凭它精确捞到那一条日志。
//
// 这个文件只提供第 2 类的工具。第 1 类不需要工具 —— 它要求调用方
// 把错误文案写得像人话,而不是靠一层包装器去猜。

import (
	"log"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
)

// clientErrorIDHeader 是把 request id 回给客户端时用的响应头。
// 用头而不用响应体字段:前端各处错误处理都只读 `error` 字段,
// 加一个头不会破坏任何既有解析逻辑(改响应体形状才可能破坏)。
const clientErrorIDHeader = "X-Error-Id"

// respondInternalError 记录内部错误详情,只向客户端回一句固定文案。
//
// 用法:
//
//	if err := db.Create(&coll).Error; err != nil {
//	    respondInternalError(c, "创建歌单失败", err)
//	    return
//	}
//
// userMessage 应当是**用户能看懂的一句话**(不带英文、不带技术名词),
// 例如"创建歌单失败"。详情里绝不能拼接用户可控输入之外的敏感内容 ——
// 这里记录的是 err 本身,而 err 来自内部调用,这是刻意为之:
// 排查需要看到真实的数据库/文件系统报错。
func respondInternalError(c *gin.Context, userMessage string, err error) {
	// request id:优先复用上游(反代/中间件)已生成的,没有才新造。
	// 这样用户报的 id 能和 nginx/网关日志对上。
	id := c.GetHeader("X-Request-Id")
	if id == "" {
		id = uuid.NewString()
	}
	log.Printf("[internal-error] id=%s method=%s path=%s user=%d msg=%q err=%v",
		id, c.Request.Method, c.Request.URL.Path, currentUserID(c), userMessage, err)

	c.Header(clientErrorIDHeader, id)
	c.JSON(http.StatusInternalServerError, gin.H{
		"error":      userMessage,
		"request_id": id,
	})
}

// respondBadRequest 用于**用户输入错误**:文案由调用方写好,原样返回。
//
// 单独提供这个函数(而不是让调用方直接 c.JSON)是为了让两类错误在代码里
// 一眼可辨:看到 respondInternalError 就知道"详情不外泄",
// 看到 respondBadRequest 就知道"这句话是给用户看的、不能泄内部细节"。
func respondBadRequest(c *gin.Context, userMessage string) {
	c.JSON(http.StatusBadRequest, gin.H{"error": userMessage})
}

// currentUserID 定义在 auth_middleware.go(鉴权中间件写入 ctxUserID 的那一份),
// 这里直接复用,不重复定义 —— 两份实现将来会因为 context key 变更而分叉。
