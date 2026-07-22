// SPDX-License-Identifier: AGPL-3.0-only
#include "melodex/AuthenticatedHttpProxy.h"

#include <QEventLoop>
#include <QHash>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QSet>
#include <QTcpServer>
#include <QTcpSocket>
#include <QTest>
#include <QTimer>
#include <optional>

namespace {

QByteArray patternedPayload(qsizetype length) {
    QByteArray pattern;
    pattern.reserve(251);
    for (int value = 0; value < 251; ++value)
        pattern.append(static_cast<char>(value));
    QByteArray payload;
    payload.reserve(length);
    while (payload.size() < length)
        payload.append(pattern.left(length - payload.size()));
    return payload;
}

class TruncatedMediaOrigin final : public QObject {
public:
    struct Config {
        QByteArray payload;
        QList<qint64> truncateOffsets;
        bool omitContentLength = false;
        bool chunked = false;
        QSet<int> dropBeforeHeaders;
        QHash<int, int> statusByRequest;
        QHash<int, qint64> startDelta;
        QHash<int, qint64> endDelta;
        QHash<int, qint64> totalDelta;
        QHash<int, QByteArray> etagByRequest;
        QHash<int, QByteArray> modifiedByRequest;
    } config;

    explicit TruncatedMediaOrigin(QObject *parent = nullptr) : QObject(parent) {
        connect(&m_server, &QTcpServer::newConnection, this,
                [this] { acceptConnections(); });
    }

    bool listen() { return m_server.listen(QHostAddress::LocalHost, 0); }
    QUrl url() const {
        return QUrl(QStringLiteral("http://127.0.0.1:%1/track.flac")
                        .arg(m_server.serverPort()));
    }
    QList<QByteArray> ranges;
    QList<QByteArray> ifRanges;
    QList<QByteArray> cookies;

    void resetObservations() {
        ranges.clear();
        ifRanges.clear();
        cookies.clear();
        config.dropBeforeHeaders.clear();
        config.statusByRequest.clear();
        config.startDelta.clear();
        config.endDelta.clear();
        config.totalDelta.clear();
        config.etagByRequest.clear();
        config.modifiedByRequest.clear();
    }

private:
    static QHash<QByteArray, QByteArray> parseHeaders(const QByteArray &block) {
        QHash<QByteArray, QByteArray> headers;
        const QList<QByteArray> lines = block.split('\n');
        for (qsizetype index = 1; index < lines.size(); ++index) {
            const QByteArray line = lines.at(index).trimmed();
            const qsizetype separator = line.indexOf(':');
            if (separator > 0)
                headers.insert(line.left(separator).trimmed().toLower(),
                               line.mid(separator + 1).trimmed());
        }
        return headers;
    }

    QPair<qint64, qint64> requestedWindow(const QByteArray &range) const {
        const qint64 last = config.payload.size() - 1;
        if (range.isEmpty())
            return {0, last};
        const QList<QByteArray> parts = range.mid(6).split('-');
        if (parts.constFirst().isEmpty()) {
            const qint64 suffix = parts.value(1).toLongLong();
            return {qMax<qint64>(0, config.payload.size() - suffix), last};
        }
        const qint64 start = parts.constFirst().toLongLong();
        const qint64 end = parts.value(1).isEmpty()
                               ? last
                               : parts.value(1).toLongLong();
        return {start, end};
    }

    void acceptConnections() {
        while (m_server.hasPendingConnections()) {
            QTcpSocket *socket = m_server.nextPendingConnection();
            auto *buffer = new QByteArray;
            connect(socket, &QTcpSocket::readyRead, socket,
                    [this, socket, buffer] {
                        buffer->append(socket->readAll());
                        const qsizetype end = buffer->indexOf("\r\n\r\n");
                        if (end < 0)
                            return;
                        const QByteArray request = buffer->left(end);
                        buffer->clear();
                        respond(socket, request);
                    });
            connect(socket, &QObject::destroyed, this,
                    [buffer] { delete buffer; });
        }
    }

