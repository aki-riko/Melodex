// SPDX-License-Identifier: AGPL-3.0-only
#include "AuthenticatedHttpProxyPrivate.h"

#include <QNetworkAccessManager>
#include <QNetworkRequest>
#include <QTcpSocket>
#include <QTimer>
#include <algorithm>

namespace melodex {

ProxyRequestSession::ProxyRequestSession(AuthenticatedHttpProxyWorker *worker,
                                         QTcpSocket *socket, QObject *parent)
    : QObject(parent), m_worker(worker), m_socket(socket) {
    m_socket->setParent(this);
    connect(m_socket, &QTcpSocket::readyRead, this,
            [this] { readLocalRequest(); });
    connect(m_socket, &QTcpSocket::bytesWritten, this,
            [this] { pumpUpstreamBody(); });
    connect(m_socket, &QTcpSocket::disconnected, this,
            [this] { cancelAndDelete(); });
    if (m_socket->bytesAvailable() > 0)
        readLocalRequest();
}

ProxyRequestSession::~ProxyRequestSession() { releaseReply(true); }

void ProxyRequestSession::readLocalRequest() {
    if (m_finished || m_requestParsed)
        return;
    m_requestBuffer.append(m_socket->readAll());
    if (m_requestBuffer.size() > kMaximumRequestHeader) {
        sendLocalError(431);
        return;
    }
    const qsizetype headerEnd = m_requestBuffer.indexOf("\r\n\r\n");
    if (headerEnd < 0)
        return;
    if (!parseLocalRequest(m_requestBuffer.left(headerEnd)))
        return;
    m_requestParsed = true;
    openUpstream();
}

bool ProxyRequestSession::parseLocalRequest(const QByteArray &headerBlock) {
    const QList<QByteArray> lines = headerBlock.split('\n');
    if (lines.isEmpty()) {
        sendLocalError(400);
        return false;
    }
    const QList<QByteArray> requestParts = lines.constFirst().trimmed().split(' ');
    if (requestParts.size() != 3 || !requestParts.at(2).startsWith("HTTP/")) {
        sendLocalError(400);
        return false;
    }
    m_method = requestParts.at(0).toUpper();
    if (m_method != "GET" && m_method != "HEAD") {
        sendLocalError(405);
        return false;
    }
    const auto entry = m_worker->lookup(requestParts.at(1));
    if (!entry) {
        sendLocalError(404);
        return false;
    }
    m_entry = *entry;
    for (qsizetype index = 1; index < lines.size(); ++index) {
        const QByteArray line = lines.at(index).trimmed();
        const qsizetype separator = line.indexOf(':');
        if (separator <= 0)
            continue;
        const QByteArray name = line.left(separator).trimmed().toLower();
        const QByteArray value = line.mid(separator + 1).trimmed();
        if (name == "accept")
            m_accept = value;
        else if (name == "range")
            m_playerRange = value;
    }
    return true;
}

void ProxyRequestSession::openUpstream(const QByteArray &rangeOverride,
                                       const QByteArray &ifRange, bool resume) {
    if (m_finished)
        return;
    releaseReply(false);
    QNetworkRequest request(m_entry.remoteUrl);
    request.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                         QNetworkRequest::ManualRedirectPolicy);
    request.setTransferTimeout(kUpstreamTimeoutMs);
    request.setRawHeader("Accept", m_accept.isEmpty() ? QByteArray("*/*") : m_accept);
    request.setRawHeader("Accept-Encoding", "identity");
    request.setRawHeader("Connection", "close");
    request.setRawHeader("User-Agent", "MelodexDesktop");
    if (!m_entry.cookieHeader.isEmpty())
        request.setRawHeader("Cookie", m_entry.cookieHeader);
    const QByteArray range = rangeOverride.isEmpty() ? m_playerRange : rangeOverride;
    if (!range.isEmpty())
        request.setRawHeader("Range", range);
    if (!ifRange.isEmpty())
        request.setRawHeader("If-Range", ifRange);

    m_replyIsResume = resume;
    m_resumeValidated = !resume;
    m_replyFinished = false;
    m_waitingForResume = false;
    m_reply = m_method == "HEAD" ? m_worker->network()->head(request)
                                  : m_worker->network()->get(request);
    m_reply->setReadBufferSize(kUpstreamReadBufferSize);
    connect(m_reply, &QNetworkReply::metaDataChanged, this,
            [this] { processMetadata(); });
    connect(m_reply, &QIODevice::readyRead, this,
            [this] { pumpUpstreamBody(); });
    connect(m_reply, &QNetworkReply::finished, this,
            [this] { handleUpstreamFinished(); });
}

