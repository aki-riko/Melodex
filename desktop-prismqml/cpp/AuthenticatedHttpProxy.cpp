// SPDX-License-Identifier: AGPL-3.0-only
#include "melodex/AuthenticatedHttpProxy.h"

#include "AuthenticatedHttpProxyPrivate.h"

#include <QHostAddress>
#include <QMetaObject>
#include <QNetworkAccessManager>
#include <QNetworkRequest>
#include <QRandomGenerator>
#include <QRegularExpression>
#include <QTcpServer>
#include <QTcpSocket>
#include <algorithm>
#include <cstring>

namespace melodex {

const QList<int> kResumeRetryDelaysMs{50, 100, 200};
const QSet<int> kRetriableStatusCodes{408, 425, 429, 500, 502, 503, 504};
const QRegularExpression kContentRangePattern(
    QStringLiteral(R"(^bytes (\d+)-(\d+)/(\d+|\*)$)"));

QByteArray randomToken(int byteCount) {
    QByteArray bytes(byteCount, Qt::Uninitialized);
    auto *generator = QRandomGenerator::system();
    for (qsizetype offset = 0; offset < bytes.size(); offset += sizeof(quint32)) {
        const quint32 value = generator->generate();
        const qsizetype count =
            std::min<qsizetype>(sizeof(value), bytes.size() - offset);
        std::memcpy(bytes.data() + offset, &value, static_cast<size_t>(count));
    }
    return bytes.toBase64(QByteArray::Base64UrlEncoding |
                          QByteArray::OmitTrailingEquals);
}

QByteArray reasonPhrase(int status) {
    switch (status) {
    case 400:
        return "Bad Request";
    case 404:
        return "Not Found";
    case 405:
        return "Method Not Allowed";
    case 431:
        return "Request Header Fields Too Large";
    case 502:
        return "Bad Gateway";
    default:
        return "HTTP Response";
    }
}

std::optional<ContentRange> parseContentRange(const QByteArray &rawValue) {
    const QRegularExpressionMatch match =
        kContentRangePattern.match(QString::fromLatin1(rawValue.trimmed()));
    if (!match.hasMatch() || match.captured(3) == QStringLiteral("*"))
        return std::nullopt;
    bool startOk = false;
    bool endOk = false;
    bool totalOk = false;
    const qint64 start = match.captured(1).toLongLong(&startOk);
    const qint64 end = match.captured(2).toLongLong(&endOk);
    const qint64 total = match.captured(3).toLongLong(&totalOk);
    if (!startOk || !endOk || !totalOk || start > end || end >= total)
        return std::nullopt;
    return ContentRange{start, end, total};
}

std::optional<qint64> parseLength(const QByteArray &value) {
    bool ok = false;
    const qint64 result = value.trimmed().toLongLong(&ok);
    if (!ok || result < 0)
        return std::nullopt;
    return result;
}

std::optional<ResponseWindow> responseWindow(QNetworkReply *reply) {
    const int status =
        reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
    const QByteArray lengthHeader = reply->rawHeader("Content-Length");
    qint64 absoluteStart = 0;
    qint64 bodyLength = 0;
    qint64 totalLength = 0;
    if (status == 206) {
        const auto range = parseContentRange(reply->rawHeader("Content-Range"));
        if (!range)
            return std::nullopt;
        absoluteStart = range->start;
        bodyLength = range->end - range->start + 1;
        totalLength = range->total;
        if (!lengthHeader.isEmpty()) {
            const auto declaredLength = parseLength(lengthHeader);
            if (!declaredLength || *declaredLength != bodyLength)
                return std::nullopt;
        }
    } else if (status == 200 && !lengthHeader.isEmpty()) {
        const auto declaredLength = parseLength(lengthHeader);
        if (!declaredLength)
            return std::nullopt;
        bodyLength = *declaredLength;
        totalLength = bodyLength;
    } else {
        return std::nullopt;
    }
    if (bodyLength <= 0)
        return std::nullopt;
    return ResponseWindow{absoluteStart,
                          bodyLength,
                          totalLength,
                          reply->rawHeader("ETag"),
                          reply->rawHeader("Last-Modified")};
}

QString reverseKey(const QUrl &url, const QByteArray &cookieHeader) {
    return url.toString(QUrl::FullyEncoded) + QLatin1Char('\n') +
           QString::fromLatin1(cookieHeader.toBase64());
}

bool AuthenticatedHttpProxyWorker::start(QString *error) {
    m_token = randomToken(32);
    m_network = new QNetworkAccessManager(this);
    m_server = new QTcpServer(this);
    connect(m_server, &QTcpServer::newConnection, this,
            [this] { handleNewConnections(); });
    if (m_server->listen(QHostAddress::LocalHost, 0))
        return true;
    if (error)
        *error = m_server->errorString();
    return false;
}

void AuthenticatedHttpProxyWorker::stop() {
    if (m_server)
        m_server->close();
    const auto sessions = m_sessions;
    for (ProxyRequestSession *session : sessions)
        delete session;
    m_sessions.clear();
    clear();
}

QUrl AuthenticatedHttpProxyWorker::registerUrl(
    const QUrl &remoteUrl, const QByteArray &cookieHeader) {
    if (!m_server || !m_server->isListening() || !remoteUrl.isValid() ||
        (remoteUrl.scheme() != QStringLiteral("http") &&
         remoteUrl.scheme() != QStringLiteral("https")) ||
        remoteUrl.host().isEmpty() || !remoteUrl.userName().isEmpty() ||
        !remoteUrl.password().isEmpty() || !remoteUrl.fragment().isEmpty())
        return {};

    const QString key = reverseKey(remoteUrl, cookieHeader);
    QByteArray entryId = m_reverse.value(key);
    if (entryId.isEmpty()) {
        entryId = randomToken(18);
        m_entries.insert(entryId, ProxyEntry{remoteUrl, cookieHeader});
        m_reverse.insert(key, entryId);
        m_insertionOrder.append(entryId);
        while (m_insertionOrder.size() > kMaximumEntries) {
            const QByteArray oldestId = m_insertionOrder.takeFirst();
            const ProxyEntry oldest = m_entries.take(oldestId);
            m_reverse.remove(reverseKey(oldest.remoteUrl, oldest.cookieHeader));
        }
    }

    QUrl localUrl;
    localUrl.setScheme(QStringLiteral("http"));
    localUrl.setHost(QStringLiteral("127.0.0.1"));
    localUrl.setPort(m_server->serverPort());
    localUrl.setPath(QStringLiteral("/") + QString::fromLatin1(m_token) +
                     QStringLiteral("/") + QString::fromLatin1(entryId));
    return localUrl;
}

void AuthenticatedHttpProxyWorker::clear() {
    m_entries.clear();
    m_reverse.clear();
    m_insertionOrder.clear();
}

std::optional<ProxyEntry> AuthenticatedHttpProxyWorker::lookup(
    const QByteArray &requestTarget) const {
    const qsizetype queryStart = requestTarget.indexOf('?');
    const QByteArray path = requestTarget.left(
        queryStart < 0 ? requestTarget.size() : queryStart);
    const QByteArray prefix = "/" + m_token + "/";
    if (!path.startsWith(prefix))
        return std::nullopt;
    const auto found = m_entries.constFind(path.mid(prefix.size()));
    if (found == m_entries.cend())
        return std::nullopt;
    return found.value();
}

void AuthenticatedHttpProxyWorker::handleNewConnections() {
    while (m_server && m_server->hasPendingConnections()) {
        QTcpSocket *socket = m_server->nextPendingConnection();
        auto *session = new ProxyRequestSession(this, socket, this);
        m_sessions.insert(session);
        connect(session, &QObject::destroyed, this,
                [this, session] { m_sessions.remove(session); });
    }
}

AuthenticatedHttpProxy::AuthenticatedHttpProxy(QObject *parent)
    : QObject(parent), m_worker(new AuthenticatedHttpProxyWorker) {
    m_worker->moveToThread(&m_thread);
    connect(&m_thread, &QThread::finished, m_worker, &QObject::deleteLater);
    m_thread.setObjectName(QStringLiteral("melodex-authenticated-media"));
    m_thread.start();
    QMetaObject::invokeMethod(
        m_worker,
        [this] { m_listening = m_worker->start(&m_startError); },
        Qt::BlockingQueuedConnection);
}

AuthenticatedHttpProxy::~AuthenticatedHttpProxy() {
    if (m_worker && m_thread.isRunning())
        QMetaObject::invokeMethod(m_worker, [this] { m_worker->stop(); },
                                  Qt::BlockingQueuedConnection);
    m_thread.quit();
    m_thread.wait();
    m_worker = nullptr;
}

QUrl AuthenticatedHttpProxy::registerUrl(const QUrl &remoteUrl,
                                         const QByteArray &cookieHeader) const {
    if (!m_worker || !m_thread.isRunning() || !m_listening)
        return {};
    QUrl result;
    QMetaObject::invokeMethod(
        m_worker,
        [this, &result, remoteUrl, cookieHeader] {
            result = m_worker->registerUrl(remoteUrl, cookieHeader);
        },
        Qt::BlockingQueuedConnection);
    return result;
}

void AuthenticatedHttpProxy::clear() {
    if (!m_worker || !m_thread.isRunning())
        return;
    QMetaObject::invokeMethod(m_worker, [this] { m_worker->clear(); },
                              Qt::BlockingQueuedConnection);
}

}  // namespace melodex