    void respond(QTcpSocket *socket, const QByteArray &request) {
        const QList<QByteArray> lines = request.split('\n');
        const QList<QByteArray> requestLine = lines.constFirst().trimmed().split(' ');
        const QByteArray method = requestLine.value(0);
        const auto headers = parseHeaders(request);
        const int requestIndex = ranges.size();
        const QByteArray range = headers.value("range");
        ranges.append(range);
        ifRanges.append(headers.value("if-range"));
        cookies.append(headers.value("cookie"));
        if (config.dropBeforeHeaders.contains(requestIndex)) {
            socket->disconnectFromHost();
            return;
        }
        if (const int status = config.statusByRequest.value(requestIndex)) {
            socket->write("HTTP/1.1 " + QByteArray::number(status) +
                          " Retry\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            socket->disconnectFromHost();
            return;
        }

        const auto [start, end] = requestedWindow(range);
        const QByteArray body = config.payload.mid(start, end - start + 1);
        QByteArray response = range.isEmpty() ? "HTTP/1.1 200 OK\r\n"
                                              : "HTTP/1.1 206 Partial Content\r\n";
        response += "Content-Type: audio/flac\r\nAccept-Ranges: bytes\r\n";
        if (config.chunked)
            response += "Transfer-Encoding: chunked\r\n";
        else if (!config.omitContentLength)
            response += "Content-Length: " + QByteArray::number(body.size()) + "\r\n";
        if (!range.isEmpty()) {
            response += "Content-Range: bytes " +
                        QByteArray::number(start + config.startDelta.value(requestIndex)) +
                        "-" +
                        QByteArray::number(end + config.endDelta.value(requestIndex)) +
                        "/" +
                        QByteArray::number(config.payload.size() +
                                           config.totalDelta.value(requestIndex)) +
                        "\r\n";
        }
        if (config.etagByRequest.contains(requestIndex) &&
            !config.etagByRequest.value(requestIndex).isEmpty())
            response += "ETag: " + config.etagByRequest.value(requestIndex) + "\r\n";
        const QByteArray modified = config.modifiedByRequest.contains(requestIndex)
                                        ? config.modifiedByRequest.value(requestIndex)
                                        : QByteArray("Mon, 20 Jul 2026 00:44:57 GMT");
        if (!modified.isEmpty())
            response += "Last-Modified: " + modified + "\r\n";
        response += "Connection: close\r\n\r\n";
        if (method == "HEAD") {
            socket->write(response);
            socket->disconnectFromHost();
            return;
        }

        const std::optional<qint64> truncateAt =
            requestIndex < config.truncateOffsets.size()
                ? std::optional<qint64>(config.truncateOffsets.at(requestIndex))
                : std::nullopt;
        QByteArray actualBody = body;
        bool complete = true;
        if (truncateAt && start < *truncateAt && *truncateAt <= end) {
            actualBody = config.payload.mid(start, *truncateAt - start);
            complete = false;
        }
        if (config.chunked) {
            response += QByteArray::number(body.size(), 16).toUpper() + "\r\n";
            response += actualBody;
            if (complete)
                response += "\r\n0\r\n\r\n";
        } else {
            response += actualBody;
        }
        socket->write(response);
        socket->disconnectFromHost();
    }

    QTcpServer m_server;
};

struct FetchResult {
    QByteArray body;
    int status = 0;
    QNetworkReply::NetworkError error = QNetworkReply::NoError;
    bool timedOut = false;
};

FetchResult fetch(const QUrl &url, const QByteArray &range = {}, bool head = false) {
    QNetworkAccessManager manager;
    QNetworkRequest request(url);
    request.setTransferTimeout(15'000);
    if (!range.isEmpty())
        request.setRawHeader("Range", range);
    QNetworkReply *reply = head ? manager.head(request) : manager.get(request);
    QEventLoop loop;
    QTimer timeout;
    timeout.setSingleShot(true);
    timeout.start(20'000);
    FetchResult result;
    QObject::connect(reply, &QIODevice::readyRead, &loop,
                     [&] { result.body += reply->readAll(); });
    QObject::connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
    QObject::connect(&timeout, &QTimer::timeout, &loop, [&] {
        result.timedOut = true;
        reply->abort();
        loop.quit();
    });
    loop.exec();
    result.body += reply->readAll();
    result.status =
        reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
    result.error = reply->error();
    reply->deleteLater();
    return result;
}

qint64 resumedRangeStart(const QByteArray &range) {
    return range.mid(6).split('-').constFirst().toLongLong();
}

}  // namespace

class PlaybackProxyTest final : public QObject {
    Q_OBJECT

private slots:
    void realFailureResumesWithoutByteGap();
    void rangeVariantsResumeFromAbsoluteOffset();
    void chunkedAndConsecutiveTruncationsRecover();
    void transientResumeFailuresRetry();
    void retryBudgetAndPermanentFailuresStop();
    void unsafeResumeResponsesAreRejected();
    void headCookieLookupAndClearContracts();
};

void PlaybackProxyTest::realFailureResumesWithoutByteGap() {
    TruncatedMediaOrigin origin;
    QVERIFY(origin.listen());
    origin.config.payload = patternedPayload(49'958'397);
    origin.config.truncateOffsets = {31'392'271};
    melodex::AuthenticatedHttpProxy proxy;
    QVERIFY2(proxy.isListening(), qPrintable(proxy.errorString()));
    const FetchResult result = fetch(proxy.registerUrl(origin.url()));
    QVERIFY(!result.timedOut);
    QCOMPARE(result.error, QNetworkReply::NoError);
    QCOMPARE(result.body, origin.config.payload);
    QCOMPARE(origin.ranges.size(), 2);
    QCOMPARE(origin.ranges.constFirst(), QByteArray());
    QVERIFY(origin.ranges.at(1).endsWith("-49958396"));
    QVERIFY(resumedRangeStart(origin.ranges.at(1)) > 0);
    QVERIFY(resumedRangeStart(origin.ranges.at(1)) <= 31'392'271);
}

void PlaybackProxyTest::rangeVariantsResumeFromAbsoluteOffset() {
    TruncatedMediaOrigin origin;
    QVERIFY(origin.listen());
    origin.config.payload = patternedPayload(2'000'000);
    melodex::AuthenticatedHttpProxy proxy;
    const QUrl local = proxy.registerUrl(origin.url());

    origin.config.truncateOffsets = {750'000};
    FetchResult result = fetch(local, "bytes=500000-");
    QCOMPARE(result.error, QNetworkReply::NoError);
    QCOMPARE(result.body, origin.config.payload.mid(500'000));
    QCOMPARE(origin.ranges,
             QList<QByteArray>({"bytes=500000-", "bytes=750000-1999999"}));

    origin.resetObservations();
    origin.config.truncateOffsets = {1'700'000};
    result = fetch(local, "bytes=-500000");
    QCOMPARE(result.error, QNetworkReply::NoError);
    QCOMPARE(result.body, origin.config.payload.mid(1'500'000));
    QCOMPARE(origin.ranges,
             QList<QByteArray>({"bytes=-500000", "bytes=1700000-1999999"}));
}

void PlaybackProxyTest::chunkedAndConsecutiveTruncationsRecover() {
    TruncatedMediaOrigin origin;
    QVERIFY(origin.listen());
    origin.config.payload = patternedPayload(2'000'000);
    origin.config.truncateOffsets = {500'000, 1'250'000};
    melodex::AuthenticatedHttpProxy proxy;
    const QUrl local = proxy.registerUrl(origin.url());
    FetchResult result = fetch(local, "bytes=0-");
    QCOMPARE(result.error, QNetworkReply::NoError);
    QCOMPARE(result.body, origin.config.payload);
    QCOMPARE(origin.ranges.size(), 3);
    QCOMPARE(origin.ranges.constFirst(), QByteArray("bytes=0-"));
    QVERIFY(origin.ranges.at(1).endsWith("-1999999"));
    QVERIFY(origin.ranges.at(2).endsWith("-1999999"));
    const qint64 firstResume = resumedRangeStart(origin.ranges.at(1));
    const qint64 secondResume = resumedRangeStart(origin.ranges.at(2));
    QVERIFY(firstResume > 0);
    QVERIFY(firstResume <= 500'000);
    QVERIFY(secondResume > firstResume);
    QVERIFY(secondResume <= 1'250'000);

    origin.resetObservations();
    origin.config.payload = patternedPayload(3'000'000);
    origin.config.truncateOffsets = {1'200'000};
    origin.config.omitContentLength = true;
    origin.config.chunked = true;
    result = fetch(local, "bytes=0-2999999");
    QCOMPARE(result.error, QNetworkReply::NoError);
    QCOMPARE(result.body, origin.config.payload);
    QCOMPARE(origin.ranges.size(), 2);
    QCOMPARE(origin.ranges.constFirst(), QByteArray("bytes=0-2999999"));
    QVERIFY(origin.ranges.at(1).endsWith("-2999999"));
    QVERIFY(resumedRangeStart(origin.ranges.at(1)) > 0);
    QVERIFY(resumedRangeStart(origin.ranges.at(1)) <= 1'200'000);
}

void PlaybackProxyTest::transientResumeFailuresRetry() {
    const QList<int> statuses{408, 425, 429, 500, 502, 503, 504};
    for (int status : statuses) {
        TruncatedMediaOrigin origin;
        QVERIFY(origin.listen());
        origin.config.payload = patternedPayload(1'000'000);
        origin.config.truncateOffsets = {300'000};
        origin.config.statusByRequest = {{1, status}};
        melodex::AuthenticatedHttpProxy proxy;
        const FetchResult result = fetch(proxy.registerUrl(origin.url()), "bytes=0-");
        QCOMPARE(result.error, QNetworkReply::NoError);
        QCOMPARE(result.body, origin.config.payload);
        QCOMPARE(origin.ranges.size(), 3);
    }

    TruncatedMediaOrigin origin;
    QVERIFY(origin.listen());
    origin.config.payload = patternedPayload(1'000'000);
    origin.config.truncateOffsets = {300'000};
    origin.config.dropBeforeHeaders = {1};
    melodex::AuthenticatedHttpProxy proxy;
    const FetchResult result = fetch(proxy.registerUrl(origin.url()), "bytes=0-");
    QCOMPARE(result.error, QNetworkReply::NoError);
    QCOMPARE(result.body, origin.config.payload);
    QCOMPARE(origin.ranges.size(), 3);
}

void PlaybackProxyTest::retryBudgetAndPermanentFailuresStop() {
    TruncatedMediaOrigin origin;
    QVERIFY(origin.listen());
    origin.config.payload = patternedPayload(1'000'000);
    origin.config.truncateOffsets = {300'000};
    origin.config.statusByRequest = {{1, 503}, {2, 503}, {3, 503}, {4, 503}};
    melodex::AuthenticatedHttpProxy proxy;
    const QUrl local = proxy.registerUrl(origin.url());
    FetchResult result = fetch(local, "bytes=0-");
    QVERIFY(result.error != QNetworkReply::NoError);
    QCOMPARE(origin.ranges.size(), 5);

    origin.resetObservations();
    origin.config.truncateOffsets = {300'000};
    origin.config.statusByRequest = {{1, 416}};
    result = fetch(local, "bytes=0-");
    QVERIFY(result.error != QNetworkReply::NoError);
    QCOMPARE(origin.ranges.size(), 2);

    origin.resetObservations();
    origin.config.dropBeforeHeaders = {0, 1, 2, 3};
    result = fetch(local, "bytes=0-");
    QCOMPARE(result.status, 502);
}

void PlaybackProxyTest::unsafeResumeResponsesAreRejected() {
    const QList<QByteArray> cases{"start", "end", "total", "modified", "etag"};
    for (const QByteArray &testCase : cases) {
        TruncatedMediaOrigin origin;
        QVERIFY(origin.listen());
        origin.config.payload = patternedPayload(1'000'000);
        origin.config.truncateOffsets = {300'000};
        if (testCase == "start")
            origin.config.startDelta = {{1, 1}};
        else if (testCase == "end")
            origin.config.endDelta = {{1, -1}};
        else if (testCase == "total")
            origin.config.totalDelta = {{1, 1}};
        else if (testCase == "modified")
            origin.config.modifiedByRequest =
                {{1, "Tue, 21 Jul 2026 00:44:57 GMT"}};
        else
            origin.config.etagByRequest = {{0, "\"v1\""}, {1, "\"v2\""}};
        melodex::AuthenticatedHttpProxy proxy;
        const FetchResult result = fetch(proxy.registerUrl(origin.url()), "bytes=0-");
        QVERIFY(result.error != QNetworkReply::NoError);
        QCOMPARE(origin.ranges.size(), 2);
        QCOMPARE(origin.ifRanges.at(1),
                 testCase == "etag" ? QByteArray("\"v1\"")
                                    : QByteArray("Mon, 20 Jul 2026 00:44:57 GMT"));
    }
}

void PlaybackProxyTest::headCookieLookupAndClearContracts() {
    TruncatedMediaOrigin origin;
    QVERIFY(origin.listen());
    origin.config.payload = patternedPayload(512'000);
    melodex::AuthenticatedHttpProxy proxy;
    const QUrl first = proxy.registerUrl(origin.url(), "session=secret");
    QCOMPARE(proxy.registerUrl(origin.url(), "session=secret"), first);
    FetchResult result = fetch(first, {}, true);
    QCOMPARE(result.status, 200);
    QCOMPARE(result.error, QNetworkReply::NoError);
    QCOMPARE(origin.cookies, QList<QByteArray>({"session=secret"}));

    QUrl unknown = first;
    unknown.setPath(unknown.path() + QStringLiteral("-unknown"));
    result = fetch(unknown);
    QCOMPARE(result.status, 404);
    proxy.clear();
    result = fetch(first);
    QCOMPARE(result.status, 404);

    QUrl oldestRemote = origin.url();
    oldestRemote.setQuery(QStringLiteral("entry=0"));
    const QUrl oldestLocal = proxy.registerUrl(oldestRemote);
    for (int index = 1; index <= 256; ++index) {
        QUrl remote = origin.url();
        remote.setQuery(QStringLiteral("entry=%1").arg(index));
        QVERIFY(!proxy.registerUrl(remote).isEmpty());
    }
    result = fetch(oldestLocal);
    QCOMPARE(result.status, 404);
}

QTEST_GUILESS_MAIN(PlaybackProxyTest)

#include "test_playback_proxy.moc"
