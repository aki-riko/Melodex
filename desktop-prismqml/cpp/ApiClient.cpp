#include "melodex/ApiClient.h"

#include "melodex/AuthenticatedHttpProxy.h"
#include "melodex/CookieStore.h"
#include "melodex/JsonUtils.h"
#include "melodex/UserSettings.h"

#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QUrlQuery>
#include <stdexcept>

namespace melodex {
namespace {

int effectivePort(const QUrl &url) {
    if (url.port() >= 0)
        return url.port();
    if (url.scheme().compare(QStringLiteral("https"), Qt::CaseInsensitive) == 0)
        return 443;
    if (url.scheme().compare(QStringLiteral("http"), Qt::CaseInsensitive) == 0)
        return 80;
    return -1;
}

bool sameOrigin(const QUrl &left, const QUrl &right) {
    return left.scheme().compare(right.scheme(), Qt::CaseInsensitive) == 0 &&
           left.host().compare(right.host(), Qt::CaseInsensitive) == 0 &&
           effectivePort(left) == effectivePort(right);
}

}  // namespace

QUrl resolvePlaybackUrl(const QString &serviceUrl, const QString &rawUrl) {
    const QUrl base(serviceUrl, QUrl::StrictMode);
    const QUrl resolved = base.resolved(QUrl(rawUrl.trimmed(), QUrl::StrictMode));
    if (!base.isValid() || !resolved.isValid() || !sameOrigin(base, resolved))
        throw std::invalid_argument("服务端返回了跨域播放地址，已拒绝加载");
    if (!resolved.userName().isEmpty() || !resolved.password().isEmpty() ||
        !resolved.fragment().isEmpty())
        throw std::invalid_argument("服务端返回的播放地址包含不安全字段");
    return resolved;
}

ApiClient::ApiClient(UserSettings *settings, CookieStore *cookies, QObject *parent)
    : QObject(parent),
      m_settings(settings),
      m_cookies(cookies),
      m_mediaProxy(std::make_unique<AuthenticatedHttpProxy>()) {
    m_network.setCookieJar(new DelegatingCookieJar(cookies, &m_network));
}

ApiClient::~ApiClient() = default;

QUrl ApiClient::rootUrl(const QString &path) const {
    if (!m_settings || m_settings->serviceUrl().isEmpty())
        throw std::invalid_argument("请先填写 Melodex 服务地址");
    QString relative = path;
    while (relative.startsWith(QLatin1Char('/')))
        relative.remove(0, 1);
    return QUrl(m_settings->serviceUrl()).resolved(QUrl(relative));
}

void ApiClient::setBusy(bool value) {
    if (value == m_busy)
        return;
    m_busy = value;
    emit busyChanged();
}

void ApiClient::setError(const QString &message) {
    if (message == m_error)
        return;
    m_error = message;
    emit errorChanged();
}

void ApiClient::request(const QByteArray &method, const QString &path,
                        RequestCallback callback, const QVariantMap *payload,
                        bool expectText) {
    QUrl url;
    try {
        url = rootUrl(path);
    } catch (const std::invalid_argument &error) {
        const QString message = QString::fromUtf8(error.what());
        setError(message);
        callback({}, message, 0);
        return;
    }
    QNetworkRequest request(url);
    request.setRawHeader("Accept", expectText ? "text/plain" : "application/json");
    request.setRawHeader("X-Requested-With", "XMLHttpRequest");
    QByteArray body;
    if (payload) {
        request.setHeader(QNetworkRequest::ContentTypeHeader,
                          QStringLiteral("application/json"));
        body = QJsonDocument::fromVariant(*payload).toJson(QJsonDocument::Compact);
    }

    QNetworkReply *reply = nullptr;
    if (method == "GET")
        reply = m_network.get(request);
    else if (method == "POST")
        reply = m_network.post(request, body);
    else if (method == "DELETE")
        reply = m_network.deleteResource(request);
    else {
        const QString message = QStringLiteral("不支持的请求方法：") +
                                QString::fromLatin1(method);
        setError(message);
        callback({}, message, 0);
        return;
    }
    connect(reply, &QNetworkReply::finished, this,
            [this, reply, callback = std::move(callback), expectText]() mutable {
                finishReply(reply, std::move(callback), expectText);
            });
}

void ApiClient::requestJson(const QByteArray &method, const QString &path,
                            RequestCallback callback, const QVariantMap &payload) {
    const QVariantMap *payloadPtr = method == "POST" ? &payload : nullptr;
    request(method, path, std::move(callback), payloadPtr, false);
}

QString ApiClient::responseError(QNetworkReply *reply, const QByteArray &raw,
                                 const QByteArray &contentType) const {
    if (contentType.contains("text/html"))
        return QStringLiteral("服务被前置登录网关拦截，桌面客户端尚未取得访问授权");
    QJsonParseError parseError;
    const QJsonDocument document = QJsonDocument::fromJson(raw, &parseError);
    if (parseError.error == QJsonParseError::NoError && document.isObject()) {
        const QString backendError = document.object().value(QStringLiteral("error"))
                                         .toString();
        if (!backendError.isEmpty())
            return backendError;
    }
    return reply->errorString();
}

void ApiClient::finishReply(QNetworkReply *reply, RequestCallback callback,
                            bool expectText) {
    const int status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
    const QByteArray raw = reply->readAll();
    const QByteArray contentType = reply->rawHeader("Content-Type");
    if (reply->error() != QNetworkReply::NoError || status < 200 || status >= 300) {
        callback({}, responseError(reply, raw, contentType), status);
        reply->deleteLater();
        return;
    }
    if (expectText) {
        callback(QString::fromUtf8(raw), {}, status);
        reply->deleteLater();
        return;
    }
    QJsonParseError parseError;
    const QJsonDocument document = QJsonDocument::fromJson(raw, &parseError);
    if (parseError.error != QJsonParseError::NoError) {
        const QString message = contentType.contains("text/html")
                                    ? QStringLiteral("服务被前置登录网关拦截，桌面客户端尚未取得访问授权")
                                    : QStringLiteral("服务返回了无法解析的数据");
        callback({}, message, status);
    } else {
        callback(document.toVariant(), {}, status);
    }
    reply->deleteLater();
}

void ApiClient::checkSession() {
    if (!m_settings || m_settings->serviceUrl().isEmpty())
        return;
    const quint64 serial = ++m_sessionSerial;
    setBusy(true);
    setError({});
    request("GET", QStringLiteral("/api/v1/me"),
            [this, serial](const QVariant &payload, const QString &error, int status) {
                if (serial != m_sessionSerial)
                    return;
                setBusy(false);
                const QVariantMap user = payload.toMap().value(QStringLiteral("user")).toMap();
                if (!error.isEmpty() || user.isEmpty()) {
                    setAuthenticated(false, {});
                    if (!error.isEmpty() && status != 0 && status != 401)
                        setError(error);
                    return;
                }
                setAuthenticated(true, user);
            });
}

void ApiClient::login(const QString &serviceUrl, const QString &username,
                      const QString &password) {
    const quint64 serial = ++m_sessionSerial;
    setBusy(true);
    setError({});
    try {
        const QString previousServiceUrl = m_settings->serviceUrl();
        m_settings->setServiceUrl(serviceUrl);
        if (m_mediaProxy && previousServiceUrl != m_settings->serviceUrl())
            m_mediaProxy->clear();
    } catch (const std::invalid_argument &error) {
        setBusy(false);
        setError(QString::fromUtf8(error.what()));
        return;
    }
    const QVariantMap body{{QStringLiteral("username"), username.trimmed()},
                           {QStringLiteral("password"), password}};
    request("POST", QStringLiteral("/api/v1/auth/login"),
            [this, serial](const QVariant &payload, const QString &error, int) {
                if (serial != m_sessionSerial)
                    return;
                setBusy(false);
                const QVariantMap user = payload.toMap().value(QStringLiteral("user")).toMap();
                if (!error.isEmpty() || user.isEmpty()) {
                    setAuthenticated(false, {});
                    setError(error.isEmpty() ? QStringLiteral("登录响应缺少用户信息") : error);
                    return;
                }
                setAuthenticated(true, user);
            }, &body);
}

void ApiClient::logout() {
    const quint64 serial = ++m_sessionSerial;
    const QVariantMap body;
    request("POST", QStringLiteral("/api/v1/auth/logout"),
            [this, serial](const QVariant &, const QString &error, int) {
                if (serial != m_sessionSerial)
                    return;
                if (m_mediaProxy)
                    m_mediaProxy->clear();
                m_cookies->clear();
                setAuthenticated(false, {});
                if (!error.isEmpty())
                    setError(error);
            }, &body);
}

void ApiClient::setAuthenticated(bool authenticated, const QVariantMap &user) {
    if (authenticated != m_authenticated) {
        m_authenticated = authenticated;
        emit authenticatedChanged();
    }
    if (user != m_currentUser) {
        m_currentUser = user;
        emit currentUserChanged();
    }
}

void ApiClient::search(const QString &rawKeyword) {
    const QString keyword = rawKeyword.trimmed();
    if (keyword.isEmpty()) {
        setError(QStringLiteral("请输入歌名或歌手"));
        return;
    }
    const quint64 serial = ++m_searchSerial;
    QUrlQuery query;
    query.addQueryItem(QStringLiteral("q"), keyword);
    query.addQueryItem(QStringLiteral("type"), QStringLiteral("song"));
    setBusy(true);
    setError({});
    request("GET", QStringLiteral("/api/v1/search?") + encodedQuery(query),
            [this, serial](const QVariant &payload, const QString &error, int) {
                if (serial != m_searchSerial)
                    return;
                setBusy(false);
                if (!error.isEmpty()) {
                    setError(error);
                    return;
                }
                QVariantList normalized;
                for (const QVariantMap &song : variantMaps(
                         payload.toMap().value(QStringLiteral("songs"))))
                    normalized.append(normalizeSong(song));
                m_searchResults = normalized;
                emit searchResultsChanged();
            });
}

void ApiClient::requestStreamUrl(const QVariantMap &song, StreamCallback callback) {
    if (!m_mediaProxy || !m_mediaProxy->isListening()) {
        const QString detail =
            m_mediaProxy ? m_mediaProxy->errorString() : QString();
        callback({}, detail.isEmpty()
                         ? QStringLiteral("无法启动本机媒体续传服务")
                         : QStringLiteral("无法启动本机媒体续传服务：") + detail);
        return;
    }
    const QString query = encodedQuery(songQuery(
        song, {{QStringLiteral("stream"), QStringLiteral("1")}}));
    const QVariantMap body{{QStringLiteral("query"), query}};
    request("POST", QStringLiteral("/api/v1/playback_ticket"),
            [this, callback = std::move(callback)](const QVariant &payload,
                                                   const QString &error, int) {
                if (!error.isEmpty()) {
                    callback({}, error);
                    return;
                }
                const QString rawUrl = payload.toMap().value(QStringLiteral("url")).toString();
                if (rawUrl.isEmpty()) {
                    callback({}, QStringLiteral("服务端未返回原生播放地址"));
                    return;
                }
                try {
                    const QUrl remoteUrl =
                        resolvePlaybackUrl(m_settings->serviceUrl(), rawUrl);
                    const QUrl localUrl = m_mediaProxy->registerUrl(remoteUrl);
                    if (localUrl.isEmpty()) {
                        callback({}, QStringLiteral("本机媒体续传服务拒绝了播放地址"));
                        return;
                    }
                    callback(localUrl.toString(QUrl::FullyEncoded), {});
                } catch (const std::invalid_argument &validationError) {
                    callback({}, QString::fromUtf8(validationError.what()));
                }
            }, &body);
}

QString ApiClient::coverUrl(const QVariantMap &songValue) const {
    const QVariantMap song = normalizeSong(songValue);
    const QString cover = song.value(QStringLiteral("cover")).toString();
    if (cover.isEmpty())
        return {};
    try {
        QUrl url;
        if (cover.startsWith(QLatin1Char('/'))) {
            url = rootUrl(cover);
        } else {
            url = rootUrl(QStringLiteral("/music/cover_proxy"));
            QUrlQuery query;
            query.addQueryItem(QStringLiteral("url"), cover);
            query.addQueryItem(QStringLiteral("source"),
                               song.value(QStringLiteral("source")).toString());
            url.setQuery(query);
        }
        // QML Image 请求由 SharedNetworkAccessManagerFactory 统一携带登录 Cookie。
        // 图片不应经过面向连续音频字节设计的本机续传代理，否则图片加载失败时
        // 会被误当成媒体续传故障，所有封面一起退回错误占位图。
        return url.toString(QUrl::FullyEncoded);
    } catch (const std::invalid_argument &error) {
        qWarning().noquote() << "[WARN] 无法生成封面地址：" << error.what();
        return {};
    }
}

void ApiClient::loadLyrics(const QVariantMap &songValue) {
    const QVariantMap song = normalizeSong(songValue);
    const QString key = songKey(song);
    const QString path = QStringLiteral("/music/lyric?") + encodedQuery(songQuery(song));
    request("GET", path,
            [this, key](const QVariant &payload, const QString &error, int) {
                if (!error.isEmpty()) {
                    qWarning().noquote() << "[WARN] 加载歌词失败：" << error;
                    emit lyricLoaded(key, {});
                    return;
                }
                emit lyricLoaded(key, payload.toString());
            }, nullptr, true);
}

}  // namespace melodex
