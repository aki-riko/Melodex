package web

import (
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

const redactedLogValue = "REDACTED"

func redactPlaybackTicketPath(path string) string {
	queryOffset := strings.IndexByte(path, '?')
	if queryOffset < 0 {
		return path
	}
	rawQuery := path[queryOffset+1:]
	values, err := url.ParseQuery(rawQuery)
	if err != nil {
		if strings.Contains(strings.ToLower(rawQuery), playbackTicketQueryName) {
			return path[:queryOffset+1] + redactedLogValue
		}
		return path
	}
	if _, exists := values[playbackTicketQueryName]; !exists {
		return path
	}
	values.Set(playbackTicketQueryName, redactedLogValue)
	return path[:queryOffset+1] + values.Encode()
}

func redactedGinLogFormatter(param gin.LogFormatterParams) string {
	statusColor := param.StatusCodeColor()
	methodColor := param.MethodColor()
	resetColor := param.ResetColor()
	if param.Latency > time.Minute {
		param.Latency = param.Latency.Truncate(time.Second)
	}
	return fmt.Sprintf("[GIN] %v |%s %3d %s| %13v | %15s |%s %-7s %s %#v\n%s",
		param.TimeStamp.Format("2006/01/02 - 15:04:05"),
		statusColor, param.StatusCode, resetColor,
		param.Latency,
		param.ClientIP,
		methodColor, param.Method, resetColor,
		redactPlaybackTicketPath(param.Path),
		param.ErrorMessage,
	)
}
