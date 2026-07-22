#pragma once

#include <QHash>
#include <QList>
#include <QNetworkReply>
#include <QObject>
#include <QSet>
#include <QUrl>
#include <optional>

class QNetworkAccessManager;
class QTcpServer;
class QTcpSocket;

namespace melodex {

inline constexpr qsizetype kMaximumRequestHeader = 64 * 1024;
inline constexpr qint64 kCopyChunkSize = 64 * 1024;
inline constexpr qint64 kMaximumPendingClientBytes = 512 * 1024;
inline constexpr qint64 kUpstreamReadBufferSize = 256 * 1024;
inline constexpr int kMaximumResumeAttempts = 4;
inline constexpr int kMaximumEntries = 256;
inline constexpr int kUpstreamTimeoutMs = 30 * 1000;

extern const QList<int> kResumeRetryDelaysMs;
extern const QSet<int> kRetriableStatusCodes;

struct ProxyEntry {
    QUrl remoteUrl;
    QByteArray cookieHeader;
};

struct ResponseWindow {
    qint64 absoluteStart = 0;
    qint64 bodyLength = 0;
    qint64 totalLength = 0;
    QByteArray etag;
    QByteArray lastModified;

    qint64 absoluteEnd() const { return absoluteStart + bodyLength - 1; }
};

struct ContentRange {
    qint64 start = 0;
    qint64 end = 0;
    qint64 total = 0;
};

QByteArray randomToken(int byteCount);
QByteArray reasonPhrase(int status);
std::optional<ContentRange> parseContentRange(const QByteArray &rawValue);
std::optional<qint64> parseLength(const QByteArray &value);
std::optional<ResponseWindow> responseWindow(QNetworkReply *reply);
QString reverseKey(const QUrl &url, const QByteArray &cookieHeader);

class ProxyRequestSession;

class AuthenticatedHttpProxyWorker final : public QObject {
public:
    bool start(QString *error);
    void stop();
    QUrl registerUrl(const QUrl &remoteUrl, const QByteArray &cookieHeader);
    void clear();
    std::optional<ProxyEntry> lookup(const QByteArray &requestTarget) const;
    QNetworkAccessManager *network() const { return m_network; }

private:
    void handleNewConnections();

    QTcpServer *m_server = nullptr;
    QNetworkAccessManager *m_network = nullptr;
    QByteArray m_token;
    QHash<QByteArray, ProxyEntry> m_entries;
    QHash<QString, QByteArray> m_reverse;
    QList<QByteArray> m_insertionOrder;
    QSet<ProxyRequestSession *> m_sessions;
};

class ProxyRequestSession final : public QObject {
public:
    ProxyRequestSession(AuthenticatedHttpProxyWorker *worker, QTcpSocket *socket,
                        QObject *parent);
    ~ProxyRequestSession() override;

private:
    enum class ResumeValidation { Valid, Retriable, Unsafe };

    void readLocalRequest();
    bool parseLocalRequest(const QByteArray &headerBlock);
    void openUpstream(const QByteArray &rangeOverride = {},
                      const QByteArray &ifRange = {}, bool resume = false);
    void processMetadata();
    void sendInitialHeaders();
    ResumeValidation validateResumeResponse(QString *error) const;
    void pumpUpstreamBody();
    void handleUpstreamFinished();
    void maybeFinishUpstream();
    void beginResume(bool delayedRetry, const QString &failure);
    void failTransfer(const QString &message);
    void sendLocalError(int status);
    void finishLocalResponse();
    void cancelAndDelete();
    void releaseReply(bool abort);

    AuthenticatedHttpProxyWorker *m_worker = nullptr;
    QTcpSocket *m_socket = nullptr;
    QNetworkReply *m_reply = nullptr;
    QByteArray m_requestBuffer;
    QByteArray m_method;
    QByteArray m_accept;
    QByteArray m_playerRange;
    ProxyEntry m_entry;
    std::optional<ResponseWindow> m_window;
    QByteArray m_pendingClientData;
    qint64 m_sent = 0;
    int m_resumeAttempts = 0;
    bool m_requestParsed = false;
    bool m_responseStarted = false;
    bool m_replyIsResume = false;
    bool m_resumeValidated = false;
    bool m_replyFinished = false;
    bool m_waitingForResume = false;
    bool m_finished = false;
};

}  // namespace melodex
