// SPDX-License-Identifier: AGPL-3.0-only
#include "melodex/ApiClient.h"
#include "melodex/ApplicationConfig.h"
#include "melodex/JsonUtils.h"
#include "melodex/Lyrics.h"
#include "melodex/PlaybackStateStore.h"
#include "melodex/UserSettings.h"

#include <QTemporaryDir>
#include <QTest>
#include <stdexcept>

class DesktopContractsTest final : public QObject {
    Q_OBJECT

private slots:
    void applicationConfigLoadsPackagedContract();
    void serviceUrlRejectsUnsafeOrigins();
    void playbackUrlStaysOnAuthenticatedOrigin();
    void realSongMetadataNormalizesForRequests();
    void lyricsSupportWordAndLineTiming();
    void playbackStateIsAccountScoped();
};

void DesktopContractsTest::applicationConfigLoadsPackagedContract() {
    const melodex::ApplicationConfig config =
        melodex::loadApplicationConfig(QStringLiteral(":/Melodex/app_config.json"));
    QCOMPARE(config.applicationName, QStringLiteral("Melodex"));
    QCOMPARE(config.applicationId, QStringLiteral("PrismQML.Melodex"));
    QVERIFY(config.window.minimumWidth > 0);
}

void DesktopContractsTest::serviceUrlRejectsUnsafeOrigins() {
    QCOMPARE(melodex::normalizeServiceUrl(QStringLiteral("music.example.test")),
             QStringLiteral("https://music.example.test/"));
    QCOMPARE(melodex::normalizeServiceUrl(QStringLiteral("http://127.0.0.1:8329/api")),
             QStringLiteral("http://127.0.0.1:8329/"));
    QVERIFY_THROWS_EXCEPTION(
        std::invalid_argument,
        melodex::normalizeServiceUrl(QStringLiteral("http://music.example.test")));
    QVERIFY_THROWS_EXCEPTION(
        std::invalid_argument,
        melodex::normalizeServiceUrl(QStringLiteral("https://user:pass@example.test")));
}

void DesktopContractsTest::playbackUrlStaysOnAuthenticatedOrigin() {
    const QUrl url = melodex::resolvePlaybackUrl(
        QStringLiteral("https://music.example.test/"),
        QStringLiteral("/music/playback/2140404278?ticket=signed"));
    QCOMPARE(url.host(), QStringLiteral("music.example.test"));
    QCOMPARE(url.path(), QStringLiteral("/music/playback/2140404278"));
    QVERIFY_THROWS_EXCEPTION(
        std::invalid_argument,
        melodex::resolvePlaybackUrl(QStringLiteral("https://music.example.test/"),
                                    QStringLiteral("https://evil.example/audio.mp3")));
}

void DesktopContractsTest::realSongMetadataNormalizesForRequests() {
    const QVariantMap song = {
        {QStringLiteral("ID"), QStringLiteral("2140404278")},
        {QStringLiteral("Source"), QStringLiteral("NETEASE")},
        {QStringLiteral("Name"), QStringLiteral("海棠又落微雨时")},
        {QStringLiteral("Artist"), QStringLiteral("" )},
        {QStringLiteral("Duration"), 245.5},
    };
    const QVariantMap normalized = melodex::normalizeSong(song);
    QCOMPARE(normalized.value(QStringLiteral("id")).toString(),
             QStringLiteral("2140404278"));
    QCOMPARE(normalized.value(QStringLiteral("source")).toString(),
             QStringLiteral("netease"));
    QCOMPARE(melodex::songKey(normalized), QStringLiteral("netease:2140404278"));
    QVERIFY(melodex::encodedQuery(melodex::songQuery(normalized))
                .contains(QStringLiteral("id=2140404278")));
}

void DesktopContractsTest::lyricsSupportWordAndLineTiming() {
    const QVariantList lines = melodex::parseLrc(
        QStringLiteral("[00:00.00]海[00:00.50]棠\n[00:01.00]又落微雨时"));
    QCOMPARE(lines.size(), 2);
    QCOMPARE(lines.constFirst().toMap().value(QStringLiteral("text")).toString(),
             QStringLiteral("海棠"));
    QCOMPARE(lines.constFirst().toMap().value(QStringLiteral("words")).toList().size(), 2);
    QCOMPARE(melodex::currentLyricIndex(lines, 1.2), 1);
    QVERIFY(melodex::lyricProgress(lines, 0, 0.75) > 0.5);
}

void DesktopContractsTest::playbackStateIsAccountScoped() {
    QTemporaryDir directory;
    QVERIFY(directory.isValid());
    melodex::PlaybackStateStore store(directory.filePath(QStringLiteral("playback.json")));
    const QVariantMap state = {
        {QStringLiteral("position"), 42.5},
        {QStringLiteral("song"), QVariantMap{{QStringLiteral("id"),
                                               QStringLiteral("2140404278")}}},
    };
    QVERIFY(store.save(QStringLiteral("https://music.example.test/"),
                       QStringLiteral("alice"), state));
    QVERIFY(store.load(QStringLiteral("https://music.example.test/"),
                       QStringLiteral("alice")).has_value());
    QVERIFY(!store.load(QStringLiteral("https://music.example.test/"),
                        QStringLiteral("bob")).has_value());
}

QTEST_GUILESS_MAIN(DesktopContractsTest)

#include "test_contracts.moc"