void ProxyRequestSession::processMetadata() {
    if (!m_reply || m_finished)
        return;
    const int status =
        m_reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
    if (status <= 0)
        return;
    if (!m_replyIsResume) {
        if (!m_responseStarted)
            sendInitialHeaders();
        return;
    }
    if (m_resumeValidated)
        return;
    QString validationError;
    const ResumeValidation validation = validateResumeResponse(&validationError);
    if (validation == ResumeValidation::Valid) {
        m_resumeValidated = true;
        pumpUpstreamBody();
    } else if (validation == ResumeValidation::Retriable) {
        beginResume(true, validationError);
    } else {
        failTransfer(validationError);
    }
}

void ProxyRequestSession::sendInitialHeaders() {
    if (!m_reply || m_responseStarted)
        return;
    const int status =
        m_reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
    if (status <= 0)
        return;
    QByteArray reason =
        m_reply->attribute(QNetworkRequest::HttpReasonPhraseAttribute).toByteArray();
    if (reason.isEmpty())
        reason = reasonPhrase(status);
    QByteArray response = "HTTP/1.1 " + QByteArray::number(status) + " " + reason +
                          "\r\n";
    for (const QByteArray &name : {QByteArray("Content-Type"),
                                   QByteArray("Content-Length"),
                                   QByteArray("Content-Range"),
                                   QByteArray("Accept-Ranges"),
                                   QByteArray("Cache-Control"), QByteArray("ETag"),
                                   QByteArray("Last-Modified")}) {
        const QByteArray value = m_reply->rawHeader(name);
        if (!value.isEmpty())
            response += name + ": " + value + "\r\n";
    }
    response += "Connection: close\r\n\r\n";
    m_socket->write(response);
    m_responseStarted = true;
    if (m_method == "GET")
        m_window = responseWindow(m_reply);
}

ProxyRequestSession::ResumeValidation
ProxyRequestSession::validateResumeResponse(QString *error) const {
    const int status =
        m_reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
    if (kRetriableStatusCodes.contains(status)) {
        if (error)
            *error = QStringLiteral("远端媒体续传暂时失败，HTTP 状态为 %1")
                         .arg(status);
        return ResumeValidation::Retriable;
    }
    if (status != 206 || !m_window) {
        if (error)
            *error = QStringLiteral("远端拒绝媒体续传，HTTP 状态为 %1").arg(status);
        return ResumeValidation::Unsafe;
    }
    const auto range = parseContentRange(m_reply->rawHeader("Content-Range"));
    const qint64 resumeStart = m_window->absoluteStart + m_sent;
    if (!range || range->start != resumeStart ||
        range->end != m_window->absoluteEnd()) {
        if (error)
            *error = QStringLiteral("远端媒体续传范围与请求不一致");
        return ResumeValidation::Unsafe;
    }
    const QByteArray lengthHeader = m_reply->rawHeader("Content-Length");
    if (!lengthHeader.isEmpty()) {
        const auto length = parseLength(lengthHeader);
        if (!length || *length != range->end - range->start + 1) {
            if (error)
                *error = QStringLiteral(
                    "远端媒体续传 Content-Length 与 Content-Range 不一致");
            return ResumeValidation::Unsafe;
        }
    }
    if (range->total != m_window->totalLength) {
        if (error)
            *error = QStringLiteral("远端媒体在续传期间长度发生变化");
        return ResumeValidation::Unsafe;
    }
    if (!m_window->etag.isEmpty() &&
        m_reply->rawHeader("ETag") != m_window->etag) {
        if (error)
            *error = QStringLiteral("远端媒体在续传期间 ETag 发生变化");
        return ResumeValidation::Unsafe;
    }
    if (!m_window->lastModified.isEmpty() &&
        m_reply->rawHeader("Last-Modified") != m_window->lastModified) {
        if (error)
            *error = QStringLiteral("远端媒体在续传期间修改时间发生变化");
        return ResumeValidation::Unsafe;
    }
    return ResumeValidation::Valid;
}

void ProxyRequestSession::pumpUpstreamBody() {
    if (!m_reply || !m_socket || m_finished || !m_responseStarted ||
        (m_replyIsResume && !m_resumeValidated) || m_method == "HEAD")
        return;

    while (m_socket->state() == QAbstractSocket::ConnectedState) {
        const qint64 capacity =
            kMaximumPendingClientBytes - m_socket->bytesToWrite();
        if (capacity <= 0)
            break;
        if (!m_pendingClientData.isEmpty()) {
            const qint64 written = m_socket->write(
                m_pendingClientData.constData(),
                std::min<qint64>(capacity, m_pendingClientData.size()));
            if (written <= 0)
                break;
            m_pendingClientData.remove(0, written);
            m_sent += written;
            continue;
        }
        qint64 maximumRead = std::min(kCopyChunkSize, capacity);
        if (m_window) {
            const qint64 remaining = m_window->bodyLength - m_sent;
            if (remaining <= 0)
                break;
            maximumRead = std::min(maximumRead, remaining);
        }
        const QByteArray chunk = m_reply->read(maximumRead);
        if (chunk.isEmpty())
            break;
        m_pendingClientData = chunk;
    }
    maybeFinishUpstream();
}

void ProxyRequestSession::handleUpstreamFinished() {
    if (!m_reply || m_finished)
        return;
    m_replyFinished = true;
    if (!m_responseStarted && !m_replyIsResume)
        processMetadata();
    if (m_replyIsResume && !m_resumeValidated) {
        processMetadata();
        if (m_reply && !m_resumeValidated && !m_waitingForResume)
            beginResume(true, QStringLiteral("远端媒体续传连接未返回有效响应"));
        return;
    }
    pumpUpstreamBody();
    maybeFinishUpstream();
}

void ProxyRequestSession::maybeFinishUpstream() {
    if (!m_reply || !m_replyFinished || m_finished || m_waitingForResume ||
        !m_pendingClientData.isEmpty() || m_reply->bytesAvailable() > 0)
        return;
    if (!m_responseStarted) {
        sendLocalError(502);
        return;
    }
    if (m_method == "HEAD" || !m_window || m_sent >= m_window->bodyLength) {
        finishLocalResponse();
        return;
    }
    beginResume(false, QStringLiteral("远端媒体提前结束"));
}

void ProxyRequestSession::beginResume(bool delayedRetry,
                                      const QString &failure) {
    if (m_finished || m_waitingForResume || !m_window)
        return;
    if (m_resumeAttempts >= kMaximumResumeAttempts) {
        failTransfer(failure);
        return;
    }
    const int previousAttempt = m_resumeAttempts;
    ++m_resumeAttempts;
    const qint64 resumeStart = m_window->absoluteStart + m_sent;
    const QByteArray range =
        "bytes=" + QByteArray::number(resumeStart) + "-" +
        QByteArray::number(m_window->absoluteEnd());
    const QByteArray validator =
        !m_window->etag.isEmpty() && !m_window->etag.startsWith("W/")
            ? m_window->etag
            : m_window->lastModified;
    const int delay =
        delayedRetry && previousAttempt > 0
            ? kResumeRetryDelaysMs.at(std::min<int>(
                  previousAttempt - 1,
                  static_cast<int>(kResumeRetryDelaysMs.size()) - 1))
            : 0;
    qWarning().noquote()
        << QStringLiteral("[WARN] 远端媒体提前结束，从字节 %1 续传（%2/%3）")
               .arg(resumeStart)
               .arg(m_resumeAttempts)
               .arg(kMaximumResumeAttempts);
    m_waitingForResume = true;
    releaseReply(true);
    QTimer::singleShot(delay, this, [this, range, validator] {
        if (!m_finished)
            openUpstream(range, validator, true);
    });
}

void ProxyRequestSession::failTransfer(const QString &message) {
    if (m_finished)
        return;
    qWarning().noquote() << "[WARN] 本机媒体续传失败：" << message;
    finishLocalResponse();
}

void ProxyRequestSession::sendLocalError(int status) {
    if (m_finished)
        return;
    const QByteArray reason = reasonPhrase(status);
    const QByteArray body = QByteArray::number(status) + " " + reason + "\n";
    m_socket->write("HTTP/1.1 " + QByteArray::number(status) + " " + reason +
                    "\r\nContent-Type: text/plain; charset=utf-8\r\n"
                    "Content-Length: " +
                    QByteArray::number(body.size()) +
                    "\r\nConnection: close\r\n\r\n" + body);
    m_responseStarted = true;
    finishLocalResponse();
}

void ProxyRequestSession::finishLocalResponse() {
    if (m_finished)
        return;
    m_finished = true;
    releaseReply(false);
    if (m_socket->state() == QAbstractSocket::UnconnectedState)
        deleteLater();
    else
        m_socket->disconnectFromHost();
}

void ProxyRequestSession::cancelAndDelete() {
    if (!m_finished)
        m_finished = true;
    releaseReply(true);
    deleteLater();
}

void ProxyRequestSession::releaseReply(bool abort) {
    if (!m_reply)
        return;
    disconnect(m_reply, nullptr, this, nullptr);
    if (abort && m_reply->isRunning())
        m_reply->abort();
    m_reply->deleteLater();
    m_reply = nullptr;
}

}  // namespace melodex
